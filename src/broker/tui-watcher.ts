/**
 * TuiWatcher — keeps every attached session's `tuiState` current and nudges
 * sessions whose job sits undelivered.
 *
 * Fleet-managed sessions are classified by the FleetManager (it owns their
 * windows). Other sessions are found through their pid → tmux pane
 * (resolveTmuxTarget) and only READ (capture-pane) — unless the operator
 * opted in to nudging them (`broker.nudge.enabled`).
 *
 * Nudge: an idle Claude TUI does not always wake on a pushed channel event
 * (CivicGate's assistant-nudge supervisor exists for this). When a job has
 * been `dispatched` longer than `after_sec` and the pane shows the idle
 * prompt, the broker types an instruction + a separate Enter.
 */
import { spawnSync } from 'node:child_process';
import type { Clock } from '../ports/clock.js';
import type { JobStore } from '../ports/job-store.js';
import type { Logger } from '../ports/logger.js';
import type { SessionRegistry } from './session-registry.js';
import { resolveTmuxTarget } from './auto-clear.js';
import { classifyPane } from '../fleet/tui-state.js';
import type { FleetManager } from '../fleet/fleet-manager.js';

export interface NudgeConfig {
  /** Nudge sessions the broker does NOT manage (keystrokes into foreign panes — opt in). */
  enabled: boolean;
  /** Nudge fleet-managed sessions (also gated by the fleet spec's `nudge`). */
  managed: boolean;
  afterSec: number;
  cooldownSec: number;
  text: string;
}

export interface TuiWatcherOptions {
  sessions: SessionRegistry;
  store: JobStore;
  clock: Clock;
  logger: Logger;
  fleet: FleetManager | null;
  intervalMs: number;
  watchUnmanaged: boolean;
  nudge: NudgeConfig;
  /** Overrides for tests. */
  resolveTarget?: (pid: number | null) => string | undefined;
  capture?: (target: string) => string | null;
  sendKeys?: (target: string, text: string) => void;
}

const TARGET_TTL_MS = 60_000;

function defaultCapture(target: string): string | null {
  const r = spawnSync('tmux', ['capture-pane', '-p', '-t', target], { encoding: 'utf8', timeout: 5_000 });
  return r.status === 0 ? r.stdout : null;
}

function defaultSendKeys(target: string, text: string): void {
  spawnSync('tmux', ['send-keys', '-t', target, '-l', text], { timeout: 5_000 });
  setTimeout(() => spawnSync('tmux', ['send-keys', '-t', target, 'Enter'], { timeout: 5_000 }), 800).unref?.();
}

export class TuiWatcher {
  private timer: NodeJS.Timeout | null = null;
  private readonly targets = new Map<string, { target: string | undefined; at: number }>();
  private readonly lastNudge = new Map<string, number>();

  constructor(private readonly o: TuiWatcherOptions) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.tick().catch((err) => this.o.logger.warn({ err: (err as Error).message }, 'tui watcher tick failed'));
    }, this.o.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private target(id: string, pid: number | null): string | undefined {
    const now = this.o.clock.now();
    const hit = this.targets.get(id);
    if (hit && now - hit.at < TARGET_TTL_MS) return hit.target;
    const target = (this.o.resolveTarget ?? resolveTmuxTarget)(pid);
    this.targets.set(id, { target, at: now });
    return target;
  }

  async tick(): Promise<void> {
    const now = this.o.clock.now();
    for (const s of this.o.sessions.list({ status: 'attached' })) {
      const managed = this.o.fleet?.isManaged(s.id) ?? false;
      if (managed) s.managed = true;
      if (!managed && this.o.watchUnmanaged) {
        const target = this.target(s.id, s.pid);
        if (target) {
          const pane = (this.o.capture ?? defaultCapture)(target);
          if (pane !== null) {
            const cls = classifyPane(pane);
            this.o.sessions.setTui(s.id, cls.state, cls.detail, now);
          }
        }
      }
      await this.maybeNudge(s.id, s.pid, managed, now);
    }
  }

  private async maybeNudge(id: string, pid: number | null, managed: boolean, now: number): Promise<void> {
    const n = this.o.nudge;
    const allowed = managed ? n.managed && (this.o.fleet?.getSpec().nudge ?? false) : n.enabled;
    if (!allowed) return;
    const s = this.o.sessions.get(id);
    if (!s || s.tuiState !== 'ready') return;
    if (now - (this.lastNudge.get(id) ?? 0) < n.cooldownSec * 1000) return;
    const waiting = await this.o.store.list({ session_id: id, status: 'dispatched', limit: 5 });
    const stale = waiting.items.some((j) => j.dispatched_at !== null && now - j.dispatched_at > n.afterSec * 1000);
    if (!stale) return;
    this.lastNudge.set(id, now);
    if (managed) {
      const label = this.o.fleet?.labelFor(id);
      if (label) this.o.fleet?.sendInstruction(label, n.text);
    } else {
      const target = this.target(id, pid);
      if (!target) return;
      (this.o.sendKeys ?? defaultSendKeys)(target, n.text);
    }
    this.o.logger.info({ sessionId: id, managed }, 'nudged an idle session with an undelivered job');
  }
}
