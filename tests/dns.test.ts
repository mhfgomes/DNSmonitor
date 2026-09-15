import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSocket } from 'node:dgram';
import { createServer, type AddressInfo } from 'node:net';
import packet from 'dns-packet';
import { query } from '../packages/dns-engine/src/query.js';

test('local DNS fixture: UDP, TCP fallback, errors, TXT chunks and timeout', async t => {
  const udp = createSocket('udp4');
  const tcp = createServer(socket => {
    let bytes = Buffer.alloc(0);
    socket.on('data', data => {
      bytes = Buffer.concat([bytes, data]);
      if (bytes.length < 2 || bytes.length < bytes.readUInt16BE(0) + 2) return;
      const request = packet.decode(bytes.subarray(2));
      const response = packet.encode({ ...request, type: 'response', flags: 0, answers: [{ name: 'example.test', type: 'A', ttl: 300, data: '192.0.2.5' }] });
      const length = Buffer.alloc(2); length.writeUInt16BE(response.length);
      socket.end(Buffer.concat([length, response]));
    });
  });
  let mode = 'A';
  udp.on('message', (bytes, remote) => {
    if (mode === 'TIMEOUT') return;
    const request = packet.decode(bytes);
    const answers: packet.Answer[] = mode === 'TXT' ? [{ name: 'example.test', type: 'TXT', ttl: 1, data: [Buffer.from('Keep '), Buffer.from('Case')] }]
      : mode === 'A' ? [{ name: 'example.test', type: 'A', ttl: 100, data: '192.0.2.1' }] : [];
    const response = packet.encode({ ...request, type: 'response', flags: mode === 'TRUNCATED' ? packet.TRUNCATED_RESPONSE : mode === 'NXDOMAIN' ? 3 : mode === 'SERVFAIL' ? 2 : 0, answers });
    udp.send(response, remote.port, remote.address);
  });
  t.after(() => { udp.close(); tcp.close(); });
  await new Promise<void>((resolve, reject) => { udp.once('error', reject); udp.bind(0, '127.0.0.1', resolve); });
  const port = (udp.address() as AddressInfo).port;
  await new Promise<void>((resolve, reject) => { tcp.once('error', reject); tcp.listen(port, '127.0.0.1', resolve); });
  const input = { hostname: 'example.test', type: 'A' as const, resolver: { id: 'fixture', server: '127.0.0.1', port, protocol: 'UDP' as const }, timeoutMs: 200 };
  assert.deepEqual((await query(input)).answers, ['192.0.2.1']);
  mode = 'TRUNCATED';
  assert.deepEqual((await query(input)).answers, ['192.0.2.5']);
  assert.deepEqual((await query({ ...input, resolver: { ...input.resolver, protocol: 'TCP' } })).answers, ['192.0.2.5']);
  mode = 'TXT';
  assert.deepEqual((await query({ ...input, type: 'TXT' })).answers, ['Keep Case']);
  for (const status of ['NXDOMAIN', 'SERVFAIL', 'NODATA', 'TIMEOUT']) {
    mode = status;
    assert.equal((await query(input)).status, status);
  }
  const abort = new AbortController();
  const pending = query({ ...input, timeoutMs: 5000, signal: abort.signal });
  abort.abort();
  const aborted = await pending;
  assert.equal(aborted.status, 'ERROR');
  assert.equal(aborted.error, 'ABORTED');
  assert.ok(aborted.latencyMs < 1000);
  assert.equal((await query({ ...input, signal: abort.signal })).error, 'ABORTED');
});
