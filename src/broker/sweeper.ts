import type { Clock } from '../ports/clock.js';
import type { JobStore } from '../ports/job-store.js';
import type { Logger } from '../ports/logger.js';
import type { JobService } from './job-service.js';
import type { SessionRegistry } from './session-registry.js';
import { pruneLogsOlderThan } from './rolling-log.js';

export interface SweeperOptions {
  store: JobStore;
  service: JobService;
  sessions: SessionRegistry;
  clock: Clock;
  logger: Logger;
  intervalMs: number;
  /** Heartbeat timeout for sessions, in ms. */
  heartbeatTimeoutMs: number;
  /** Grace period (ms) before a dispatched/in_progress job on a detached
   * session is marked orphaned. */
  orphanGraceMs: number;
  /** Max rows processed per tick (defaults to 100). */
  batchSize?: number;
  /** If set, each tick deletes session-log files older than retainDays. */
  logRetention?: { root: string; retainDays: number };
  /** Called on every tick; useful for tests. */
  onTick?: () => void;
}

export class Sweeper {
  private readonly store: JobStore;
  private readonly service: JobService;
  private readonly sessions: SessionRegistry;
  private readonly clock: Clock;
  private readonly logger: Logger;
  private readonly intervalMs: number;
  private readonly heartbeatTimeoutMs: number;
  private readonly orphanGraceMs: number;
  private readonly batchSize: number;
  private readonly logRetention: { root: string; retainDays: number } | undefined;
  private readonly onTick: (() => void) | undefined;
  private timer: NodeJS.Timeout | null = null;

  constructor(opts: SweeperOptions) {
    this.store = opts.store;
    this.service = opts.service;
    this.sessions = opts.sessions;
    this.clock = opts.clock;
    this.logger = opts.logger;
    this.intervalMs = opts.intervalMs;
    this.heartbeatTimeoutMs = opts.heartbeatTimeoutMs;
    this.orphanGraceMs = opts.orphanGraceMs;
    this.batchSize = opts.batchSize ?? 100;
    this.logRetention = opts.logRetention;
    this.onTick = opts.onTick;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick().catch((err) => {
        this.logger.error(
          { err: err instanceof Error ? err.message : String(err) },
          'sweeper tick failed',
        );
      });
    }, this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async tick(): Promise<void> {
    try {
      // 1. Evict stale sessions.
      this.sessions.evictStale(this.heartbeatTimeoutMs);

      // 2. Expire TTL-elapsed jobs.
      const now = this.clock.now();
      const expired = await this.store.findExpired(now, this.batchSize);
      for (const job of expired) {
        await this.service.markExpired(job.id);
      }

      // 3. Orphan dispatched/in_progress jobs on detached sessions past grace.
      const inflight = await this.store.list({
        status: ['dispatched', 'in_progress'],
        limit: this.batchSize,
      });
      for (const job of inflight.items) {
        const sess = this.sessions.get(job.session_id);
        if (!sess || sess.status === 'detached') {
          // Use dispatched_at + grace as the cutoff. If null, fall back to created_at.
          const reference = job.dispatched_at ?? job.created_at;
          if (now - reference >= this.orphanGraceMs) {
            await this.service.markOrphaned(job.id);
          }
        }
      }

      // 4. Retention: prune session-log files older than retain_days.
      if (this.logRetention) {
        const cutoff = now - this.logRetention.retainDays * 24 * 60 * 60 * 1000;
        const deleted = pruneLogsOlderThan(this.logRetention.root, cutoff);
        if (deleted.length > 0) {
          this.logger.info(
            { count: deleted.length, retainDays: this.logRetention.retainDays },
            'pruned old session logs',
          );
        }
      }
    } finally {
      this.onTick?.();
    }
  }
}
