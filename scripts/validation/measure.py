#!/usr/bin/env python3
"""Sample only the disposable validation stack; run after its seed command."""
import argparse, datetime, json, pathlib, subprocess, time
parser = argparse.ArgumentParser()
parser.add_argument('--seconds', type=int, default=660)
parser.add_argument('--output', required=True)
args = parser.parse_args()
if args.seconds < 600: parser.error('At least two real five-minute intervals are required')
compose = ['docker', 'compose', '-p', 'dnsmonitor-validation', '-f', 'deploy/compose.validation.yaml']
def command(*cmd): return subprocess.check_output(cmd, text=True).strip()
def report(): return json.loads(command(*compose, 'exec', '-T', 'app', 'node', 'scripts/validation/probe.mjs', 'report'))
def mib(value):
 # Docker renders 87.3MiB without a separating space.
 import re
 match = re.fullmatch(r'([0-9.]+)([A-Za-z]+)', value.strip())
 if not match: raise ValueError(f'Unexpected Docker memory value: {value}')
 number, unit = match.groups()
 return float(number) * {'B':1/1048576,'KiB':1/1024,'MiB':1,'GiB':1024}[unit]
initial = report(); samples = []; start = time.monotonic()
disk_before=int(command('docker','exec','dnsmonitor-validation-mariadb-1','du','-sk','/var/lib/mysql').split()[0])*1024
while time.monotonic() - start < args.seconds:
 rows = [json.loads(line) for line in command('docker','stats','--no-stream','--format','{{json .}}','dnsmonitor-validation-app-1','dnsmonitor-validation-mariadb-1').splitlines()]
 samples.append({'seconds':round(time.monotonic()-start,2),'containers':[{'name':r['Name'],'memoryMiB':mib(r['MemUsage'].split('/')[0]),'cpuPercent':float(r['CPUPerc'].rstrip('%'))} for r in rows]})
 print(f"Sample {len(samples)} at {samples[-1]['seconds']} seconds", flush=True)
 time.sleep(min(13, max(0,args.seconds-(time.monotonic()-start))))
final = report()
finished = [c for c in final['checks'] if c['status']=='COMPLETED']
by_monitor = {}
for c in finished: by_monitor[c['monitor_id']] = by_monitor.get(c['monitor_id'],0)+1
latencies = sorted(float(c['lateness_ms']) for c in finished)
def percentile(xs,p): return xs[min(len(xs)-1,int((len(xs)-1)*p))] if xs else None
summary = {'durationSeconds':round(time.monotonic()-start,2),'completedChecks':len(finished),'minChecksPerMonitor':min(by_monitor.values()) if by_monitor else 0,'monitorsChecked':len(by_monitor),'latenessMs':{'p50':percentile(latencies,.5),'p95':percentile(latencies,.95),'max':max(latencies,default=0)},'peakCombinedMemoryMiB':max(sum(c['memoryMiB'] for c in s['containers']) for s in samples),'meanCombinedCpuPercent':sum(sum(c['cpuPercent'] for c in s['containers']) for s in samples)/len(samples),'peakCombinedCpuPercent':max(sum(c['cpuPercent'] for c in s['containers']) for s in samples),'databaseBytesBefore':initial['databaseBytes'],'databaseBytesAfter':final['databaseBytes']}
summary['databaseDiskBytesBefore']=disk_before
summary['databaseDiskBytesAfter']=int(command('docker','exec','dnsmonitor-validation-mariadb-1','du','-sk','/var/lib/mysql').split()[0])*1024
for service in ['app','mariadb']:
 state=json.loads(command('docker','inspect','dnsmonitor-validation-'+service+'-1'))[0]
 peak=int(command('docker','exec','dnsmonitor-validation-'+service+'-1','cat','/sys/fs/cgroup/memory.peak'))
 summary[service]={'cgroupPeakMemoryBytes':peak,'oomKilled':state['State']['OOMKilled'],'restarts':state['RestartCount'],'memoryLimitBytes':state['HostConfig']['Memory'],'nanoCpus':state['HostConfig']['NanoCpus']}
result={'imageId':command('docker','inspect','--format','{{.Image}}','dnsmonitor-validation-app-1'),'dockerVmMemoryBytes':int(command('docker','info','--format','{{.MemTotal}}')),'dockerVmCpus':int(command('docker','info','--format','{{.NCPU}}')),'docker':json.loads(command('docker','info','--format','{{json .}}'))['ServerVersion'],'architecture':command('docker','info','--format','{{.Architecture}}'),'recordedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'summary':summary,'samples':samples,'initial':initial,'final':final}
path=pathlib.Path(args.output);path.parent.mkdir(parents=True,exist_ok=True);path.write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps(summary,indent=2))
assert len(by_monitor)==25 and min(by_monitor.values())>=2, 'Not all monitors completed two scheduled checks'
assert all(c['status']=='COMPLETED' for c in final['checks']), 'Unexpected unfinished/failed run'
assert all(c['successfulResolvers']==3 for c in final['checks']), 'Resolver failures during baseline'
assert final['states']==['HEALTHY']*25, 'Not all monitors reached healthy state'
assert max(latencies)<5000, 'A scheduled check started more than five seconds late'
assert not any(summary[s]['oomKilled'] or summary[s]['restarts'] for s in ['app','mariadb'])
