import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { domainToASCII } from 'node:url';

export const recordTypes = ['A', 'AAAA', 'CNAME', 'MX', 'TXT'] as const;
export type RecordType = typeof recordTypes[number];
export type RecordValue = string | { priority: number; host: string };

export function normalizeHostname(input: string): string {
  const name = domainToASCII(input.replace(/\.$/, '')).toLowerCase();
  if (!name || name.length > 253 || name.split('.').some(label =>
    !label || label.length > 63 || !/^[a-z0-9_](?:[a-z0-9_-]*[a-z0-9_])?$/.test(label))) {
    throw new Error('Invalid DNS hostname');
  }
  return name;
}

export function normalize(type: RecordType, values: unknown[]): RecordValue[] {
  const normalized = values.map((value): RecordValue => {
    switch (type) {
      case 'A':
      case 'AAAA': {
        if (typeof value !== 'string' || isIP(value) !== (type === 'A' ? 4 : 6)) {
          throw new Error(`Invalid ${type} address`);
        }
        return type === 'AAAA' ? new URL(`http://[${value}]/`).hostname.slice(1, -1) : value;
      }
      case 'CNAME':
        if (typeof value !== 'string') throw new Error('Invalid CNAME');
        return normalizeHostname(value);
      case 'MX': {
        if (!value || typeof value !== 'object' || !('priority' in value) || !('host' in value)
          || typeof value.priority !== 'number' || !Number.isInteger(value.priority)
          || value.priority < 0 || value.priority > 65535 || typeof value.host !== 'string') {
          throw new Error('Invalid MX record');
        }
        return { priority: value.priority, host: value.host === '.' ? '.' : normalizeHostname(value.host) };
      }
      case 'TXT':
        if (typeof value !== 'string') throw new Error('Invalid TXT record');
        return value; // Preserve whitespace and case; TXT is not a domain name.
    }
  });
  return [...new Map(normalized.map(value => [JSON.stringify(value), value])).entries()]
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, value]) => value);
}

export function hash(values: RecordValue[]): string {
  return createHash('sha256').update(JSON.stringify(values)).digest('hex');
}

export function matches(actual: RecordValue[], expected: RecordValue[], match: 'EXACT' | 'CONTAINS'): boolean {
  if (match === 'EXACT') return hash(actual) === hash(expected);
  const set = new Set(actual.map(value => JSON.stringify(value)));
  return expected.every(value => set.has(JSON.stringify(value)));
}
