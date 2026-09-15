import { randomInt } from 'node:crypto';
import { createSocket } from 'node:dgram';
import { connect, isIP } from 'node:net';
import packet from 'dns-packet';
import { normalize, normalizeHostname, type RecordType, type RecordValue } from './records.js';

export interface ResolverConfig { id: string; server: string; port?: number; protocol: 'UDP' | 'TCP' }
export type QueryStatus = 'SUCCESS' | 'NODATA' | 'NXDOMAIN' | 'SERVFAIL' | 'REFUSED' | 'TIMEOUT' | 'ERROR';
export interface QueryResult {
  resolverId: string;
  status: QueryStatus;
  answers: RecordValue[];
  latencyMs: number;
  queriedAt: string;
  rcode?: string;
  error?: string;
}
export interface QueryInput { hostname: string; type: RecordType; resolver: ResolverConfig; timeoutMs: number; signal?: AbortSignal }

function exchange(bytes: Buffer, resolver: ResolverConfig, tcp: boolean, timeout: number, signal?: AbortSignal): Promise<Buffer> {
  if (signal?.aborted) return Promise.reject(new Error('ABORTED'));
  return new Promise((resolve, reject) => {
    const socket = tcp ? connect({ host: resolver.server, port: resolver.port ?? 53 })
      : createSocket(isIP(resolver.server) === 6 ? 'udp6' : 'udp4');
    let done = false;
    const finish = (error?: Error, data?: Buffer) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if ('destroy' in socket) socket.destroy(); else socket.close();
      if (error) reject(error); else resolve(data!);
    };
    const timer = setTimeout(() => finish(new Error('TIMEOUT')), timeout);
    const abort = () => finish(new Error('ABORTED'));
    signal?.addEventListener('abort', abort, { once: true });
    socket.once('error', error => finish(error));
    if ('write' in socket) {
      let received = Buffer.alloc(0);
      socket.once('connect', () => {
        const prefix = Buffer.alloc(2);
        prefix.writeUInt16BE(bytes.length);
        socket.write(Buffer.concat([prefix, bytes]));
      });
      socket.on('data', (data: Buffer) => {
        received = Buffer.concat([received, data]);
        if (received.length >= 2 && received.length >= received.readUInt16BE(0) + 2) {
          finish(undefined, received.subarray(2, received.readUInt16BE(0) + 2));
        }
      });
      socket.once('end', () => finish(new Error('Incomplete DNS response')));
    } else {
      socket.on('message', data => {
        // Connected UDP filters the peer; transaction ID filters unrelated packets.
        if (data.length >= 2 && data.readUInt16BE(0) === bytes.readUInt16BE(0)) finish(undefined, data);
      });
      socket.connect(resolver.port ?? 53, resolver.server, () => { if (!done) socket.send(bytes); });
    }
  });
}

export async function query(input: QueryInput): Promise<QueryResult> {
  const hostname = normalizeHostname(input.hostname);
  if (!isIP(input.resolver.server)) throw new Error('Resolver server must be an IP address');
  if (!Number.isInteger(input.timeoutMs) || input.timeoutMs < 1 || input.timeoutMs > 60000) throw new Error('Invalid timeout');
  if (input.resolver.port !== undefined && (!Number.isInteger(input.resolver.port) || input.resolver.port < 1 || input.resolver.port > 65535)) throw new Error('Invalid resolver port');
  const start = performance.now();
  const base = { resolverId: input.resolver.id, queriedAt: new Date().toISOString() };
  const result = (status: QueryStatus, answers: RecordValue[] = [], extra = {}): QueryResult =>
    ({ ...base, status, answers, latencyMs: Math.round(performance.now() - start), ...extra });
  const id = randomInt(65536);
  const bytes = packet.encode({ type: 'query', id, flags: packet.RECURSION_DESIRED, questions: [{ name: hostname, type: input.type }] });
  try {
    let response = packet.decode(await exchange(bytes, input.resolver, input.resolver.protocol === 'TCP', input.timeoutMs, input.signal));
    if (response.flag_tc && input.resolver.protocol === 'UDP') {
      const remaining = input.timeoutMs - (performance.now() - start);
      if (remaining <= 0) return result('TIMEOUT');
      response = packet.decode(await exchange(bytes, input.resolver, true, remaining, input.signal));
    }
    const question = response.questions?.[0];
    if (response.id !== id || response.type !== 'response' || response.flag_tc || !question
      || normalizeHostname(question.name) !== hostname || question.type !== input.type) {
      return result('ERROR', [], { error: 'Invalid DNS response' });
    }
    const rcode = ({ 0: 'NOERROR', 1: 'FORMERR', 2: 'SERVFAIL', 3: 'NXDOMAIN', 4: 'NOTIMP', 5: 'REFUSED' } as Record<number, string>)[(response.flags ?? 0) & 15] ?? 'UNKNOWN';
    if (rcode !== 'NOERROR') {
      const status = ['NXDOMAIN', 'SERVFAIL', 'REFUSED'].includes(rcode ?? '') ? rcode as QueryStatus : 'ERROR';
      return result(status, [], { rcode: rcode });
    }
    // Only accept answer owners reachable from the requested name through CNAMEs.
    const records = response.answers ?? [];
    const owners = new Set([hostname]);
    for (let i = 0; i < records.length; i++) {
      let added = false;
      for (const record of records) {
        if (record.type === 'CNAME' && owners.has(normalizeHostname(record.name))) {
          const target = normalizeHostname(record.data);
          if (!owners.has(target)) { owners.add(target); added = true; }
        }
      }
      if (!added) break;
    }
    const values = records.filter(record => record.type === input.type &&
      (input.type === 'CNAME' ? normalizeHostname(record.name) === hostname : owners.has(normalizeHostname(record.name))))
      .map(record => {
        if (record.type === 'MX') return { priority: record.data.preference, host: record.data.exchange };
        if (record.type === 'TXT') {
          const chunks = Array.isArray(record.data) ? record.data : [record.data];
          // latin1 is a reversible byte-to-string mapping, including non-UTF8 TXT data.
          return Buffer.concat(chunks.map(chunk => Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))).toString('latin1');
        }
        if ('data' in record) return record.data;
        throw new Error('Unexpected DNS record');
      });
    const answers = normalize(input.type, values);
    return result(answers.length ? 'SUCCESS' : 'NODATA', answers, { rcode: rcode });
  } catch (error) {
    return result(error instanceof Error && error.message === 'TIMEOUT' ? 'TIMEOUT' : 'ERROR', [],
      { error: error instanceof Error ? error.message : 'DNS query failed' });
  }
}
