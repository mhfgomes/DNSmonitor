import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { encrypt, decrypt, encryptionKey, channelConfig } from '../packages/notifications/src/config.js';
import { equalToken } from '../packages/auth/src/index.js';

test('channel encryption authenticates ciphertext, key and channel identity', () => {
  const key = randomBytes(32);
  const config = { type: 'WEBHOOK' as const, url: 'https://example.test/secret-path', signingSecret: 'secret-signing-value' };
  const encrypted = encrypt(config, key, 'channel-one');
  assert.ok(!encrypted.includes('secret-path'));
  assert.deepEqual(decrypt(encrypted, key, 'channel-one'), config);
  assert.throws(() => decrypt(encrypted, key, 'channel-two'));
  assert.throws(() => decrypt(encrypted, randomBytes(32), 'channel-one'));
  const fields = encrypted.split('.');
  const data = Buffer.from(fields[3]!, 'base64'); data[0] = data[0]! ^ 1; fields[3] = data.toString('base64');
  assert.throws(() => decrypt(fields.join('.'), key, 'channel-one'));
  assert.throws(() => encryptionKey('short'));
});
test('webhook config rejects non-HTTP destinations and embedded credentials', () => {
  for (const url of ['file:///etc/passwd', 'http://user:password@example.test', 'https://example.test/#secret']) assert.equal(channelConfig.safeParse({ type: 'WEBHOOK', url }).success, false);
  assert.equal(channelConfig.safeParse({ type: 'WEBHOOK', url: 'http://127.0.0.1:9999/hook' }).success, true);
});
test('CSRF comparison rejects unequal byte lengths without throwing', () => {
  assert.equal(equalToken('é'.repeat(64), 'a'.repeat(64)), false);
  assert.equal(equalToken('a'.repeat(64), 'a'.repeat(64)), true);
});
