import { createHmac } from 'node:crypto';
import nodemailer from 'nodemailer';
import type { ChannelConfig } from './config.js';

export class DeliveryError extends Error {
  constructor(readonly code: string) { super(code); }
}

/** Bounded delivery. Only return sanitized failure codes; never log provider bodies or URLs. */
export async function deliver(config: ChannelConfig, id: string, payload: unknown, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new DeliveryError('SHUTDOWN');
  const body = JSON.stringify(payload);
  if (Buffer.byteLength(body) > 256 * 1024) throw new DeliveryError('PAYLOAD_TOO_LARGE');
  if (config.type === 'WEBHOOK') {
    const headers: Record<string, string> = { 'content-type': 'application/json', 'idempotency-key': id, 'x-dnsmonitor-delivery': id };
    if (config.signingSecret) headers['x-dnsmonitor-signature'] = 'sha256=' + createHmac('sha256', config.signingSecret).update(body).digest('hex');
    try {
      const response = await fetch(config.url, { method: 'POST', headers, body, redirect: 'manual', signal: AbortSignal.any([AbortSignal.timeout(10000), ...(signal ? [signal] : [])]) });
      await response.body?.cancel();
      if (!response.ok) throw new DeliveryError(`HTTP_${response.status}`);
    } catch (error) {
      if (error instanceof DeliveryError) throw error;
      throw new DeliveryError(signal?.aborted ? 'SHUTDOWN' : 'HTTP_NETWORK_OR_TIMEOUT');
    }
    return;
  }
  const transport = nodemailer.createTransport({
    host: config.host, port: config.port, secure: config.secure, requireTLS: config.requireTLS,
    auth: config.username ? { user: config.username, pass: config.password } : undefined,
    connectionTimeout: 5000, greetingTimeout: 5000, socketTimeout: 10000,
    disableFileAccess: true, disableUrlAccess: true,
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    await Promise.race([
      transport.sendMail({ from: config.from, to: config.to, subject: 'DNSmonitor notification', text: body, messageId: `<${id}@dnsmonitor.local>` }).then(result => { if (result.rejected.length) throw new DeliveryError('SMTP_RECIPIENT_REJECTED'); }),
      new Promise<never>((_, reject) => {
        abort = () => { transport.close(); reject(new DeliveryError('SHUTDOWN')); };
        timer = setTimeout(() => { transport.close(); reject(new DeliveryError('SMTP_TIMEOUT')); }, 10000);
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
      }),
    ]);
  } catch (error) { throw error instanceof DeliveryError ? error : new DeliveryError('SMTP_DELIVERY_FAILED'); }
  finally { clearTimeout(timer); if (abort) signal?.removeEventListener('abort', abort); transport.close(); }
}
