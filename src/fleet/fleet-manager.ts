/**
 * FleetManager — the broker launches and supervises its own Claude Code
 * sessions ("managed" sessions) in tmux windows on its PRIVATE tmux server.
 *
 * What CivicGate needed a launcher + watchdog + nudge script for, in one loop:
 *  - start the windows the spec wants, stop the ones it no longer wants;
 *  - answer first-run dialogs (trust folder, bypass permissions, dev channels);
 *  - respawn an exited window with backoff;
 *  - a wedged session ("Context limit reached" for every input) → /clear,
 *    then respawn if it is still wedged (CivicGate verified /clear alone can fail);
 *  - "Login expired" → respawn once a new token is saved;
 *  - usage limit / refused channel → report (routing already skips them).
 * It only ever touches windows it created, in its own tmux session.
 */
import fs from 'node:fs';
import type { Clock } from '../ports/clock.js';
import type { Logger } from '../ports/logger.js';
import { ConflictError, NotFoundError, ValidationError } from '../lib/errors.js';
import type { SessionRegistry } from '../broker/session-registry.js';
import { classifyPane, detectDialog, dialogKey, type TuiState } from './tui-state.js';
import type { Tmux } from './tmux.js';
import {
  desiredSessions,
  FleetSpecSchema,
  loadSpec,
  planFleet,
  saveSpec,
  type DesiredSession,
  type FleetSpec,
} from './spec.js';
import {
  claudeVersion,
  preTrustDir,
  prepareLaunch,
  sessionId,
  shimCommand,
  type FleetPaths,
} from './launch.js';
import { AUTH_WINDOW } from './auth.js';

export const IDLE_WINDOW = '_idle';
const RESERVED = new Set([IDLE_WINDOW, AUTH_WINDOW]);
const WEDGE_RESPAWN_MS = 30_000;
const MAX_DIALOG_KEYS = 25;
const HEALTHY_RUN_MS = 10 * 60_000;

interface LabelState {
  startedAt: number;
  restarts: number;
  lastRestartAt: number | null;
  backoffUntil: number;
  note: string | null;
  tuiState: TuiState;
  tuiDetail: string | null;
  clearSentAt: number | null;
  dialogKeys: number;
}

export interface FleetSessionStatus {
  label: string;
  pool: string;
  window: string | null;
  pane_pid: number | null;
  running: boolean;
  attached: boolean;
  session_id: string;
  tui_state: TuiState;
  tui_detail: string | null;
  restarts: number;
  last_restart_at: string | null;
  note: string | null;
}

export interface FleetStatus {
  spec: FleetSpec;
  running: boolean;
  tmux: { installed: boolean; socket: string; session: string; attach: string };
  claude: { installed: boolean; path: string | null; version: string | null };
  sessions: FleetSessionStatus[];
}

export interface FleetManagerOptions {
  tmux: Tmux;
  sessions: SessionRegistry;
  clock: Clock;
  logger: Logger;
  session: string;
  specPath: string;
  paths: FleetPaths;
  socketPath: string;
  brokerToken: string;
  claudeBin: () => string | null;
  shimOverride?: string;
  checkIntervalMs: number;
  /** ms of the last saved Claude token (respawn login_required sessions started before it). */
  tokenSavedAt: () => number | null;
  /** Override for tests; defaults to writing ~/.claude.json. */
  preTrust?: (dir: string) => void;
  /** Delay before the separate Enter after typed text (tests use 0). */
  submitDelayMs?: number;
  /** Override for tests; defaults to prepareLaunch (writes files). */
  prepare?: typeof prepareLaunch;
}

export class FleetManager {
  private spec: FleetSpec;
  private running = false;
  private readonly state = new Map<string, LabelState>();
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly o: FleetManagerOptions) {
    this.spec = loadSpec(o.specPath);
  }

  getSpec(): FleetSpec {
    return this.spec;
  }

  isRunning(): boolean {
    return this.running;
  }

  /** Validate + persist a spec. Does not start anything (call apply). */
  setSpec(input: unknown): FleetSpec {
    const parsed = FleetSpecSchema.safeParse(input ?? {});
    if (!parsed.success) {
      throw new ValidationError('invalid fleet spec', parsed.error.issues);
    }
    this.spec = parsed.data;
    saveSpec(this.o.specPath, this.spec);
    return this.spec;
  }

  start(): void {
    if (this.timer) return;
    if (this.spec.autostart && this.spec.pools.length > 0) {
      try {
        this.apply();
      } catch (err) {
        this.o.logger.warn({ err: (err as Error).message }, 'fleet autostart failed');
      }
    }
    this.timer = setInterval(() => {
      try {
        this.tick();
      } catch (err) {
        this.o.logger.warn({ err: (err as Error).message }, 'fleet tick failed');
      }
    }, this.o.checkIntervalMs);
    this.timer.unref?.();
  }

  stopTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private cwd(): string {
    const dir = this.spec.cwd ?? this.o.paths.workdir;
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  private requireTools(): string {
    if (!this.o.tmux.installed()) throw new ConflictError('tmux is not installed on this machine');
    const claude = this.o.claudeBin();
    if (!claude) throw new ConflictError('Claude Code is not installed on this machine (claude not found)');
    return claude;
  }

  private command(d: DesiredSession, claude: string): string {
    return (this.o.prepare ?? prepareLaunch)({
      session: d,
      paths: this.o.paths,
      cwd: this.cwd(),
      claudeBin: claude,
      socketPath: this.o.socketPath,
      brokerToken: this.o.brokerToken,
      shim: shimCommand(this.o.shimOverride),
    });
  }

  private fresh(now: number, prev?: LabelState): LabelState {
    return {
      startedAt: now,
      restarts: prev?.restarts ?? 0,
      lastRestartAt: prev?.lastRestartAt ?? null,
      backoffUntil: 0,
      note: null,
      tuiState: 'starting',
      tuiDetail: null,
      clearSentAt: null,
      dialogKeys: 0,
    };
  }

  /** Start missing windows, stop windows the spec no longer wants. */
  apply(): { started: string[]; stopped: string[]; kept: string[] } {
    const claude = this.requireTools();
    const cwd = this.cwd();
    this.o.tmux.ensureSession(this.o.session, cwd);
    (this.o.preTrust ?? ((d: string) => void preTrustDir(d)))(cwd);
    const desired = desiredSessions(this.spec);
    const windows = this.o.tmux.listWindows(this.o.session);
    const plan = planFleet(desired.map((d) => d.label), windows.map((w) => w.name), RESERVED);
    const now = this.o.clock.now();
    for (const label of plan.stop) {
      this.o.tmux.killWindow(this.o.session, label);
      this.state.delete(label);
    }
    for (const d of desired.filter((x) => plan.start.includes(x.label))) {
      this.o.tmux.newWindow(this.o.session, d.label, cwd, this.command(d, claude));
      this.state.set(d.label, this.fresh(now, this.state.get(d.label)));
    }
    this.running = true;
    this.o.logger.info({ started: plan.start, stopped: plan.stop }, 'fleet applied');
    return { started: plan.start, stopped: plan.stop, kept: plan.keep };
  }

  /** Close every managed window (the spec is kept; autostart still applies at the next daemon start). */
  stop(): { stopped: string[] } {
    const stopped: string[] = [];
    for (const w of this.o.tmux.listWindows(this.o.session)) {
      if (RESERVED.has(w.name)) continue;
      this.o.tmux.killWindow(this.o.session, w.name);
      stopped.push(w.name);
    }
    this.state.clear();
    this.running = false;
    return { stopped };
  }

  restart(label: string): { restarted: string } {
    const d = desiredSessions(this.spec).find((x) => x.label === label);
    if (!d) throw new NotFoundError('fleet session', label);
    this.respawn(d, 'restarted on request');
    this.running = true;
    return { restarted: label };
  }

  private respawn(d: DesiredSession, note: string): void {
    const claude = this.requireTools();
    const cwd = this.cwd();
    this.o.tmux.ensureSession(this.o.session, cwd);
    const exists = this.o.tmux.listWindows(this.o.session).some((w) => w.name === d.label);
    const cmd = this.command(d, claude);
    if (exists) this.o.tmux.respawnWindow(this.o.session, d.label, cwd, cmd);
    else this.o.tmux.newWindow(this.o.session, d.label, cwd, cmd);
    const now = this.o.clock.now();
    const prev = this.state.get(d.label);
    const st = this.fresh(now, prev);
    st.restarts = (prev?.restarts ?? 0) + 1;
    st.lastRestartAt = now;
    st.note = note;
    this.state.set(d.label, st);
    this.o.logger.info({ label: d.label, note }, 'fleet session respawned');
  }

  /** A new Claude token was saved: respawn sessions that were waiting for a login. */
  onTokenSaved(): void {
    for (const d of desiredSessions(this.spec)) {
      if (this.state.get(d.label)?.tuiState === 'login_required') {
        try {
          this.respawn(d, 'respawned after sign-in');
        } catch (err) {
          this.o.logger.warn({ label: d.label, err: (err as Error).message }, 'respawn after sign-in failed');
        }
      }
    }
  }

  /** One supervision pass. */
  tick(): void {
    if (!this.running) return;
    const now = this.o.clock.now();
    const windows = new Map(this.o.tmux.listWindows(this.o.session).map((w) => [w.name, w]));
    for (const d of desiredSessions(this.spec)) {
      const st = this.state.get(d.label) ?? this.fresh(now);
      this.state.set(d.label, st);
      const w = windows.get(d.label);
      if (!w || w.paneDead) {
        if (now < st.backoffUntil) continue;
        // A session that ran fine for a while starts its backoff over.
        if (now - st.startedAt > HEALTHY_RUN_MS) st.restarts = 0;
        const delay = Math.min(300_000, 5_000 * 2 ** Math.min(st.restarts, 6));
        try {
          this.respawn(d, w ? 'exited — restarted' : 'window missing — started');
          const n = this.state.get(d.label);
          if (n) n.backoffUntil = now + delay;
        } catch (err) {
          st.note = (err as Error).message;
          st.backoffUntil = now + delay;
        }
        continue;
      }
      const pane = this.o.tmux.capture(this.o.session, d.label) ?? '';
      const cls = classifyPane(pane);
      if (cls.state !== 'context_wedged') st.clearSentAt = null;
      st.tuiState = cls.state;
      st.tuiDetail = cls.detail;
      const attached = this.o.sessions.get(sessionId(d.label));
      if (attached) {
        attached.managed = true;
        this.o.sessions.setTui(attached.id, cls.state, cls.detail, now);
      }

      if (cls.state === 'prompt') {
        const dialog = detectDialog(pane);
        if (dialog && st.dialogKeys < MAX_DIALOG_KEYS) {
          st.dialogKeys++;
          this.o.tmux.sendKey(this.o.session, d.label, dialogKey(pane, dialog));
          st.note = `answering the ${dialog.name} prompt`;
        } else if (dialog) {
          st.note = `stuck at the ${dialog.name} prompt — answer it in tmux`;
        }
      } else if (cls.state === 'context_wedged') {
        if (st.clearSentAt === null) {
          this.typeAndSubmit(d.label, '/clear');
          st.clearSentAt = now;
          st.note = 'context wedged — sent /clear';
        } else if (now - st.clearSentAt > WEDGE_RESPAWN_MS) {
          this.respawn(d, 'still wedged after /clear — respawned');
        }
      } else if (cls.state === 'login_required') {
        const saved = this.o.tokenSavedAt();
        st.note = 'Claude login expired — sign in again (POST /auth/login)';
        if (saved !== null && saved > st.startedAt) this.respawn(d, 'respawned with the new sign-in');
      } else if (cls.state === 'usage_limited') {
        st.note = 'usage limit reached — waiting for the reset';
      } else if (cls.state === 'channels_unavailable') {
        st.note = 'Claude Code refused the broker channel — it cannot receive jobs';
      } else if (cls.state === 'ready' || cls.state === 'working') {
        if (st.note && /answering|starting|started|restarted|respawned/.test(st.note)) st.note = null;
      }
    }
  }

  status(): FleetStatus {
    const claude = this.o.claudeBin();
    const tmuxInstalled = this.o.tmux.installed();
    const windows = new Map(
      (tmuxInstalled ? this.o.tmux.listWindows(this.o.session) : []).map((w) => [w.name, w]),
    );
    return {
      spec: this.spec,
      running: this.running,
      tmux: {
        installed: tmuxInstalled,
        socket: this.o.tmux.socket,
        session: this.o.session,
        attach: `tmux -L ${this.o.tmux.socket} attach -t ${this.o.session}`,
      },
      claude: { installed: Boolean(claude), path: claude, version: claudeVersion(claude) },
      sessions: desiredSessions(this.spec).map((d) => {
        const w = windows.get(d.label);
        const st = this.state.get(d.label);
        const sess = this.o.sessions.get(sessionId(d.label));
        return {
          label: d.label,
          pool: d.pool,
          window: w ? w.name : null,
          pane_pid: w?.panePid ?? null,
          running: Boolean(w && !w.paneDead),
          attached: sess?.status === 'attached',
          session_id: sessionId(d.label),
          tui_state: w ? (st?.tuiState ?? 'unknown') : 'exited',
          tui_detail: st?.tuiDetail ?? null,
          restarts: st?.restarts ?? 0,
          last_restart_at: st?.lastRestartAt ? new Date(st.lastRestartAt).toISOString() : null,
          note: w ? (st?.note ?? null) : this.running ? 'not running yet' : 'fleet stopped',
        };
      }),
    };
  }

  /** Is this registry session one of ours? */
  isManaged(id: string): boolean {
    return desiredSessions(this.spec).some((d) => sessionId(d.label) === id);
  }

  labelFor(id: string): string | null {
    return desiredSessions(this.spec).find((d) => sessionId(d.label) === id)?.label ?? null;
  }

  /** Type an instruction into a managed session (nudge). */
  sendInstruction(label: string, text: string): void {
    this.typeAndSubmit(label, text);
  }

  /**
   * Clear the input line, type the text, then press Enter SEPARATELY a moment
   * later — a combined send-keys drops the Enter and jams the session
   * (CivicGate's drain scripts learned this).
   */
  private typeAndSubmit(label: string, text: string): void {
    this.o.tmux.sendKey(this.o.session, label, 'C-u');
    this.o.tmux.sendText(this.o.session, label, text);
    const t = setTimeout(() => this.o.tmux.sendKey(this.o.session, label, 'Enter'), this.o.submitDelayMs ?? 800);
    t.unref?.();
  }
}
