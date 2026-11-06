/**
 * 0.6 HTTP surface: pools + health-aware routing, session tui fields,
 * capabilities, /fleet and /auth (fleet driven by an in-memory tmux).
 */
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildHttpServer } from '../../src/broker/http-server.js';
import { JobService } from '../../src/broker/job-service.js';
import { SessionRegistry } from '../../src/broker/session-registry.js';
import { SseBus } from '../../src/broker/sse-bus.js';
import { StaticBearerAuthenticator } from '../../src/broker/auth.js';
import { SqliteJobStore } from '../../src/adapters/job-store/sqlite.js';
import { InProcessJobDispatcher } from '../../src/adapters/job-dispatcher/inproc.js';
import { realClock } from '../../src/adapters/clock/real.js';
import { silentLogger } from '../../src/adapters/logger/pino.js';
import { FleetManager } from '../../src/fleet/fleet-manager.js';
import { AuthManager } from '../../src/fleet/auth.js';
import { Tmux } from '../../src/fleet/tmux.js';
import { FakeTmux } from '../helpers/fake-tmux.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.resolve(here, '..', '..', 'migrations');
const TOKEN = 'test-token';

describe('HTTP 0.6', () => {
  let tmp: string;
  let store: SqliteJobStore;
  let sessions: SessionRegistry;
  let dispatcher: InProcessJobDispatcher;
  let service: JobService;
  let fake: FakeTmux;
  let fleet: FleetManager;
  let http: ReturnType<typeof buildHttpServer>;
  let bare: ReturnType<typeof buildHttpServer>;

  beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-http06-'));
    store = new SqliteJobStore({ path: path.join(tmp, 'jobs.sqlite'), clock: realClock, migrationsDir });
    sessions = new SessionRegistry(realClock);
    const bus = new SseBus();
    dispatcher = new InProcessJobDispatcher({
      store,
      clock: realClock,
      logger: silentLogger(),
      sink: { async send() {} },
      sessionGate: { isAttached: (id) => sessions.get(id)?.status === 'attached' },
    });
    service = new JobService({
      store,
      dispatcher,
      sessions,
      bus,
      clock: realClock,
      logger: silentLogger(),
      defaults: { job_ttl_sec: 300, client_ref_window_sec: 86400 },
    });
    await dispatcher.start();
    fake = new FakeTmux();
    const tmux = new Tmux('test-sock', fake.exec);
    fleet = new FleetManager({
      tmux,
      sessions,
      clock: realClock,
      logger: silentLogger(),
      session: 'claude-broker',
      specPath: path.join(tmp, 'fleet.json'),
      paths: { stateDir: path.join(tmp, 'state'), oauthEnv: path.join(tmp, 'oauth.env'), workdir: path.join(tmp, 'work') },
      socketPath: '/tmp/cb-test.sock',
      brokerToken: TOKEN,
      claudeBin: () => '/usr/bin/claude',
      checkIntervalMs: 60_000,
      tokenSavedAt: () => null,
      preTrust: () => {},
      submitDelayMs: 0,
    });
    const authManager = new AuthManager({
      tmux,
      session: 'claude-broker',
      oauthEnv: path.join(tmp, 'oauth.env'),
      workdir: tmp,
      claudeBin: () => null,
      clock: realClock,
      logger: silentLogger(),
    });
    const common = {
      service,
      sessions,
      bus,
      clock: realClock,
      logger: silentLogger(),
      auth: new StaticBearerAuthenticator(TOKEN),
      longPollMaxSec: 60,
    };
    http = buildHttpServer({ ...common, fleet, authManager, claudeBin: () => null });
    bare = buildHttpServer(common);
    await http.fastify.ready();
    await bare.fastify.ready();
  });

  afterEach(async () => {
    fleet.stopTimer();
    await http.close();
    await bare.close();
    await dispatcher.stop();
    await store.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const inject = (server: ReturnType<typeof buildHttpServer>, method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, body?: unknown) =>
    server.fastify.inject({ method, url, headers: { authorization: `Bearer ${TOKEN}` }, payload: body as object | undefined }) as unknown as Promise<{ statusCode: number; json(): any }>;

  it('healthz advertises the 0.6 capabilities', async () => {
    const r = await http.fastify.inject({ method: 'GET', url: '/healthz' });
    expect(r.json().capabilities).toEqual(['pools', 'fleet', 'auth', 'tui']);
  });

  it('POST /jobs by pool picks the least-busy healthy member', async () => {
    sessions.register({ id: 's1', label: 'summary-1' });
    sessions.register({ id: 's2', label: 'summary-2' });
    sessions.register({ id: 's3', label: 'summary-3' });
    sessions.setTui('s3', 'usage_limited', 'limit', Date.now());
    const first = (await inject(http, 'POST', '/jobs', { pool: 'summary', content: 'a' })).json();
    const second = (await inject(http, 'POST', '/jobs', { pool: 'summary', content: 'b' })).json();
    expect(new Set([first.job.session_id, second.job.session_id])).toEqual(new Set(['s1', 's2']));
    const third = (await inject(http, 'POST', '/jobs', { pool: 'summary', content: 'c' })).json();
    expect(third.job.session_id).not.toBe('s3');
  });

  it('POST /jobs by label load-balances same-label sessions and skips unhealthy ones', async () => {
    sessions.register({ id: 'a', label: 'general' });
    sessions.register({ id: 'b', label: 'general' });
    const ids = [];
    for (let i = 0; i < 4; i++) ids.push((await inject(http, 'POST', '/jobs', { session_label: 'general', content: `j${i}` })).json().job.session_id);
    expect(ids.filter((x) => x === 'a')).toHaveLength(2);
    sessions.setTui('a', 'login_required', null, Date.now());
    sessions.setTui('b', 'channels_unavailable', null, Date.now());
    const r = await inject(http, 'POST', '/jobs', { session_label: 'general', content: 'x' });
    expect(r.statusCode).toBe(404);
  });

  it('POST /jobs: exactly one of session_id, session_label, pool; unknown pool 404', async () => {
    expect((await inject(http, 'POST', '/jobs', { pool: 'x', session_label: 'y', content: 'a' })).statusCode).toBe(400);
    expect((await inject(http, 'POST', '/jobs', { content: 'a' })).statusCode).toBe(400);
    expect((await inject(http, 'POST', '/jobs', { pool: 'nobody', content: 'a' })).statusCode).toBe(404);
  });

  it('GET /pools groups label families with busy + health, plus fleet pools', async () => {
    sessions.register({ id: 's1', label: 'summary-1' });
    sessions.register({ id: 's2', label: 'summary-2' });
    sessions.register({ id: 'g', label: 'general' });
    sessions.setTui('s2', 'context_wedged', null, Date.now());
    await inject(http, 'POST', '/jobs', { session_id: 's1', content: 'x' });
    await inject(http, 'PUT', '/fleet', { pools: [{ name: 'classify', count: 2 }] });
    const items = (await inject(http, 'GET', '/pools')).json().items;
    expect(items.map((p: { name: string }) => p.name)).toEqual(['classify', 'general', 'summary']);
    const summary = items.find((p: { name: string }) => p.name === 'summary');
    expect(summary).toMatchObject({ attached: 2, healthy: 1, busy: 1 });
    expect(items.find((p: { name: string }) => p.name === 'classify')).toMatchObject({ attached: 0, members: [] });
  });

  it('GET /sessions carries tui_state, busy, managed', async () => {
    sessions.register({ id: 's1', label: 'x' });
    sessions.setTui('s1', 'ready', null, Date.now());
    const item = (await inject(http, 'GET', '/sessions')).json().items[0];
    expect(item).toMatchObject({ id: 's1', tui_state: 'ready', busy: 0, managed: false });
    expect(item.tui_checked_at).toBeTruthy();
  });

  it('/fleet and /auth answer 404 when the fleet is disabled', async () => {
    expect((await inject(bare, 'GET', '/fleet')).statusCode).toBe(404);
    expect((await inject(bare, 'GET', '/auth')).statusCode).toBe(404);
  });

  it('PUT /fleet validates; GET /fleet reports; apply/stop/restart work', async () => {
    expect((await inject(http, 'PUT', '/fleet', { pools: [{ name: 'bad name' }] })).statusCode).toBe(400);
    const put = (await inject(http, 'PUT', '/fleet', { pools: [{ name: 'general', count: 2, model: 'haiku' }] })).json();
    expect(put.spec.pools[0]).toMatchObject({ name: 'general', count: 2, model: 'haiku' });
    const applied = (await inject(http, 'POST', '/fleet/apply')).json();
    expect(applied.started).toEqual(['general-1', 'general-2']);
    const st = (await inject(http, 'GET', '/fleet')).json();
    expect(st.tmux).toMatchObject({ installed: true, socket: 'test-sock', session: 'claude-broker' });
    expect(st.tmux.attach).toBe('tmux -L test-sock attach -t claude-broker');
    expect(st.sessions.map((s: { label: string }) => s.label)).toEqual(['general-1', 'general-2']);
    expect(st.sessions[0]).toMatchObject({ pool: 'general', running: true, attached: false, session_id: 'fleet-general-1', restarts: 0 });
    expect((await inject(http, 'POST', '/fleet/sessions/general-2/restart')).json()).toEqual({ restarted: 'general-2' });
    expect((await inject(http, 'POST', '/fleet/sessions/nope/restart')).statusCode).toBe(404);
    expect((await inject(http, 'POST', '/fleet/stop')).json().stopped.sort()).toEqual(['general-1', 'general-2']);
  });

  it('GET /auth reports claude missing + no token; login refuses without claude', async () => {
    const a = (await inject(http, 'GET', '/auth')).json();
    expect(a).toEqual({
      claude: { installed: false, path: null, version: null },
      token: { set: false, created_at: null, expires_at: null },
      login: { pending: false, url: null, started_at: null, error: null },
    });
    expect((await inject(http, 'POST', '/auth/login')).statusCode).toBe(409);
    expect((await inject(http, 'POST', '/auth/login/code', { code: 'x' })).statusCode).toBe(400);
  });
});
