import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TuiWatcher, type NudgeConfig } from '../../src/broker/tui-watcher.js';
import { SessionRegistry } from '../../src/broker/session-registry.js';
import { SqliteJobStore } from '../../src/adapters/job-store/sqlite.js';
import { makeFakeClock, type FakeClock } from '../../src/adapters/clock/fake.js';
import { silentLogger } from '../../src/adapters/logger/pino.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.resolve(here, '..', '..', 'migrations');
const pane = (n: string): string => fs.readFileSync(path.join(here, '..', 'fixtures', 'panes', `${n}.txt`), 'utf8');

describe('TuiWatcher', () => {
  let tmp: string;
  let clock: FakeClock;
  let store: SqliteJobStore;
  let sessions: SessionRegistry;
  let panes: Map<string, string>;
  let sent: Array<{ target: string; text: string }>;

  const watcher = (nudge: Partial<NudgeConfig> = {}): TuiWatcher =>
    new TuiWatcher({
      sessions,
      store,
      clock,
      logger: silentLogger(),
      fleet: null,
      intervalMs: 1000,
      watchUnmanaged: true,
      nudge: { enabled: false, managed: true, afterSec: 20, cooldownSec: 60, text: 'go', ...nudge },
      resolveTarget: (pid) => (pid ? `pane-${pid}` : undefined),
      capture: (t) => panes.get(t) ?? null,
      sendKeys: (target, text) => sent.push({ target, text }),
    });

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-tui-'));
    clock = makeFakeClock(10_000_000);
    store = new SqliteJobStore({ path: path.join(tmp, 'j.sqlite'), clock, migrationsDir });
    sessions = new SessionRegistry(clock);
    panes = new Map();
    sent = [];
  });

  afterEach(async () => {
    await store.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  async function dispatchedJob(sessionId: string, ageMs: number): Promise<void> {
    const now = clock.now();
    await store.insert({ id: `j-${sessionId}`, session_id: sessionId, content: 'x', ttl_sec: 300, created_at: now - ageMs, expires_at: now + 300_000 });
    await store.transitionStatus(`j-${sessionId}`, 'pending', 'dispatched', { dispatched_at: now - ageMs }, now - ageMs);
  }

  it('classifies unmanaged sessions from their pane (read-only)', async () => {
    sessions.register({ id: 's1', label: 'x', pid: 42 });
    panes.set('pane-42', pane('usage-limited'));
    await watcher().tick();
    expect(sessions.get('s1')).toMatchObject({ tuiState: 'usage_limited' });
    expect(sent).toHaveLength(0);
  });

  it('does not nudge unmanaged sessions unless enabled', async () => {
    sessions.register({ id: 's1', label: 'x', pid: 42 });
    panes.set('pane-42', pane('ready'));
    await dispatchedJob('s1', 60_000);
    await watcher().tick();
    expect(sent).toHaveLength(0);
  });

  it('nudges an idle session whose job sits dispatched past after_sec, once per cooldown', async () => {
    sessions.register({ id: 's1', label: 'x', pid: 42 });
    panes.set('pane-42', pane('ready'));
    await dispatchedJob('s1', 60_000);
    const w = watcher({ enabled: true });
    await w.tick();
    expect(sent).toEqual([{ target: 'pane-42', text: 'go' }]);
    await w.tick();
    expect(sent).toHaveLength(1);
  });

  it('does not nudge a busy or fresh session', async () => {
    sessions.register({ id: 's1', label: 'x', pid: 42 });
    panes.set('pane-42', pane('working'));
    await dispatchedJob('s1', 60_000);
    await watcher({ enabled: true }).tick();
    sessions.register({ id: 's2', label: 'y', pid: 43 });
    panes.set('pane-43', pane('ready'));
    await dispatchedJob('s2', 5_000);
    await watcher({ enabled: true }).tick();
    expect(sent).toHaveLength(0);
  });
});
