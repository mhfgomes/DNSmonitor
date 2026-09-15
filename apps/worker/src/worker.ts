import { setTimeout as sleep } from 'node:timers/promises';
import { query, type QueryResult } from '../../../packages/dns-engine/src/query.js';
import { errorCode } from '../../../packages/database/src/connection.js';
import { Repository, type Claim } from '../../../packages/database/src/repository.js';

export interface WorkerOptions {
  id: string;
  concurrency: number;
  pollMs?: number;
  drainMs?: number;
  log?: (event: Record<string, unknown>) => void;
}

export class Worker {
  private readonly active = new Set<Promise<void>>();
  private readonly abortQueries = new AbortController();
  private lastHeartbeat = 0;
  private stopping = false;
  private readonly log: (event: Record<string, unknown>) => void;

  constructor(private readonly repository: Repository, private readonly options: WorkerOptions) {
    if (!Number.isInteger(options.concurrency) || options.concurrency < 1 || options.concurrency > 100) throw new Error('Invalid worker concurrency');
    this.log = options.log ?? (event => console.log(JSON.stringify({ time: new Date().toISOString(), workerId: options.id, ...event })));
  }

  get ready(): boolean { return !this.stopping && Date.now() - this.lastHeartbeat < 15000; }
  get activeJobs(): number { return this.active.size; }

  private async execute(claim: Claim): Promise<void> {
    try {
      const results: QueryResult[] = [];
      for (const resolver of claim.resolvers) {
        if (this.abortQueries.signal.aborted) throw new Error('Shutdown');
        results.push(await query({ hostname: claim.config.hostname, type: claim.config.recordType, resolver, timeoutMs: claim.config.timeoutMs, signal: this.abortQueries.signal }));
      }
      if (this.abortQueries.signal.aborted) throw new Error('Shutdown');
      const committed = await this.repository.complete(claim, results);
      this.log({ event: committed ? 'check_completed' : 'check_discarded', monitorId: claim.id, executionId: claim.token });
    } catch (error) {
      const code = this.abortQueries.signal.aborted ? 'SHUTDOWN' : errorCode(error);
      this.log({ event: 'check_error', monitorId: claim.id, executionId: claim.token, code });
      try { await this.repository.fail(claim, code); }
      catch (failure) { this.log({ event: 'claim_release_error', code: errorCode(failure) }); }
    }
  }

  async run(signal: AbortSignal): Promise<void> {
    const markStopping = () => { this.stopping = true; };
    signal.addEventListener('abort', markStopping, { once: true });
    try {
      while (!signal.aborted) {
        try {
          if (Date.now() - this.lastHeartbeat >= 5000) {
            await this.repository.heartbeat(this.options.id, this.active.size);
            this.lastHeartbeat = Date.now();
          }
          const capacity = this.options.concurrency - this.active.size;
          if (capacity > 0 && !signal.aborted) {
            const claims = await this.repository.claimDue(this.options.id, capacity);
            for (const claim of claims) {
              if (signal.aborted) { await this.repository.fail(claim, 'SHUTDOWN'); continue; }
              const task = this.execute(claim).finally(() => this.active.delete(task));
              this.active.add(task);
            }
          }
        } catch (error) {
          this.lastHeartbeat = 0;
          this.log({ event: 'scheduler_error', code: errorCode(error) });
        }
        await sleep(this.options.pollMs ?? 500, undefined, { signal }).catch(() => undefined);
      }
    } finally {
      this.stopping = true;
      signal.removeEventListener('abort', markStopping);
      const deadline = setTimeout(() => this.abortQueries.abort(), this.options.drainMs ?? 15000);
      try { await Promise.all(this.active); }
      finally { clearTimeout(deadline); }
      await this.repository.heartbeat(this.options.id, 0, 'STOPPED').catch(error => this.log({ event: 'heartbeat_error', code: errorCode(error) }));
      this.log({ event: 'worker_stopped' });
    }
  }
}
