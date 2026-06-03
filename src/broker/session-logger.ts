import type { Logger } from '../ports/logger.js';
import type { Job } from '../ports/types.js';
import { toIso } from '../lib/time.js';
import { sessionLogDir } from '../lib/log-paths.js';
import { RollingLog } from './rolling-log.js';
import type { SseBus } from './sse-bus.js';

export interface SessionLoggerOptions {
  bus: SseBus;
  logger: Logger;
  /** Log root; one subdir per session. */
  root: string;
  /** Roll size for each session's active `jobs.log`. */
  maxBytes: number;
}

interface JobEventData {
  jobId: string;
  sessionId: string;
  status: string;
  job: Job;
}

/**
 * Daemon-side per-session logger. Subscribes to the SseBus — which already
 * carries the full job on every lifecycle event — and appends one structured
 * JSONL record per event to `<root>/<sessionId>/jobs.log` (size-rolled).
 *
 * This is the broker's honest view of a session: job inputs (content + meta at
 * creation) and job outputs (result/error at completion), plus progress and
 * comments. It does NOT include Claude's terminal transcript — that is captured
 * separately by the `cll` launcher.
 */
export class SessionLogger {
  private readonly bus: SseBus;
  private readonly logger: Logger;
  private readonly root: string;
  private readonly maxBytes: number;
  private readonly logs = new Map<string, RollingLog>();
  private unsubscribe: (() => void) | null = null;

  constructor(opts: SessionLoggerOptions) {
    this.bus = opts.bus;
    this.logger = opts.logger;
    this.root = opts.root;
    this.maxBytes = opts.maxBytes;
  }

  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.bus.subscribe<JobEventData>('job.', (msg) => {
      this.record(msg.topic, msg.data, msg.at);
    });
    this.logger.info({ root: this.root }, 'session logging enabled');
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.logs.clear();
  }

  private record(topic: string, data: JobEventData, at: number): void {
    const entry = format(topic, data, at);
    if (!entry) return;
    try {
      this.logFor(data.sessionId).append(JSON.stringify(entry));
    } catch (err) {
      // Logging must never take down the broker.
      this.logger.warn(
        {
          err: err instanceof Error ? err.message : String(err),
          sessionId: data.sessionId,
        },
        'failed to write session log',
      );
    }
  }

  private logFor(sessionId: string): RollingLog {
    let log = this.logs.get(sessionId);
    if (!log) {
      log = new RollingLog({
        dir: sessionLogDir(this.root, sessionId),
        baseName: 'jobs.log',
        maxBytes: this.maxBytes,
      });
      this.logs.set(sessionId, log);
    }
    return log;
  }
}

/** Map a job SSE event to a compact log record, or null to skip it. */
export function format(
  topic: string,
  data: JobEventData,
  at: number,
): Record<string, unknown> | null {
  const job = data.job;
  const base = { ts: toIso(at), jobId: data.jobId };
  switch (topic) {
    case 'job.created':
      return {
        ...base,
        ev: 'input',
        content: job.content,
        meta: job.meta,
        priority: job.priority,
        mode: job.mode,
        ttl_sec: job.ttl_sec,
      };
    case 'job.completed':
      return { ...base, ev: 'output', status: 'completed', result: job.result };
    case 'job.failed':
      return { ...base, ev: 'output', status: 'failed', error: job.error };
    case 'job.progress':
      return { ...base, ev: 'progress', note: lastNote(job) };
    case 'job.commented':
      return { ...base, ev: 'comment', note: lastNote(job) };
    case 'job.cancelled':
    case 'job.expired':
    case 'job.orphaned':
      return { ...base, ev: 'end', status: data.status };
    default:
      return null;
  }
}

function lastNote(job: Job): string | null {
  return job.progress_notes.at(-1)?.note ?? null;
}
