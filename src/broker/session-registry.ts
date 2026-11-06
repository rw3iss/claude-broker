import { EventEmitter } from 'node:events';
import type { Clock } from '../ports/clock.js';
import type { SessionEvent, SessionStatus } from '../ports/types.js';
import type { TuiState } from '../fleet/tui-state.js';
import { inPool } from '../fleet/routing.js';

export interface SessionHandle {
  id: string;
  label: string | null;
  metadata: Record<string, string>;
  pid: number | null;
  status: SessionStatus;
  registeredAt: number;
  lastHeartbeatAt: number;
  /** Opaque transport handle the SocketServer hangs on the session. */
  transport?: unknown;
  /** What the session's terminal shows (TuiWatcher / FleetManager); unset = unknown. */
  tuiState?: TuiState;
  tuiDetail?: string | null;
  tuiCheckedAt?: number | null;
  /** Launched and supervised by the broker's fleet. */
  managed?: boolean;
  /** When routing last chose this session (ties go to the least recent). */
  lastDispatchAt?: number | null;
}

export interface RegisterInput {
  id: string;
  label?: string | null;
  metadata?: Record<string, string>;
  pid?: number | null;
  transport?: unknown;
}

export interface SessionRegistryEvents {
  attached: (e: { session: SessionHandle; at: number }) => void;
  detached: (e: { sessionId: string; at: number; reason?: string }) => void;
}

export class SessionRegistry {
  private readonly clock: Clock;
  private readonly sessions = new Map<string, SessionHandle>();
  private readonly emitter = new EventEmitter();

  constructor(clock: Clock) {
    this.clock = clock;
  }

  register(input: RegisterInput): SessionHandle {
    const now = this.clock.now();
    const existing = this.sessions.get(input.id);
    if (existing) {
      // Re-attach overrides — see plan §5.4.
      existing.label = input.label ?? existing.label;
      existing.metadata = input.metadata ?? existing.metadata;
      existing.pid = input.pid ?? existing.pid;
      existing.transport = input.transport ?? existing.transport;
      existing.status = 'attached';
      existing.lastHeartbeatAt = now;
      this.emitter.emit('attached', { session: existing, at: now });
      return existing;
    }

    const handle: SessionHandle = {
      id: input.id,
      label: input.label ?? null,
      metadata: input.metadata ?? {},
      pid: input.pid ?? null,
      status: 'attached',
      registeredAt: now,
      lastHeartbeatAt: now,
      transport: input.transport,
    };
    this.sessions.set(input.id, handle);
    this.emitter.emit('attached', { session: handle, at: now });
    return handle;
  }

  detach(sessionId: string, reason?: string): boolean {
    const existing = this.sessions.get(sessionId);
    if (!existing || existing.status === 'detached') return false;
    existing.status = 'detached';
    existing.transport = undefined;
    const at = this.clock.now();
    this.emitter.emit('detached', { sessionId, at, reason });
    return true;
  }

  /** Remove from the registry entirely (no event). Used after detach grace. */
  remove(sessionId: string): boolean {
    return this.sessions.delete(sessionId);
  }

  heartbeat(sessionId: string): boolean {
    const existing = this.sessions.get(sessionId);
    if (!existing) return false;
    existing.lastHeartbeatAt = this.clock.now();
    return true;
  }

  get(sessionId: string): SessionHandle | null {
    return this.sessions.get(sessionId) ?? null;
  }

  /** Record what the session's terminal shows. */
  setTui(sessionId: string, state: TuiState, detail: string | null, at: number): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    s.tuiState = state;
    s.tuiDetail = detail;
    s.tuiCheckedAt = at;
  }

  /** Attached sessions a label (exact) or pool (`<pool>` / `<pool>-<n>`) addresses. */
  candidates(by: { label?: string; pool?: string }): SessionHandle[] {
    return [...this.sessions.values()].filter((s) => {
      if (s.status !== 'attached') return false;
      if (by.label !== undefined) return s.label === by.label;
      if (by.pool !== undefined) return inPool(s.label, by.pool);
      return false;
    });
  }

  /** First attached session matching label. */
  findByLabel(label: string): SessionHandle | null {
    for (const s of this.sessions.values()) {
      if (s.status === 'attached' && s.label === label) return s;
    }
    return null;
  }

  list(filter: { status?: SessionStatus; label?: string } = {}): SessionHandle[] {
    return [...this.sessions.values()].filter((s) => {
      if (filter.status && s.status !== filter.status) return false;
      if (filter.label !== undefined && s.label !== filter.label) return false;
      return true;
    });
  }

  /** Evict sessions whose last heartbeat is older than the timeout. */
  evictStale(timeoutMs: number): SessionHandle[] {
    const now = this.clock.now();
    const evicted: SessionHandle[] = [];
    for (const s of this.sessions.values()) {
      if (s.status !== 'attached') continue;
      if (now - s.lastHeartbeatAt > timeoutMs) {
        s.status = 'detached';
        s.transport = undefined;
        this.emitter.emit('detached', {
          sessionId: s.id,
          at: now,
          reason: 'heartbeat_timeout',
        });
        evicted.push(s);
      }
    }
    return evicted;
  }

  on<K extends keyof SessionRegistryEvents>(
    event: K,
    listener: SessionRegistryEvents[K],
  ): () => void {
    this.emitter.on(event, listener as (...args: unknown[]) => void);
    return () =>
      this.emitter.off(event, listener as (...args: unknown[]) => void);
  }

  events(): AsyncIterable<SessionEvent> {
    const queue: SessionEvent[] = [];
    const wakers: Array<() => void> = [];
    const offAttached = this.on('attached', ({ session, at }) => {
      queue.push({ kind: 'session.attached', sessionId: session.id, at });
      wakers.shift()?.();
    });
    const offDetached = this.on('detached', ({ sessionId, at, reason }) => {
      queue.push({ kind: 'session.detached', sessionId, at, reason });
      wakers.shift()?.();
    });

    return {
      [Symbol.asyncIterator](): AsyncIterator<SessionEvent> {
        return {
          async next() {
            if (queue.length === 0) {
              await new Promise<void>((resolve) => wakers.push(resolve));
            }
            const value = queue.shift();
            if (!value) return { value: undefined, done: true };
            return { value, done: false };
          },
          async return() {
            offAttached();
            offDetached();
            return { value: undefined, done: true };
          },
        };
      },
    };
  }
}
