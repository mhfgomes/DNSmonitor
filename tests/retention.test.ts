import { test } from 'node:test';
import assert from 'node:assert/strict';
import { retentionConfig } from '../packages/database/src/retention.js';
test('retention configuration bounds work and preserves a longer summary window', () => {
  assert.equal(retentionConfig({}).checkHours, 24);
  assert.equal(retentionConfig({ RETENTION_ENABLED: 'false' }).enabled, false);
  for (const env of [{ RETENTION_BATCH_SIZE: '0' }, { RETENTION_BATCH_SIZE: '1001' }, { RETENTION_CHECK_HOURS: 'NaN' }, { RETENTION_ENABLED: 'no' }, { RETENTION_SUMMARY_DAYS: '1' }]) assert.throws(() => retentionConfig(env));
});
