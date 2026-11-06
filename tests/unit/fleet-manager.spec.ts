import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FleetManager } from '../../src/fleet/fleet-manager.js';
import { Tmux } from '../../src/fleet/tmux.js';
import { SessionRegistry } from '../../src/broker/session-registry.js';
import { makeFakeClock, type FakeClock } from '../../src/adapters/clock/fake.js';
import { silentLogger } from '../../src/adapters/logger/pino.js';
import { FakeTmux } from '../helpers/fake-tmux.js';

const fixtures = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'fixtures', 'panes');
const pane = (n: string): string => fs.readFileSync(path.join(fixtures, `${n}.txt`), 'utf8');

describe('FleetManager', () => {
  let tmp: string;
  let fake: FakeTmux;
  let clock: FakeClock;
  let sessions: SessionRegistry;
  let tokenAt: number | null;
  let fleet: FleetManager;

  const make = (): FleetManager =>
    new FleetManager({
      tmux: new Tmux('test-sock', fake.exec),
      sessions,
      clock,
      logger: silentLogger(),
      session: 'claude-broker',
      specPath: path.join(tmp, 'fleet.json'),
      paths: { stateDir: path.join(tmp, 'state'), oauthEnv: path.join(tmp, 'oauth.env'), workdir: path.join(tmp, 'work') },
      socketPath: '/tmp/cb-test.sock',
      brokerToken: 'tok',
      claudeBin: () => '/usr/bin/claude',
      checkIntervalMs: 10_000,
      tokenSavedAt: () => tokenAt,
      preTrust: () => {},
      submitDelayMs: 0,
    });

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-fleet-'));
    fake = new FakeTmux();
    clock = makeFakeClock(1_000_000);
    sessions = new SessionRegistry(clock);
    tokenAt = null;
    fleet = make();
    fleet.setSpec({ pools: [{ name: 'general', count: 1 }, { name: 'summary', count: 2, model: 'haiku' }] });
  });

  afterEach(() => {
    fleet.stopTimer();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('persists the spec and reloads it', () => {
    expect(JSON.parse(fs.readFileSync(path.join(tmp, 'fleet.json'), 'utf8')).pools).toHaveLength(2);
    expect(make().getSpec().pools[1]).toMatchObject({ name: 'summary', count: 2, model: 'haiku' });
  });

  it('rejects an invalid spec', () => {
    expect(() => fleet.setSpec({ pools: [{ name: 'x y' }] })).toThrow(/invalid fleet spec/);
  });

  it('apply starts one window per label with a secret-free command; a second apply keeps them', () => {
    const r = fleet.apply();
    expect(r.started).toEqual(['general', 'summary-1', 'summary-2']);
    const w = fake.windows.get('summary-1')!;
    expect(w.command).toContain('--strict-mcp-config');
    expect(w.command).toContain('--dangerously-load-development-channels server:claude-broker');
    expect(w.command).toContain('ENABLE_TOOL_SEARCH=false');
    expect(w.command).not.toContain('tok'); // the broker token lives in the 0600 MCP config, not the command line
    const mcp = JSON.parse(fs.readFileSync(path.join(tmp, 'state', 'sessions', 'summary-1.mcp.json'), 'utf8'));
    expect(mcp.mcpServers['claude-broker'].env).toMatchObject({ CLAUDE_BROKER_SESSION_LABEL: 'summary-1', CLAUDE_BROKER_SESSION_ID: 'fleet-summary-1' });
    expect(fs.statSync(path.join(tmp, 'state', 'sessions', 'summary-1.mcp.json')).mode & 0o777).toBe(0o600);
    const settings = JSON.parse(fs.readFileSync(path.join(tmp, 'state', 'sessions', 'summary-1.settings.json'), 'utf8'));
    expect(settings).toMatchObject({ skipDangerousModePermissionPrompt: true, model: 'haiku' });
    expect(fleet.apply()).toEqual({ started: [], stopped: [], kept: ['general', 'summary-1', 'summary-2'] });
    expect(fake.calls.some((c) => c[0] === 'kill-server')).toBe(false);
  });

  it('apply stops windows the spec no longer wants, never the reserved ones', () => {
    fleet.apply();
    fleet.setSpec({ pools: [{ name: 'general', count: 1 }] });
    expect(fleet.apply()).toMatchObject({ stopped: ['summary-1', 'summary-2'] });
    expect([...fake.windows.keys()].sort()).toEqual(['_idle', 'general']);
  });

  it('answers first-run dialogs by moving to the wanted option', () => {
    fleet.apply();
    const w = fake.windows.get('general')!;
    w.pane = pane('bypass');
    fleet.tick();
    expect(fake.keys.at(-1)).toMatchObject({ window: 'general', key: 'Down' });
    w.pane = pane('dev-channels-first');
    fleet.tick();
    expect(fake.keys.at(-1)).toMatchObject({ window: 'general', key: 'Enter' });
  });

  it('respawns an exited window, with backoff', () => {
    fleet.apply();
    const w = fake.windows.get('general')!;
    w.dead = true;
    fleet.tick();
    expect(w.dead).toBe(false);
    expect(fleet.status().sessions.find((s) => s.label === 'general')?.restarts).toBe(1);
    w.dead = true;
    clock.advance(1_000);
    fleet.tick();
    expect(w.dead).toBe(true); // still backing off
    clock.advance(20_000);
    fleet.tick();
    expect(w.dead).toBe(false);
  });

  it('a wedged session gets /clear, then a respawn if it stays wedged', () => {
    fleet.apply();
    const w = fake.windows.get('general')!;
    w.pane = pane('context-wedged');
    fleet.tick();
    expect(fake.keys.filter((k) => k.window === 'general').map((k) => k.key)).toContain('/clear');
    const pid = w.pid;
    clock.advance(31_000);
    fleet.tick();
    expect(w.pid).not.toBe(pid);
  });

  it('login_required respawns only once a newer token is saved', () => {
    fleet.apply();
    const w = fake.windows.get('general')!;
    w.pane = pane('login-expired');
    const pid = w.pid;
    fleet.tick();
    expect(w.pid).toBe(pid);
    expect(fleet.status().sessions.find((s) => s.label === 'general')?.note).toMatch(/sign in/);
    tokenAt = clock.now() + 1;
    fleet.tick();
    expect(w.pid).not.toBe(pid);
  });

  it('usage limit and refused channel are reported, not acted on', () => {
    fleet.apply();
    fake.windows.get('general')!.pane = pane('usage-limited');
    fake.windows.get('summary-1')!.pane = pane('channels-unavailable');
    fleet.tick();
    const st = fleet.status().sessions;
    expect(st.find((s) => s.label === 'general')).toMatchObject({ tui_state: 'usage_limited' });
    expect(st.find((s) => s.label === 'summary-1')).toMatchObject({ tui_state: 'channels_unavailable' });
    expect(fake.keys).toHaveLength(0);
  });

  it('marks the attached registry session managed and mirrors its tui_state', () => {
    fleet.apply();
    sessions.register({ id: 'fleet-general', label: 'general' });
    fake.windows.get('general')!.pane = pane('ready');
    fleet.tick();
    expect(sessions.get('fleet-general')).toMatchObject({ managed: true, tuiState: 'ready' });
    expect(fleet.status().sessions[0]).toMatchObject({ label: 'general', attached: true, running: true });
  });

  it('stop closes managed windows only', () => {
    fleet.apply();
    expect(fleet.stop().stopped.sort()).toEqual(['general', 'summary-1', 'summary-2']);
    expect([...fake.windows.keys()]).toEqual(['_idle']);
    expect(fleet.isRunning()).toBe(false);
  });

  it('apply refuses without tmux or claude', () => {
    fake.installed = false;
    expect(() => fleet.apply()).toThrow(/tmux is not installed/);
  });
});
