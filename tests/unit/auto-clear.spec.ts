import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AutoClearManager, type ClearInjection } from '../../src/broker/auto-clear.js';
import { JobService } from '../../src/broker/job-service.js';
import { SessionRegistry } from '../../src/broker/session-registry.js';
import { SseBus } from '../../src/broker/sse-bus.js';
import { SqliteJobStore } from '../../src/adapters/job-store/sqlite.js';
import { makeFakeClock } from '../../src/adapters/clock/fake.js';
import { silentLogger } from '../../src/adapters/logger/pino.js';
import type { JobDispatcher } from '../../src/ports/job-dispatcher.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.resolve(here, '..', '..', 'migrations');

function noopDispatcher(): JobDispatcher {
  return {
    async notifyPending() {},
    async notifyDone() {},
    async notifySessionAttached() {},
    async start() {},
    async stop() {},
  };
}

describe('AutoClearManager', () => {
  let tmp: string;
  let store: SqliteJobStore;
  let clock: ReturnType<typeof makeFakeClock>;
  let sessions: SessionRegistry;
  let bus: SseBus;
  let service: JobService;
  let cleared: ClearInjection[];
  let mgr: AutoClearManager;

  function build(overrides: Partial<ConstructorParameters<typeof AutoClearManager>[0]> = {}) {
    mgr = new AutoClearManager({
      bus,
      store,
      sessions,
      clock,
      logger: silentLogger(),
      enabled: true,
      idleMs: 60_000,
      minJobs: 1,
      cooldownMs: 120_000,
      checkIntervalMs: 30_000,
      keys: '/clear',
      runner: (spec) => {
        cleared.push(spec);
      },
      ...overrides,
    });
    mgr.start();
    return mgr;
  }

  async function completeJob(): Promise<void> {
    const job = await service.submit({ session_id: 'sess-1', content: 'work', ttl_sec: 600 });
    await store.transitionStatus(job.id, 'pending', 'dispatched');
    await service.complete(job.id, 'ok', { sessionId: 'sess-1' });
  }

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-ac-'));
    clock = makeFakeClock(1_000_000);
    store = new SqliteJobStore({ path: path.join(tmp, 'jobs.sqlite'), clock, migrationsDir });
    sessions = new SessionRegistry(clock);
    bus = new SseBus();
    service = new JobService({
      store,
      dispatcher: noopDispatcher(),
      sessions,
      bus,
      clock,
      logger: silentLogger(),
      defaults: { job_ttl_sec: 300, client_ref_window_sec: 86400 },
    });
    cleared = [];
    sessions.register({ id: 'sess-1', label: 'worker' });
  });

  afterEach(async () => {
    mgr?.stop();
    await store.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('clears an idle session after a finished job', async () => {
    build();
    await completeJob();
    clock.advance(61_000);
    await mgr.tick();
    expect(cleared.length).toBe(1);
    expect(cleared[0].keys).toBe('/clear');
    expect(cleared[0].session.id).toBe('sess-1');
  });

  it('does not clear while a job is still in flight (mid-job guard)', async () => {
    build();
    const job = await service.submit({ session_id: 'sess-1', content: 'work', ttl_sec: 600 });
    await store.transitionStatus(job.id, 'pending', 'dispatched');
    // Also finish an earlier job so the finished counter is armed.
    await completeJob();
    clock.advance(61_000);
    await mgr.tick();
    expect(cleared.length).toBe(0);
  });

  it('does not clear before the idle window elapses', async () => {
    build();
    await completeJob();
    clock.advance(30_000); // < idleMs
    await mgr.tick();
    expect(cleared.length).toBe(0);
  });

  it('does not clear a session that has done no work', async () => {
    build();
    clock.advance(120_000);
    await mgr.tick();
    expect(cleared.length).toBe(0);
  });

  it('honours minJobs before clearing', async () => {
    build({ minJobs: 2 });
    await completeJob();
    clock.advance(61_000);
    await mgr.tick();
    expect(cleared.length).toBe(0);

    await completeJob();
    clock.advance(61_000);
    await mgr.tick();
    expect(cleared.length).toBe(1);
  });

  it('debounces via cooldown and resets the finished counter after a clear', async () => {
    build();
    await completeJob();
    clock.advance(61_000);
    await mgr.tick();
    expect(cleared.length).toBe(1);

    // A new job finishes, idle elapses again, but cooldown blocks a second clear.
    await completeJob();
    clock.advance(61_000);
    await mgr.tick();
    expect(cleared.length).toBe(1);

    // Past the cooldown, it clears again.
    clock.advance(120_000);
    await mgr.tick();
    expect(cleared.length).toBe(2);
  });

  it('retries on injection failure (counters preserved)', async () => {
    let calls = 0;
    build({
      runner: () => {
        calls += 1;
        if (calls === 1) throw new Error('tmux missing');
      },
    });
    await completeJob();
    clock.advance(61_000);
    await mgr.tick();
    expect(calls).toBe(1); // failed

    await mgr.tick(); // still idle, counters intact → retry
    expect(calls).toBe(2);
  });
});
