import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SessionLogger, format } from '../../src/broker/session-logger.js';
import { SseBus } from '../../src/broker/sse-bus.js';
import { silentLogger } from '../../src/adapters/logger/pino.js';
import type { Job } from '../../src/ports/types.js';

function job(overrides: Partial<Job> = {}): Job {
  return {
    id: 'j1',
    session_id: 's1',
    status: 'pending',
    priority: 'normal',
    mode: 'serial',
    content: 'do the thing',
    meta: { ticket: 'A1' },
    ttl_sec: 300,
    client_ref: null,
    result: null,
    error: null,
    progress_notes: [],
    history: [],
    created_at: 1000,
    dispatched_at: null,
    completed_at: null,
    expires_at: 301000,
    ...overrides,
  };
}

function publish(bus: SseBus, topic: string, j: Job) {
  bus.publish(topic, { jobId: j.id, sessionId: j.session_id, status: j.status, job: j }, 1000);
}

describe('SessionLogger', () => {
  let root: string;
  let bus: SseBus;
  let logger: SessionLogger;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-slog-'));
    bus = new SseBus();
    logger = new SessionLogger({ bus, logger: silentLogger(), root, maxBytes: 1_000_000 });
    logger.start();
  });
  afterEach(() => {
    logger.stop();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const readLines = (sessionId: string) =>
    fs
      .readFileSync(path.join(root, sessionId, 'jobs.log'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));

  it('writes an input record on job.created and an output record on completion', () => {
    publish(bus, 'job.created', job());
    publish(bus, 'job.completed', job({ status: 'completed', result: { ok: true } }));

    const lines = readLines('s1');
    expect(lines[0]).toMatchObject({
      ev: 'input',
      jobId: 'j1',
      content: 'do the thing',
      meta: { ticket: 'A1' },
    });
    expect(lines[1]).toMatchObject({
      ev: 'output',
      status: 'completed',
      result: { ok: true },
    });
  });

  it('records failures with the error', () => {
    publish(bus, 'job.failed', job({ status: 'failed', error: 'boom' }));
    expect(readLines('s1')[0]).toMatchObject({ ev: 'output', status: 'failed', error: 'boom' });
  });

  it('records progress notes', () => {
    publish(
      bus,
      'job.progress',
      job({ status: 'in_progress', progress_notes: [{ at: 'x', note: 'thinking' }] }),
    );
    expect(readLines('s1')[0]).toMatchObject({ ev: 'progress', note: 'thinking' });
  });

  it('separates logs per session', () => {
    publish(bus, 'job.created', job({ session_id: 's1' }));
    publish(bus, 'job.created', job({ id: 'j2', session_id: 's2' }));
    expect(fs.existsSync(path.join(root, 's1', 'jobs.log'))).toBe(true);
    expect(fs.existsSync(path.join(root, 's2', 'jobs.log'))).toBe(true);
  });

  it('stops writing after stop()', () => {
    logger.stop();
    publish(bus, 'job.created', job());
    expect(fs.existsSync(path.join(root, 's1'))).toBe(false);
  });

  it('format() skips events with no log mapping', () => {
    expect(format('job.dispatched', { jobId: 'j', sessionId: 's', status: 'x', job: job() }, 0)).toBeNull();
  });
});
