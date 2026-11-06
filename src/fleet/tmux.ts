/**
 * The broker's OWN tmux server (`tmux -L <socket>`), never the default one.
 *
 * SAFETY: inside a tmux session `$TMUX` makes every bare `tmux` command target
 * THAT server, so a cleanup meant for a private server once killed an
 * operator's whole tmux. Every call here passes `-L` and strips TMUX/TMUX_PANE
 * from the environment, and this class has no kill-server method on purpose.
 */
import { spawnSync } from 'node:child_process';

export interface ExecResult {
  status: number;
  stdout: string;
  stderr: string;
}

export type TmuxExec = (args: string[]) => ExecResult;

export interface TmuxWindow {
  name: string;
  index: number;
  panePid: number | null;
  paneDead: boolean;
}

export function cleanTmuxEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out = { ...env };
  delete out.TMUX;
  delete out.TMUX_PANE;
  return out;
}

export function makeTmuxExec(socket: string, binary = 'tmux'): TmuxExec {
  return (args) => {
    const r = spawnSync(binary, ['-L', socket, ...args], {
      encoding: 'utf8',
      timeout: 10_000,
      env: cleanTmuxEnv(),
    });
    return {
      status: r.error ? 127 : (r.status ?? 1),
      stdout: r.stdout ?? '',
      stderr: r.error ? r.error.message : (r.stderr ?? ''),
    };
  };
}

export class Tmux {
  constructor(
    readonly socket: string,
    private readonly exec: TmuxExec,
  ) {}

  installed(): boolean {
    return this.exec(['-V']).status === 0;
  }

  hasSession(session: string): boolean {
    return this.exec(['has-session', '-t', `=${session}`]).status === 0;
  }

  /**
   * Create the session (detached, wide so long lines — URLs — don't wrap) with
   * an idle placeholder window that keeps it alive when no worker runs.
   */
  ensureSession(session: string, cwd: string): void {
    if (this.hasSession(session)) return;
    const r = this.exec(['new-session', '-d', '-s', session, '-n', '_idle', '-x', '500', '-y', '50', '-c', cwd, 'tail -f /dev/null']);
    if (r.status !== 0 && !this.hasSession(session)) throw new Error(`tmux new-session failed: ${r.stderr.trim()}`);
    // A dead pane stays visible (and readable) instead of closing the window.
    this.exec(['set-option', '-t', session, 'remain-on-exit', 'on']);
  }

  listWindows(session: string): TmuxWindow[] {
    const r = this.exec(['list-windows', '-t', `=${session}`, '-F', '#{window_index}\t#{window_name}\t#{pane_pid}\t#{pane_dead}']);
    if (r.status !== 0) return [];
    return r.stdout
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [index, name, pid, dead] = line.split('\t');
        return {
          index: Number(index),
          name: name ?? '',
          panePid: pid && /^\d+$/.test(pid) ? Number(pid) : null,
          paneDead: dead === '1',
        };
      });
  }

  newWindow(session: string, name: string, cwd: string, command: string): void {
    const r = this.exec(['new-window', '-d', '-t', `=${session}:`, '-n', name, '-c', cwd, command]);
    if (r.status !== 0) throw new Error(`tmux new-window failed: ${r.stderr.trim()}`);
  }

  respawnWindow(session: string, name: string, cwd: string, command: string): void {
    const r = this.exec(['respawn-window', '-k', '-t', `=${session}:${name}`, '-c', cwd, command]);
    if (r.status !== 0) throw new Error(`tmux respawn-window failed: ${r.stderr.trim()}`);
  }

  killWindow(session: string, name: string): void {
    this.exec(['kill-window', '-t', `=${session}:${name}`]);
  }

  /** Visible pane text; `join` joins tmux-wrapped lines. */
  capture(session: string, name: string, join = false): string | null {
    const r = this.exec(['capture-pane', '-p', ...(join ? ['-J'] : []), '-t', `=${session}:${name}`]);
    return r.status === 0 ? r.stdout : null;
  }

  sendKey(session: string, name: string, key: string): void {
    this.exec(['send-keys', '-t', `=${session}:${name}`, key]);
  }

  /** Type literal text (no key-name interpretation). Submit separately with sendKey(Enter). */
  sendText(session: string, name: string, text: string): void {
    this.exec(['send-keys', '-t', `=${session}:${name}`, '-l', text]);
  }
}
