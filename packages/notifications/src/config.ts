import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { z } from 'zod';

export const channelConfig = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('WEBHOOK'),
    url: z.url().max(2048).refine(value => { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password && !url.hash; }, 'Use an HTTP(S) URL without credentials or a fragment'),
    signingSecret: z.string().min(16).max(256).optional(),
  }).strict(),
  z.object({
    type: z.literal('SMTP'), host: z.string().min(1).max(253).regex(/^[a-zA-Z0-9.:-]+$/),
    port: z.number().int().min(1).max(65535), secure: z.boolean(), requireTLS: z.boolean().default(true),
    username: z.string().min(1).max(254).optional(), password: z.string().max(1024).optional(),
    from: z.email().max(254), to: z.array(z.email().max(254)).min(1).max(10),
  }).strict().refine(value => Boolean(value.username) === (value.password !== undefined), 'SMTP username and password must be supplied together'),
]);
export type ChannelConfig = z.infer<typeof channelConfig>;
export const ruleConfig = z.object({
  eventTypes: z.array(z.enum(['VALUE_CHANGED', 'INCIDENT_OPENED', 'INCIDENT_RESOLVED'])).min(1).max(3),
  channelIds: z.array(z.uuid()).min(1).max(20),
  monitorIds: z.array(z.uuid()).max(1000).default([]),
}).strict();
export type RuleConfig = z.infer<typeof ruleConfig>;

export function encryptionKey(value: string | undefined): Buffer {
  if (!value || !/^[a-fA-F0-9]{64}$/.test(value)) throw new Error('ENCRYPTION_KEY must contain 64 hexadecimal characters');
  return Buffer.from(value, 'hex');
}
export function encrypt(config: ChannelConfig, key: Buffer, channelId: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(channelId));
  const data = Buffer.concat([cipher.update(JSON.stringify(config), 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), data.toString('base64')].join('.');
}
export function decrypt(value: string, key: Buffer, channelId: string): ChannelConfig {
  const [version, iv, tag, data, extra] = value.split('.');
  if (version !== 'v1' || !iv || !tag || !data || extra) throw new Error('Invalid encrypted configuration');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  decipher.setAAD(Buffer.from(channelId));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return channelConfig.parse(JSON.parse(Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8')));
}
