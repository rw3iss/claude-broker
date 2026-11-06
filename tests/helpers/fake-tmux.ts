/**
 * In-memory stand-in for the broker's private tmux server: records every
 * command, tracks windows, and serves pane text the test sets.
 */
import type { ExecResult, TmuxExec } from '../../src/fleet/tmux.js';

export interface FakeWindow {
  name: string;
  index: number;
  pid: number;
  dead: boolean;
  pane: string;
  command: string;
}

export class FakeTmux {
  sessions = new Set<string>();
  windows = new Map<string, FakeWindow>();
  keys: Array<{ window: string; key: string; literal: boolean }> = [];
  calls: string[][] = [];
  installed = true;
  private nextPid = 1000;
  private nextIndex = 1;

  /** Called after a window is created (lets a test print the program's first output). */
  onNewWindow: ((w: FakeWindow) => void) | null = null;
  /** Called when keys are sent to a window (lets a test script the pane's reaction). */
  onKey: ((w: FakeWindow, key: string, literal: boolean) => void) | null = null;

  exec: TmuxExec = (args) => {
    this.calls.push(args);
    const ok = (stdout = ''): ExecResult => ({ status: 0, stdout, stderr: '' });
    const fail = (stderr = 'no such thing'): ExecResult => ({ status: 1, stdout: '', stderr });
    if (!this.installed) return { status: 127, stdout: '', stderr: 'tmux: not found' };
    const [cmd, ...rest] = args;
    const opt = (flag: string): string | undefined => {
      const i = rest.indexOf(flag);
      return i >= 0 ? rest[i + 1] : undefined;
    };
    const winOf = (target: string | undefined): string => (target ?? '').split(':').slice(1).join(':');
    switch (cmd) {
      case '-V':
        return ok('tmux 3.4');
      case 'has-session':
        return this.sessions.has((opt('-t') ?? '').replace(/^=/, '')) ? ok() : fail();
      case 'new-session':
        this.sessions.add(opt('-s') ?? '');
        this.windows.set('_idle', { name: '_idle', index: 0, pid: this.nextPid++, dead: false, pane: '', command: '' });
        return ok();
      case 'set-option':
        return ok();
      case 'list-windows':
        return ok(
          [...this.windows.values()]
            .map((w) => `${w.index}\t${w.name}\t${w.pid}\t${w.dead ? 1 : 0}`)
            .join('\n') + '\n',
        );
      case 'new-window': {
        const name = opt('-n') ?? '';
        if (this.windows.has(name)) return fail('duplicate window');
        const w = { name, index: this.nextIndex++, pid: this.nextPid++, dead: false, pane: '', command: rest[rest.length - 1] ?? '' };
        this.windows.set(name, w);
        this.onNewWindow?.(w);
        return ok();
      }
      case 'respawn-window': {
        const w = this.windows.get(winOf(opt('-t')));
        if (!w) return fail();
        w.dead = false;
        w.pid = this.nextPid++;
        w.pane = '';
        w.command = rest[rest.length - 1] ?? '';
        return ok();
      }
      case 'kill-window':
        this.windows.delete(winOf(opt('-t')));
        return ok();
      case 'capture-pane': {
        const w = this.windows.get(winOf(opt('-t')));
        return w ? ok(w.pane) : fail();
      }
      case 'send-keys': {
        const target = winOf(opt('-t'));
        const w = this.windows.get(target);
        if (!w) return fail();
        const literal = rest.includes('-l');
        const key = rest[rest.length - 1] ?? '';
        this.keys.push({ window: target, key, literal });
        this.onKey?.(w, key, literal);
        return ok();
      }
      case 'kill-server':
        throw new Error('kill-server must never be called');
      default:
        return fail(`unknown command ${cmd}`);
    }
  };
}
