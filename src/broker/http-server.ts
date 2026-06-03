import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from 'fastify';
import { z } from 'zod';
import type { Clock } from '../ports/clock.js';
import type { Logger } from '../ports/logger.js';
import type { JobService } from './job-service.js';
import type { SessionRegistry } from './session-registry.js';
import type { SseBus } from './sse-bus.js';
import type { Authenticator } from './auth.js';
import { DomainError, UnauthorizedError } from '../lib/errors.js';
import { toIso, toIsoOrNull } from '../lib/time.js';
import { packageVersion } from '../lib/version.js';
import {
  CommentBodySchema,
  ListJobsQuerySchema,
  ListSessionsQuerySchema,
  SubmitJobBodySchema,
  WaitQuerySchema,
} from './schemas.js';
import { TERMINAL_STATUSES, type Job, type JobStatus } from '../ports/types.js';

const PACKAGE_VERSION = packageVersion();

export interface SpawnSessionFn {
  (input: { label: string; cwd?: string; env?: Record<string, string> }): Promise<{
    sessionId: string;
  }>;
}

export interface HttpServerOptions {
  service: JobService;
  sessions: SessionRegistry;
  bus: SseBus;
  clock: Clock;
  logger: Logger;
  auth: Authenticator;
  longPollMaxSec: number;
  /** Optional spawn helper. Wired in T14. */
  spawnSession?: SpawnSessionFn;
  /** Optional shim-side comment relay; bridge to SocketServer.commentJob. */
  notifyComment?: (sessionId: string, jobId: string, note: string) => void;
  /** Optional shim-side cancel relay; bridge to SocketServer.cancelJob. */
  notifyCancel?: (sessionId: string, jobId: string) => void;
}

export interface BuiltHttpServer {
  fastify: FastifyInstance;
  listen(host: string, port: number): Promise<{ address: string }>;
  close(): Promise<void>;
}

export function buildHttpServer(opts: HttpServerOptions): BuiltHttpServer {
  const fastify = Fastify({ logger: false, disableRequestLogging: true });

  const requireAuth = async (req: FastifyRequest): Promise<void> => {
    const header = req.headers['authorization'];
    if (!opts.auth.check(typeof header === 'string' ? header : undefined)) {
      throw new UnauthorizedError();
    }
  };

  fastify.setErrorHandler((error: unknown, _req, reply) => {
    if (error instanceof DomainError) {
      void reply.status(error.status).send({
        error: { code: error.code, message: error.message, details: error.details },
      });
      return;
    }
    if (error instanceof z.ZodError) {
      void reply.status(400).send({
        error: {
          code: 'validation_error',
          message: 'invalid request',
          details: error.issues,
        },
      });
      return;
    }
    const err = error as Error;
    opts.logger.error(
      { err: err.message, stack: err.stack },
      'unhandled http error',
    );
    void reply.status(500).send({
      error: { code: 'internal', message: err.message },
    });
  });

  // Health & discovery -----------------------------------------------------
  fastify.get('/healthz', async () => ({
    ok: true,
    version: PACKAGE_VERSION,
    uptimeSec: Math.floor(process.uptime()),
    sessionCount: opts.sessions.list({ status: 'attached' }).length,
  }));

  fastify.get('/metrics', async (_req, reply) => {
    const attached = opts.sessions.list({ status: 'attached' }).length;
    const inflight = await opts.service.list({
      status: ['dispatched', 'in_progress'],
    });
    const lines = [
      '# HELP claude_channel_sessions_attached Number of attached shim sessions',
      '# TYPE claude_channel_sessions_attached gauge',
      `claude_channel_sessions_attached ${attached}`,
      '# HELP claude_channel_jobs_in_flight Jobs in dispatched or in_progress',
      '# TYPE claude_channel_jobs_in_flight gauge',
      `claude_channel_jobs_in_flight ${inflight.total}`,
    ];
    void reply.type('text/plain; version=0.0.4').send(lines.join('\n') + '\n');
  });

  // Sessions ---------------------------------------------------------------
  fastify.get('/sessions', async (req) => {
    await requireAuth(req);
    const q = ListSessionsQuerySchema.parse(req.query ?? {});
    return {
      items: opts.sessions.list(q).map(serializeSession),
    };
  });

  fastify.get<{ Params: { id: string } }>(
    '/sessions/:id',
    async (req, reply) => {
      await requireAuth(req);
      const session = opts.sessions.get(req.params.id);
      if (!session) {
        void reply.status(404).send({
          error: { code: 'not_found', message: `session not found: ${req.params.id}` },
        });
        return;
      }
      const recent = await opts.service.list({
        session_id: req.params.id,
        limit: 20,
      });
      return {
        ...serializeSession(session),
        recent_jobs: recent.items.map(serializeJob),
      };
    },
  );

  fastify.delete<{ Params: { id: string } }>(
    '/sessions/:id',
    async (req, reply) => {
      await requireAuth(req);
      const ok = opts.sessions.detach(req.params.id, 'http_delete');
      if (!ok) {
        void reply.status(404).send({
          error: { code: 'not_found', message: 'session not attached' },
        });
        return;
      }
      return { ok: true };
    },
  );

  fastify.post('/sessions/spawn', async (req, reply) => {
    await requireAuth(req);
    if (!opts.spawnSession) {
      void reply.status(501).send({
        error: {
          code: 'not_implemented',
          message: 'spawn helper not configured',
        },
      });
      return;
    }
    const body = req.body as
      | { label?: string; cwd?: string; env?: Record<string, string> }
      | undefined;
    if (!body?.label) {
      void reply.status(400).send({
        error: { code: 'validation_error', message: 'label is required' },
      });
      return;
    }
    const { sessionId } = await opts.spawnSession({
      label: body.label,
      cwd: body.cwd,
      env: body.env,
    });
    return { session_id: sessionId };
  });

  fastify.get('/sessions/events', async (req, reply) => {
    await requireAuth(req);
    const off = opts.bus.subscribe('session.', (msg) => {
      writeSse(reply, msg.topic, msg.data);
    });
    sseHeaders(reply);
    const hb = setInterval(() => writeSse(reply, 'heartbeat', { at: opts.clock.now() }), 15_000);
    req.raw.on('close', () => {
      clearInterval(hb);
      off();
    });
    // Don't return — keep the connection open.
    return reply;
  });

  // Jobs -------------------------------------------------------------------
  fastify.post('/jobs', async (req, reply) => {
    await requireAuth(req);
    const body = SubmitJobBodySchema.parse(req.body ?? {});
    const job = await opts.service.submit(body);
    void reply.status(202);
    return {
      job_id: job.id,
      status: job.status,
      job: serializeJob(job),
    };
  });

  fastify.get('/jobs', async (req) => {
    await requireAuth(req);
    const q = ListJobsQuerySchema.parse(req.query ?? {});
    const status = q.status
      ? (q.status.split(',').filter(Boolean) as JobStatus[])
      : undefined;
    const result = await opts.service.list({
      status: status && status.length === 1 ? status[0] : status,
      session_id: q.session_id,
      since: q.since,
      limit: q.limit,
      offset: q.offset,
    });
    return {
      items: result.items.map(serializeJob),
      total: result.total,
    };
  });

  fastify.get<{ Params: { id: string } }>('/jobs/:id', async (req) => {
    await requireAuth(req);
    const job = await opts.service.get(req.params.id);
    return serializeJob(job);
  });

  fastify.get<{ Params: { id: string }; Querystring: unknown }>(
    '/jobs/:id/wait',
    async (req, reply) => {
      await requireAuth(req);
      const q = WaitQuerySchema.parse(req.query ?? {});
      const timeoutSec = Math.min(q.timeout, opts.longPollMaxSec);
      const job = await opts.service.get(req.params.id);
      if (TERMINAL_STATUSES.has(job.status)) {
        return { ...serializeJob(job), timed_out: false };
      }
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), timeoutSec * 1000);
      try {
        await opts.bus.waitFor<{ jobId: string; status: JobStatus }>(
          'job.',
          (data) =>
            data.jobId === req.params.id && TERMINAL_STATUSES.has(data.status),
          { signal: ac.signal },
        );
      } catch {
        // Either aborted (timeout) or no terminal event.
      } finally {
        clearTimeout(timer);
      }
      const finalJob = await opts.service.get(req.params.id);
      return {
        ...serializeJob(finalJob),
        timed_out: !TERMINAL_STATUSES.has(finalJob.status),
      };
    },
  );

  fastify.get<{ Params: { id: string } }>(
    '/jobs/:id/stream',
    async (req, reply) => {
      await requireAuth(req);
      const jobId = req.params.id;
      // Bail early if the job doesn't exist.
      await opts.service.get(jobId);

      sseHeaders(reply);
      const off = opts.bus.subscribe<{ jobId: string }>('job.', (msg) => {
        if (msg.data.jobId === jobId) writeSse(reply, msg.topic, msg.data);
      });
      const hb = setInterval(
        () => writeSse(reply, 'heartbeat', { at: opts.clock.now() }),
        15_000,
      );
      req.raw.on('close', () => {
        clearInterval(hb);
        off();
      });
      return reply;
    },
  );

  fastify.delete<{ Params: { id: string } }>(
    '/jobs/:id',
    async (req) => {
      await requireAuth(req);
      const cancelled = await opts.service.cancel(req.params.id);
      if (opts.notifyCancel) {
        opts.notifyCancel(cancelled.session_id, cancelled.id);
      }
      return serializeJob(cancelled);
    },
  );

  fastify.post<{ Params: { id: string } }>(
    '/jobs/:id/comment',
    async (req) => {
      await requireAuth(req);
      const body = CommentBodySchema.parse(req.body ?? {});
      const updated = await opts.service.addComment(req.params.id, body.note);
      if (opts.notifyComment) {
        opts.notifyComment(updated.session_id, updated.id, body.note);
      }
      return serializeJob(updated);
    },
  );

  return {
    fastify,
    async listen(host, port) {
      const address = await fastify.listen({ host, port });
      return { address };
    },
    async close() {
      await fastify.close();
    },
  };
}

function serializeJob(job: Job): Record<string, unknown> {
  return {
    id: job.id,
    session_id: job.session_id,
    status: job.status,
    content: job.content,
    meta: job.meta,
    priority: job.priority,
    mode: job.mode,
    ttl_sec: job.ttl_sec,
    client_ref: job.client_ref,
    result: job.result,
    error: job.error,
    progress_notes: job.progress_notes,
    history: job.history,
    created_at: toIso(job.created_at),
    dispatched_at: toIsoOrNull(job.dispatched_at),
    completed_at: toIsoOrNull(job.completed_at),
    expires_at: toIso(job.expires_at),
  };
}

function serializeSession(s: {
  id: string;
  label: string | null;
  status: string;
  pid: number | null;
  registeredAt: number;
  lastHeartbeatAt: number;
  metadata: Record<string, string>;
}): Record<string, unknown> {
  return {
    id: s.id,
    label: s.label,
    status: s.status,
    pid: s.pid,
    metadata: s.metadata,
    registered_at: toIso(s.registeredAt),
    last_heartbeat_at: toIso(s.lastHeartbeatAt),
  };
}

function sseHeaders(reply: FastifyReply): void {
  void reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
}

function writeSse(reply: FastifyReply, event: string, data: unknown): void {
  reply.raw.write(`event: ${event}\n`);
  reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
}
