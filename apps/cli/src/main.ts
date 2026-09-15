import { query } from '../../../packages/dns-engine/src/query.js';
import { recordTypes, type RecordType } from '../../../packages/dns-engine/src/records.js';

const [hostname, type = 'A', server = '1.1.1.1', protocol = 'UDP', timeout = '3000'] = process.argv.slice(2);
if (!hostname || !recordTypes.includes(type as RecordType) || !['UDP', 'TCP'].includes(protocol)) {
  console.error('Usage: pnpm query <hostname> [A|AAAA|CNAME|MX|TXT] [resolver IP] [UDP|TCP] [timeout ms]');
  process.exitCode = 2;
} else {
  try {
    const result = await query({ hostname, type: type as RecordType, resolver: { id: server, server, protocol: protocol as 'UDP' | 'TCP' }, timeoutMs: Number(timeout) });
    console.log(JSON.stringify(result, null, 2));
    if (result.status !== 'SUCCESS') process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 2;
  }
}
