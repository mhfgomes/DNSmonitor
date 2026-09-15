import { hash, matches, normalize, normalizeHostname, recordTypes, type RecordType, type RecordValue } from '../../dns-engine/src/records.js';
import type { QueryResult } from '../../dns-engine/src/query.js';

interface CommonConfig {
  hostname: string;
  recordType: RecordType;
  intervalSeconds: number;
  timeoutMs: number;
  failureThreshold: number;
  recoveryThreshold: number;
  changeThreshold: number;
  resolverIds: string[];
}
export type MonitorConfig = CommonConfig & (
  { mode: 'WATCH' } |
  { mode: 'EXPECTED'; expected: RecordValue[]; match: 'EXACT' | 'CONTAINS' }
);
export interface MonitorState {
  status: 'UNKNOWN' | 'HEALTHY' | 'WARNING' | 'CRITICAL';
  failures: number;
  successes: number;
  incidentOpen: boolean;
  baseline?: RecordValue[];
  candidate?: RecordValue[];
  candidateCount: number;
  lastCheckedAt?: string;
}
export interface MonitorEvent {
  type: 'BASELINE_ESTABLISHED' | 'VALUE_CHANGED' | 'INCIDENT_OPENED' | 'INCIDENT_RESOLVED';
  reason?: string;
  oldValue?: RecordValue[];
  newValue?: RecordValue[];
}
export const initialState = (): MonitorState => ({ status: 'UNKNOWN', failures: 0, successes: 0, incidentOpen: false, candidateCount: 0 });

export function validateConfig(config: MonitorConfig): MonitorConfig {
  if (!config || typeof config !== 'object') throw new Error('Invalid monitor configuration');
  if (typeof config.hostname !== 'string' || !recordTypes.includes(config.recordType)) throw new Error('Invalid hostname or record type');
  if (!['WATCH', 'EXPECTED'].includes(config.mode)) throw new Error('Invalid monitor mode');
  normalizeHostname(config.hostname);
  const ranges = { intervalSeconds: [1, 604800], timeoutMs: [1, 60000], failureThreshold: [1, 1000], recoveryThreshold: [1, 1000], changeThreshold: [1, 1000] } as const;
  for (const key of Object.keys(ranges) as (keyof typeof ranges)[]) {
    const [min, max] = ranges[key];
    if (!Number.isInteger(config[key]) || config[key] < min || config[key] > max) throw new Error(`Invalid ${key}`);
  }
  if (!Array.isArray(config.resolverIds) || !config.resolverIds.length || config.resolverIds.length > 16 || config.resolverIds.some(id => typeof id !== 'string' || !id || id.length > 100) || new Set(config.resolverIds).size !== config.resolverIds.length) throw new Error('Use 1–16 nonempty unique resolver IDs');
  if (config.mode === 'EXPECTED') {
    if (!['EXACT', 'CONTAINS'].includes(config.match)) throw new Error('Invalid matching policy');
    if (!Array.isArray(config.expected) || !config.expected.length) throw new Error('EXPECTED requires at least one record');
    normalize(config.recordType, config.expected);
  }
  return config;
}

/** Missing, failing, or dissenting resolvers count against a strict majority of configured resolvers. */
export function consensus(config: MonitorConfig, results: QueryResult[]): { value?: RecordValue[]; degraded: boolean; reason: string } {
  const byResolver = new Map<string, QueryResult>();
  for (const result of results) {
    if (!config.resolverIds.includes(result.resolverId) || byResolver.has(result.resolverId)) throw new Error('Unexpected or duplicate resolver result');
    byResolver.set(result.resolverId, result);
  }
  const groups = new Map<string, { value: RecordValue[]; count: number }>();
  for (const result of byResolver.values()) {
    if (result.status !== 'SUCCESS' || !result.answers.length) continue;
    const value = normalize(config.recordType, result.answers);
    const key = hash(value);
    const group = groups.get(key) ?? { value, count: 0 };
    group.count++;
    groups.set(key, group);
  }
  const winner = [...groups.values()].find(group => group.count > config.resolverIds.length / 2);
  return winner ? { value: winner.value, degraded: winner.count !== config.resolverIds.length, reason: 'RESOLVER_DISAGREEMENT' }
    : { degraded: true, reason: 'NO_QUORUM' };
}

/** Pure transition: the persistence layer must commit state, events, and alert jobs atomically. */
export function evaluate(config: MonitorConfig, previous: MonitorState, results: QueryResult[], checkedAt: Date) {
  validateConfig(config);
  if (!Number.isFinite(checkedAt.getTime())) throw new Error('Invalid check time');
  if (previous.lastCheckedAt && checkedAt.getTime() <= Date.parse(previous.lastCheckedAt)) throw new Error('Check is not newer than current state');
  const state: MonitorState = structuredClone(previous);
  const events: MonitorEvent[] = [];
  const observation = consensus(config, results);
  const value = observation.value;
  const failed = !value || (config.mode === 'EXPECTED' && !matches(value, normalize(config.recordType, config.expected), config.match));
  if (failed) {
    state.failures = Math.min(state.failures + 1, config.failureThreshold);
    state.successes = 0;
    state.candidate = undefined;
    state.candidateCount = 0;
    if (!state.incidentOpen && state.failures >= config.failureThreshold) {
      state.incidentOpen = true;
      events.push({ type: 'INCIDENT_OPENED', reason: value ? 'VALUE_MISMATCH' : observation.reason, newValue: value });
    }
    state.status = state.incidentOpen ? 'CRITICAL' : 'WARNING';
  } else {
    state.failures = 0;
    state.successes = Math.min(state.successes + 1, config.recoveryThreshold);
    if (state.incidentOpen && state.successes >= config.recoveryThreshold) {
      state.incidentOpen = false;
      events.push({ type: 'INCIDENT_RESOLVED', newValue: value });
    }
    if (config.mode === 'WATCH') {
      if (state.baseline && hash(state.baseline) === hash(value)) {
        state.candidate = undefined;
        state.candidateCount = 0;
      } else {
        state.candidateCount = state.candidate && hash(state.candidate) === hash(value) ? state.candidateCount + 1 : 1;
        state.candidate = value;
        if (state.candidateCount >= config.changeThreshold) {
          events.push({ type: state.baseline ? 'VALUE_CHANGED' : 'BASELINE_ESTABLISHED', oldValue: state.baseline, newValue: value });
          state.baseline = value;
          state.candidate = undefined;
          state.candidateCount = 0;
        }
      }
    }
    state.status = state.incidentOpen ? 'CRITICAL' : observation.degraded || state.candidate ? 'WARNING' : 'HEALTHY';
    if (config.mode === 'WATCH' && !state.baseline && !state.incidentOpen) state.status = 'UNKNOWN';
  }
  state.lastCheckedAt = checkedAt.toISOString();
  return { state, events, observation, nextCheckAt: new Date(checkedAt.getTime() + config.intervalSeconds * 1000) };
}
