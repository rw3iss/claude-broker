import type { Clock } from '../ports/clock.js';
import type { JobDispatcher } from '../ports/job-dispatcher.js';
import type { JobStore } from '../ports/job-store.js';
import type { Logger } from '../ports/logger.js';
import type {
  Job,
  JobEventKind,
  JobMeta,
  JobMode,
  JobPriority,
  JobStatus,
  NewJob,
} from '../ports/types.js';
import { TERMINAL_STATUSES } from '../ports/types.js';
import {
  ConflictError,
  NotFoundError,
  ValidationError,
} from '../lib/errors.js';
import { jobId as makeJobId } from '../lib/ids.js';
import { toIso } from '../lib/time.js';
import type { SessionRegistry } from './session-registry.js';
import type { SseBus } from './sse-bus.js';
import { pickSession } from '../fleet/routing.js';

const META_KEY_RE = /^[A-Za-z0-9_]+$/;

export interface SubmitJobInput {
  session_id?: string;
  session_label?: string;
  /** Pool: attached sessions labelled `<pool>` or `<pool>-<n>`. */
  pool?: string;
  spawn_if_missing?: boolean;
  content: string;
  meta?: JobMeta;
  ttl_sec?: number;
  priority?: JobPriority;
  mode?: JobMode;
  client_ref?: string | null;
}

export interface JobServiceDefaults {
  job_ttl_sec: number;
  client_ref_window_sec: number;
}

export interface JobServiceOptions {
  store: JobStore;
  dispatcher: JobDispatcher;
  sessions: SessionRegistry;
  bus: SseBus;
  clock: Clock;
  logger: Logger;
  defaults: JobServiceDefaults;
}

export interface ToolCallContext {
  sessionId: string;
}

export class JobService {
  private readonly store: JobStore;
  private readonly dispatcher: JobDispatcher;
  private readonly sessions: SessionRegistry;
  private readonly bus: SseBus;
  private readonly clock: Clock;
  private readonly logger: Logger;
  private readonly defaults: JobServiceDefaults;

  constructor(opts: JobServiceOptions) {
    this.store = opts.store;
    this.dispatcher = opts.dispatcher;
    this.sessions = opts.sessions;
    this.bus = opts.bus;
    this.clock = opts.clock;
    this.logger = opts.logger;
    this.defaults = opts.defaults;
  }

  async submit(input: SubmitJobInput): Promise<Job> {
    if (!input.content || input.content.trim() === '') {
      throw new ValidationError('content is required');
    }
    const targets = [input.session_id, input.session_label, input.pool].filter(Boolean).length;
    if (targets > 1) {
      throw new ValidationError(
        'session_id, session_label and pool are mutually exclusive',
      );
    }
    if (targets === 0) {
      throw new ValidationError('one of session_id, session_label or pool is required');
    }

    if (input.meta) {
      for (const key of Object.keys(input.meta)) {
        if (!META_KEY_RE.test(key)) {
          throw new ValidationError(
            `invalid meta key "${key}": must match [A-Za-z0-9_]+`,
          );
        }
      }
    }

    let sessionId = input.session_id;
    if (!sessionId && (input.session_label || input.pool)) {
      const match = await this.route(
        input.pool ? { pool: input.pool } : { label: input.session_label as string },
      );
      if (match) {
        sessionId = match.id;
        match.lastDispatchAt = this.clock.now();
      } else if (input.pool) {
        throw new NotFoundError('healthy session in pool', input.pool);
      } else if (input.spawn_if_missing) {
        throw new ConflictError(
          'spawn_if_missing not implemented at JobService layer; ' +
            'wire via /sessions/spawn HTTP endpoint',
        );
      } else {
        throw new NotFoundError('session', input.session_label);
      }
    }
    if (!sessionId) throw new NotFoundError('session');

    const now = this.clock.now();

    if (input.client_ref) {
      const existing = await this.store.findByClientRef(
        sessionId,
        input.client_ref,
        this.defaults.client_ref_window_sec * 1000,
        now,
      );
      if (existing) return existing;
    }

    const ttl = input.ttl_sec ?? this.defaults.job_ttl_sec;
    const id = makeJobId();
    const newJob: NewJob = {
      id,
      session_id: sessionId,
      content: input.content,
      meta: input.meta,
      priority: input.priority ?? 'normal',
      mode: input.mode ?? 'serial',
      ttl_sec: ttl,
      client_ref: input.client_ref ?? null,
      created_at: now,
      expires_at: now + ttl * 1000,
    };
    const job = await this.store.insert(newJob);
    this.publish('job.created', job);
    await this.dispatcher.notifyPending(sessionId, id);
    return job;
  }

  /**
   * Least-busy HEALTHY attached session for a label or pool (ties → least
   * recently routed). See src/fleet/routing.ts.
   */
  async route(by: { label?: string; pool?: string }) {
    const candidates = this.sessions.candidates(by);
    if (candidates.length === 0) return null;
    const busy = await this.busyCounts(candidates.map((c) => c.id));
    return pickSession(candidates, busy);
  }

  /** Active (pending / dispatched / in_progress) jobs per session id. */
  async busyCounts(sessionIds: string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    for (const id of sessionIds) {
      const r = await this.store.list({
        session_id: id,
        status: ['pending', 'dispatched', 'in_progress'],
        limit: 1,
      });
      out.set(id, r.total);
    }
    return out;
  }

  async get(jobId: string): Promise<Job> {
    const job = await this.store.get(jobId);
    if (!job) throw new NotFoundError('job', jobId);
    return job;
  }

  async list(filter: {
    status?: JobStatus | JobStatus[];
    session_id?: string;
    since?: number;
    limit?: number;
    offset?: number;
  }) {
    return this.store.list(filter);
  }

  async cancel(jobId: string): Promise<Job> {
    return this.transitionToTerminal(jobId, 'cancelled', 'job.cancelled', {
      verb: 'cancel',
    });
  }

  /** Tool call: complete_job({ job_id, result }) */
  async complete(
    jobId: string,
    result: unknown,
    _ctx: ToolCallContext,
  ): Promise<Job> {
    return this.transitionToTerminal(jobId, 'completed', 'job.completed', {
      verb: 'complete',
      patch: { result },
    });
  }

  /** Tool call: fail_job({ job_id, error }) */
  async fail(
    jobId: string,
    error: string,
    _ctx: ToolCallContext,
  ): Promise<Job> {
    return this.transitionToTerminal(jobId, 'failed', 'job.failed', {
      verb: 'fail',
      patch: { error },
    });
  }

  /** Tool call: note_progress({ job_id, note }) */
  async noteProgress(
    jobId: string,
    note: string,
    _ctx: ToolCallContext,
  ): Promise<Job> {
    const existing = await this.store.get(jobId);
    if (!existing) throw new NotFoundError('job', jobId);
    if (TERMINAL_STATUSES.has(existing.status)) {
      throw new ConflictError(
        `cannot add progress to job in terminal state: ${existing.status}`,
      );
    }
    const now = this.clock.now();
    const next = [
      ...existing.progress_notes,
      { at: toIso(now), note },
    ];

    // Bump to in_progress if it was still 'dispatched' — first progress note
    // is the natural moment to flip.
    let updated: Job;
    if (existing.status === 'dispatched') {
      const transitioned = await this.store.transitionStatus(
        jobId,
        'dispatched',
        'in_progress',
        { progress_notes: next },
        now,
      );
      if (!transitioned) {
        // Lost the race; just patch progress notes.
        updated = await this.store.patch(jobId, { progress_notes: next });
      } else {
        updated = transitioned;
      }
    } else {
      updated = await this.store.patch(jobId, { progress_notes: next });
    }
    this.publish('job.progress', updated);
    return updated;
  }

  /** Tool call: ack_job({ job_id }) — flips dispatched → in_progress. */
  async ack(jobId: string, _ctx: ToolCallContext): Promise<Job> {
    const existing = await this.store.get(jobId);
    if (!existing) throw new NotFoundError('job', jobId);
    if (existing.status !== 'dispatched') return existing;
    const updated = await this.store.transitionStatus(
      jobId,
      'dispatched',
      'in_progress',
      {},
      this.clock.now(),
    );
    if (!updated) return existing;
    this.publish('job.progress', updated);
    return updated;
  }

  /** Submitter appends a comment to a running job; HTTP layer calls this. */
  async addComment(jobId: string, note: string): Promise<Job> {
    const existing = await this.store.get(jobId);
    if (!existing) throw new NotFoundError('job', jobId);
    if (TERMINAL_STATUSES.has(existing.status)) {
      throw new ConflictError(
        `cannot comment on job in terminal state: ${existing.status}`,
      );
    }
    const now = this.clock.now();
    const next = [
      ...existing.progress_notes,
      { at: toIso(now), note: `[comment] ${note}` },
    ];
    const updated = await this.store.patch(jobId, { progress_notes: next });
    this.publish('job.commented', updated);
    return updated;
  }

  /** Sweeper-driven: forcibly mark a job expired. */
  async markExpired(jobId: string): Promise<Job | null> {
    return this.transitionToTerminal(jobId, 'expired', 'job.expired', {
      patch: { error: 'ttl_elapsed' },
      quiet: true,
    });
  }

  /** Sweeper-driven: forcibly mark a job orphaned. */
  async markOrphaned(jobId: string): Promise<Job | null> {
    return this.transitionToTerminal(jobId, 'orphaned', 'job.orphaned', {
      patch: { error: 'session_unreachable' },
      quiet: true,
    });
  }

  /**
   * Move a job to a terminal state, publish the event, and unblock the
   * dispatcher. Two modes:
   *   - throwing (default, client/tool-driven): missing → NotFoundError,
   *     already-terminal → ConflictError, lost race → ConflictError.
   *   - quiet (sweeper-driven): missing → null, already-terminal → the
   *     existing job, lost race → null.
   */
  private transitionToTerminal(
    jobId: string,
    to: JobStatus,
    event: JobEventKind,
    opts: { verb: string; patch?: Partial<Job>; quiet?: false },
  ): Promise<Job>;
  private transitionToTerminal(
    jobId: string,
    to: JobStatus,
    event: JobEventKind,
    opts: { patch?: Partial<Job>; quiet: true },
  ): Promise<Job | null>;
  private async transitionToTerminal(
    jobId: string,
    to: JobStatus,
    event: JobEventKind,
    opts: { verb?: string; patch?: Partial<Job>; quiet?: boolean },
  ): Promise<Job | null> {
    const existing = await this.store.get(jobId);
    if (!existing) {
      if (opts.quiet) return null;
      throw new NotFoundError('job', jobId);
    }
    if (TERMINAL_STATUSES.has(existing.status)) {
      if (opts.quiet) return existing;
      throw new ConflictError(
        `cannot ${opts.verb} job in terminal state: ${existing.status}`,
      );
    }
    const updated = await this.store.transitionStatus(
      jobId,
      existing.status,
      to,
      opts.patch ?? {},
      this.clock.now(),
    );
    if (!updated) {
      if (opts.quiet) return null;
      throw new ConflictError('job state changed under us; retry');
    }
    this.publish(event, updated);
    await this.dispatcher.notifyDone(updated.session_id, updated.id);
    return updated;
  }

  private publish(kind: JobEventKind, job: Job): void {
    this.bus.publish(
      kind,
      { jobId: job.id, sessionId: job.session_id, status: job.status, job },
      this.clock.now(),
    );
  }
}
