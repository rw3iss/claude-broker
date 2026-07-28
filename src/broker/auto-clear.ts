import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import type { Clock } from '../ports/clock.js';
import type { Logger } from '../ports/logger.js';
import type { JobStore } from '../ports/job-store.js';
import type { SessionRegistry, SessionHandle } from './session-registry.js';
import type { SseBus } from './sse-bus.js';
import type { Job, JobStatus } from '../ports/types.js';

/**
 * A single context-reset injection request. The runner turns this into the
 * actual side effect (tmux send-keys, a custom shell command, …).
 */
export interface ClearInjection {
  session: SessionHandle;
  /** Keystrokes to type into the session's TUI, e.g. "/clear". */
  keys: string;
  /** Explicit tmux target, if configured. */
  tmuxTarget?: string;
  /** Custom shell command template, if configured. */
  command?: string;
}

export interface AutoClearOptions {
  bus: SseBus;
  store: JobStore;
  sessions: SessionRegistry;
  clock: Clock;
  logger: Logger;
  enabled: boolean;
  /** Clear only once a session has been idle (no job activity) this long. */
  idleMs: number;
  /** Require at least this many finished jobs since the last clear. */
  minJobs: number;
  /** Never clear more often than this. */
  cooldownMs: number;
  /** How often the manager evaluates sessions. */
  checkIntervalMs: number;
  /** Keystrokes to inject, e.g. "/clear". */
  keys: string;
  /** Explicit tmux target for send-keys (session:window.pane, or session name). */
  tmuxTarget?: string;
  /** Custom shell command template — overrides the tmux path entirely. */
  command?: string;
  /**
   * Injection runner. Defaults to a tmux/shell implementation; tests override
   * it. Should throw on failure so the manager keeps the state unchanged.
   */
  runner?: (spec: ClearInjection) => void | Promise<void>;
}

interface SessionState {
  /** Jobs that reached a done state since the last clear (completed + failed). */
  finishedSinceClear: number;
  /** Last time any job event touched this session. */
  lastActivityAt: number;
  /** Last time we cleared this session (0 = never). */
  lastClearAt: number;
}

interface JobEventData {
  jobId: string;
  sessionId: string;
  status: string;
  job: Job;
}

/** Non-terminal states — presence of any means a job is in flight. */
const ACTIVE_STATUSES: JobStatus[] = ['pending', 'dispatched', 'in_progress'];

/**
 * Automatically resets an attached Claude session's context window when it goes
 * idle after finishing work — the automated equivalent of typing `/clear` in the
 * TUI when the queue drains.
 *
 * WHY THIS DRIVES THE TUI EXTERNALLY: the broker delivers jobs to Claude as
 * `notifications/claude/channel` events, which land as message *content*. A
 * `/clear` pushed down that channel would be read as literal text, not run as a
 * slash command. The only way to actually reset context is to type the command
 * into the terminal the session reads from — hence tmux `send-keys` (or a custom
 * command). This never restarts the process, so the session stays attached and
 * no in-flight job is dropped.
 *
 * SAFETY:
 *  - Never fires while a job is pending/dispatched/in_progress (authoritative
 *    check against the store on every evaluation) — so it can't clear mid-job.
 *  - Requires `minJobs` finished jobs since the last clear (skips fresh/empty
 *    sessions and avoids re-clearing an already-clear session).
 *  - Requires `idleMs` of no job activity, and honours a `cooldownMs` debounce.
 */
export class AutoClearManager {
  private readonly bus: SseBus;
  private readonly store: JobStore;
  private readonly sessions: SessionRegistry;
  private readonly clock: Clock;
  private readonly logger: Logger;
  private readonly enabled: boolean;
  private readonly idleMs: number;
  private readonly minJobs: number;
  private readonly cooldownMs: number;
  private readonly checkIntervalMs: number;
  private readonly keys: string;
  private readonly tmuxTarget?: string;
  private readonly command?: string;
  private readonly runner: (spec: ClearInjection) => void | Promise<void>;

  private readonly state = new Map<string, SessionState>();
  private readonly warnedNoTarget = new Set<string>();
  private unsubBus: (() => void) | null = null;
  private unsubDetached: (() => void) | null = null;
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;

  constructor(opts: AutoClearOptions) {
    this.bus = opts.bus;
    this.store = opts.store;
    this.sessions = opts.sessions;
    this.clock = opts.clock;
    this.logger = opts.logger;
    this.enabled = opts.enabled;
    this.idleMs = opts.idleMs;
    this.minJobs = opts.minJobs;
    this.cooldownMs = opts.cooldownMs;
    this.checkIntervalMs = opts.checkIntervalMs;
    this.keys = opts.keys;
    this.tmuxTarget = opts.tmuxTarget;
    this.command = opts.command;
    this.runner = opts.runner ?? ((spec) => this.defaultRunner(spec));
  }

  start(): void {
    if (!this.enabled || this.timer) return;

    this.unsubBus = this.bus.subscribe<JobEventData>('job.', (msg) => {
      this.onJobEvent(msg.topic, msg.data, msg.at);
    });
    this.unsubDetached = this.sessions.on('detached', ({ sessionId }) => {
      this.state.delete(sessionId);
      this.warnedNoTarget.delete(sessionId);
    });

    this.timer = setInterval(() => {
      void this.tick().catch((err) => {
        this.logger.error(
          { err: err instanceof Error ? err.message : String(err) },
          'auto-clear tick failed',
        );
      });
    }, this.checkIntervalMs);
    this.timer.unref?.();

    this.logger.info(
      {
        idleMs: this.idleMs,
        minJobs: this.minJobs,
        cooldownMs: this.cooldownMs,
        keys: this.keys,
        method: this.command ? 'command' : this.tmuxTarget ? 'tmux' : 'tmux-auto',
      },
      'auto-clear enabled',
    );
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.unsubBus?.();
    this.unsubBus = null;
    this.unsubDetached?.();
    this.unsubDetached = null;
    this.state.clear();
  }

  /** Record job activity so we can tell when a session has finished + gone idle. */
  private onJobEvent(topic: string, data: JobEventData, at: number): void {
    const s = this.stateFor(data.sessionId);
    s.lastActivityAt = at;
    // "finished a job" = completed or failed. Cancelled/expired/orphaned aren't
    // real work the session did, so they don't arm a clear on their own.
    if (topic === 'job.completed' || topic === 'job.failed') {
      s.finishedSinceClear += 1;
    }
  }

  /**
   * Evaluate every attached session and clear the ones that are idle after
   * finishing work. Public + reentrancy-guarded so tests can drive it directly.
   */
  async tick(): Promise<void> {
    if (!this.enabled || this.ticking) return;
    this.ticking = true;
    try {
      const now = this.clock.now();
      for (const session of this.sessions.list({ status: 'attached' })) {
        await this.maybeClear(session, now);
      }
    } finally {
      this.ticking = false;
    }
  }

  private async maybeClear(session: SessionHandle, now: number): Promise<void> {
    const s = this.state.get(session.id);
    if (!s) return; // no activity seen yet
    if (s.finishedSinceClear < this.minJobs) return;
    if (now - s.lastActivityAt < this.idleMs) return;
    if (s.lastClearAt > 0 && now - s.lastClearAt < this.cooldownMs) return;

    // Mid-job guard: authoritative check that nothing is in flight.
    const active = await this.store.list({
      session_id: session.id,
      status: ACTIVE_STATUSES,
      limit: 1,
    });
    if (active.items.length > 0) return;

    const spec: ClearInjection = {
      session,
      keys: this.keys,
      tmuxTarget: this.tmuxTarget,
      command: this.command,
    };

    try {
      await this.runner(spec);
    } catch (err) {
      this.logger.warn(
        {
          err: err instanceof Error ? err.message : String(err),
          sessionId: session.id,
          label: session.label,
        },
        'auto-clear injection failed',
      );
      return; // keep counters so we retry next tick
    }

    s.finishedSinceClear = 0;
    s.lastClearAt = now;
    this.logger.info(
      { sessionId: session.id, label: session.label, keys: this.keys },
      'auto-cleared idle session context',
    );
  }

  private stateFor(sessionId: string): SessionState {
    let s = this.state.get(sessionId);
    if (!s) {
      s = { finishedSinceClear: 0, lastActivityAt: this.clock.now(), lastClearAt: 0 };
      this.state.set(sessionId, s);
    }
    return s;
  }

  /** Default injection: a custom command if configured, else tmux send-keys. */
  private defaultRunner(spec: ClearInjection): void {
    if (spec.command) {
      this.runCommand(spec);
      return;
    }
    const target = spec.tmuxTarget ?? resolveTmuxTarget(spec.session.pid);
    if (!target) {
      if (!this.warnedNoTarget.has(spec.session.id)) {
        this.warnedNoTarget.add(spec.session.id);
        this.logger.warn(
          { sessionId: spec.session.id, label: spec.session.label, pid: spec.session.pid },
          'auto-clear armed but no tmux target resolved; set broker.auto_clear.tmux_target ' +
            'or broker.auto_clear.command (session must run under tmux for auto-detection)',
        );
      }
      throw new Error('no injection target');
    }
    tmuxSendKeys(target, spec.keys);
  }

  private runCommand(spec: ClearInjection): void {
    const res = spawnSync('/bin/sh', ['-c', spec.command as string], {
      env: {
        ...process.env,
        CLAUDE_BROKER_CLEAR_KEYS: spec.keys,
        CLAUDE_BROKER_SESSION_ID: spec.session.id,
        CLAUDE_BROKER_SESSION_LABEL: spec.session.label ?? '',
        CLAUDE_BROKER_SESSION_PID: spec.session.pid ? String(spec.session.pid) : '',
        CLAUDE_BROKER_TMUX_TARGET: spec.tmuxTarget ?? '',
      },
      timeout: 5_000,
    });
    if (res.status !== 0) {
      throw new Error(
        `clear command exited ${res.status ?? 'signal'}: ${
          res.stderr?.toString().trim() || 'no stderr'
        }`,
      );
    }
  }
}

/** Type the keys into a tmux pane, then submit with Enter. */
export function tmuxSendKeys(target: string, keys: string): void {
  const literal = spawnSync('tmux', ['send-keys', '-t', target, '-l', keys], {
    timeout: 5_000,
  });
  if (literal.error) throw literal.error;
  if (literal.status !== 0) {
    throw new Error(
      `tmux send-keys failed (${literal.status}): ${
        literal.stderr?.toString().trim() || 'no stderr'
      }`,
    );
  }
  const enter = spawnSync('tmux', ['send-keys', '-t', target, 'Enter'], {
    timeout: 5_000,
  });
  if (enter.error) throw enter.error;
  if (enter.status !== 0) {
    throw new Error(
      `tmux send-keys Enter failed (${enter.status}): ${
        enter.stderr?.toString().trim() || 'no stderr'
      }`,
    );
  }
}

/**
 * Best-effort: find the tmux pane hosting the process tree that contains `pid`
 * (the shim's pid — its ancestors are the `claude` process and the pane's shell).
 * Returns a `session:window.pane` target, or undefined if tmux isn't reachable
 * or no pane owns the process tree.
 */
export function resolveTmuxTarget(pid: number | null): string | undefined {
  if (!pid) return undefined;
  let paneByPid: Map<number, string>;
  try {
    const res = spawnSync(
      'tmux',
      ['list-panes', '-a', '-F', '#{pane_pid} #{session_name}:#{window_index}.#{pane_index}'],
      { encoding: 'utf8', timeout: 5_000 },
    );
    if (res.status !== 0 || !res.stdout) return undefined;
    paneByPid = new Map();
    for (const line of res.stdout.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const sp = trimmed.indexOf(' ');
      if (sp < 0) continue;
      const panePid = Number.parseInt(trimmed.slice(0, sp), 10);
      if (Number.isNaN(panePid)) continue;
      paneByPid.set(panePid, trimmed.slice(sp + 1));
    }
  } catch {
    return undefined;
  }

  // Walk the pid's ancestry until we hit a pane's root pid.
  let cur: number | null = pid;
  for (let i = 0; i < 32 && cur && cur > 1; i++) {
    const hit = paneByPid.get(cur);
    if (hit) return hit;
    cur = parentPid(cur);
  }
  return undefined;
}

/** Read PPID from /proc/<pid>/stat. Returns null if unavailable. */
function parentPid(pid: number): number | null {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    // Format: "pid (comm) state ppid ...". comm can contain spaces/parens, so
    // parse after the final ')'.
    const close = stat.lastIndexOf(')');
    if (close < 0) return null;
    const fields = stat.slice(close + 2).split(' ');
    const ppid = Number.parseInt(fields[1], 10);
    return Number.isNaN(ppid) ? null : ppid;
  } catch {
    return null;
  }
}
