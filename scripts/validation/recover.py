#!/usr/bin/env python3
"""Fault and restore drills against the fixed, disposable validation project."""
import argparse, json, pathlib, subprocess, tempfile, time
parser=argparse.ArgumentParser();parser.add_argument('--output',required=True);args=parser.parse_args()
base=['docker','compose','-p','dnsmonitor-validation','-f','deploy/compose.validation.yaml']; stack=base
result={}
def run(*args, **kwargs):
 return subprocess.check_output(args,text=True,**kwargs).strip()
def probe(command='report', standalone=False):
 mode=['run','--rm','--no-deps'] if standalone else ['exec','-T']
 return json.loads(run(*stack,*mode,'app','node','scripts/validation/probe.mjs',command))
def until(fn,timeout=90):
 end=time.monotonic()+timeout
 while time.monotonic()<end:
  value=fn()
  if value:return value
  time.sleep(.3)
 raise AssertionError('Recovery condition timed out')
def control(query):
 return json.loads(run(*base,'exec','-T','fixture','node','-e',f"fetch('http://localhost:8080/{query}',{{method:'POST'}}).then(async r=>console.log(await r.text()))"))
def healthy():
 return all(json.loads(run('docker','inspect','dnsmonitor-validation-'+service+'-1'))[0]['State'].get('Health',{}).get('Status')=='healthy' for service in ['app','mariadb'])
def completed():return sum(c['status']=='COMPLETED' for c in probe()['checks'])
def round_checks():
 before={c['id'] for c in probe()['checks'] if c['status']=='COMPLETED'};probe('due')
 until(lambda:len({c['monitor_id'] for c in probe()['checks'] if c['id'] not in before and c['status']=='COMPLETED'})==25)
def events():return {row['type']:row['n'] for row in probe()['events']}
assert probe()['counts']['monitors']==25
print('Testing a complete round with all three resolvers timing out',flush=True)
control('?drop=true');started=time.monotonic();round_checks();result['allResolversTimeoutRoundSeconds']=round(time.monotonic()-started,2)
control('?drop=false');round_checks();round_checks()
print('Testing process death with active DNS requests',flush=True)
control('?drop=true');probe('due');until(lambda:any(c['status']=='RUNNING' for c in probe()['checks']))
run(*base,'kill','-s','SIGKILL','app');control('?drop=false');started=time.monotonic();run(*base,'start','app');until(healthy)
until(lambda:not any(c['status']=='RUNNING' for c in probe()['checks']))
# Wait for all 25 forced checks, including reclaimed leases, to leave the due queue.
round_checks()
result['workerRecoverySeconds']=round(time.monotonic()-started,2)
result['abandonedRuns']=sum(c['status']=='ABANDONED' for c in probe()['checks'])
assert result['abandonedRuns']>=1, 'Kill did not exercise an active lease'
# Establish both modes' healthy state, then change every answer.
round_checks();baseline=events();control('?address=192.0.2.2');round_checks();round_checks()
after=events();assert after.get('INCIDENT_OPENED',0)-baseline.get('INCIDENT_OPENED',0)==12
assert after.get('VALUE_CHANGED',0)-baseline.get('VALUE_CHANGED',0)==13
print('Testing database restart with active DNS requests',flush=True)
control('?drop=true');probe('due');until(lambda:any(c['status']=='RUNNING' for c in probe()['checks']))
started=time.monotonic();run(*base,'restart','mariadb');control('?drop=false');until(healthy);round_checks()
result['databaseRecoverySeconds']=round(time.monotonic()-started,2)
assert events().get('INCIDENT_OPENED',0)==after.get('INCIDENT_OPENED',0), 'Restart duplicated incident-open events'
control('?address=192.0.2.1');round_checks();round_checks();final=events()
assert final.get('INCIDENT_RESOLVED',0)-baseline.get('INCIDENT_RESOLVED',0)==12
assert final.get('VALUE_CHANGED',0)-baseline.get('VALUE_CHANGED',0)==26
result['transitionDeltas']={key:final.get(key,0)-baseline.get(key,0) for key in final}
# All events must have reached the local endpoint before the backup.
expected=sum(final.get(key,0) for key in ['VALUE_CHANGED','INCIDENT_OPENED','INCIDENT_RESOLVED']);until(lambda:control('')['deliveries']>=expected)
print('Backing up stopped application data and restoring into a new volume',flush=True)
run(*base,'stop','app');before=probe('snapshot',standalone=True)
with tempfile.TemporaryDirectory(prefix='dnsmonitor-restore-') as directory:
 dump=pathlib.Path(directory)/'database.sql'
 with dump.open('w') as output:
  subprocess.run([*base,'exec','-T','mariadb','sh','-c','export MYSQL_PWD="$MARIADB_ROOT_PASSWORD"; exec mariadb-dump --user=root --single-transaction --routines --events "$MARIADB_DATABASE"'],stdout=output,check=True)
 result['backupBytes']=dump.stat().st_size
 run(*base,'stop','mariadb');run(*base,'rm','-f','mariadb')
 stack=base+['-f','deploy/compose.validation-restore.yaml']
 run(*stack,'up','-d','--wait','mariadb')
 with dump.open() as source:
  subprocess.run([*stack,'exec','-T','mariadb','sh','-c','export MYSQL_PWD="$MARIADB_ROOT_PASSWORD"; exec mariadb --user=root "$MARIADB_DATABASE"'],stdin=source,check=True)
 restored=probe('snapshot',standalone=True)
 assert before==restored,'Restored table hashes differ from the source'
 result['restoredTables']=restored
 run(*stack,'up','-d','--wait','app')
 probe('verify-restore')
 result['restoredLoginAndEncryptedChannel']=True
 before_delivery=control('')['deliveries']
 wrong=subprocess.run([*stack,'exec','-T','-e','ENCRYPTION_KEY='+'b'*64,'app','node','scripts/validation/probe.mjs','verify-restore'],stdout=subprocess.DEVNULL,stderr=subprocess.PIPE,text=True)
 assert wrong.returncode!=0 and ('authenticate' in wrong.stderr or 'decrypt' in wrong.stderr), 'Wrong-key decryption should fail'
 assert control('')['deliveries']==before_delivery
 result['wrongEncryptionKeyRejected']=True
 round_checks();result['checksAfterRestore']=completed()
 result['memoryEvents']={}
 for service in ['app','mariadb']:
  values=dict(line.split() for line in run('docker','exec','dnsmonitor-validation-'+service+'-1','cat','/sys/fs/cgroup/memory.events').splitlines())
  result['memoryEvents'][service]={key:int(value) for key,value in values.items()}
  assert int(values['oom_kill'])==0, 'OOM kill occurred during recovery'
path=pathlib.Path(args.output);path.parent.mkdir(parents=True,exist_ok=True);path.write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps(result,indent=2))
