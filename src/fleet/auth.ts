/**
 * Claude sign-in for the managed sessions: a long-lived token from
 * `claude setup-token`, stored as CLAUDE_CODE_OAUTH_TOKEN in a 0600 env file
 * that every fleet window sources.
 *
 * `setup-token` is an interactive TUI and prints NOTHING without a terminal,
 * so it runs in a window of the broker's private tmux server (500 columns, so
 * the long sign-in URL stays on one line). The operator opens the URL, signs
 * in, pastes the code back (`submitCode`); the token is read off the pane and
 * the window is killed at once. The token is never logged or returned.
 * State lives in tmux + files, so any caller (HTTP, CLI) can continue a login.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Clock } from '../ports/clock.js';
import type { Logger } from '../ports/logger.js';
import { ConflictError, ValidationError } from '../lib/errors.js';
import { stripAnsi } from './tui-state.js';
import type { Tmux } from './tmux.js';
import { writeFileAtomic } from './spec.js';

export const AUTH_WINDOW = '_auth';
const TOKEN_TTL_MS = 365 * 24 * 3600 * 1000;

/** Find the sign-in URL in setup-token output (rejoins a URL the app wrapped itself). */
export function extractLoginUrl(raw: string): string | null {
  const text = stripAnsi(raw);
  const lines = text.split('\n');
  const start = lines.findIndex((l) => /https:\/\/\S*oauth\/authorize/.test(l));
  if (start < 0) return null;
  let url = (lines[start] ?? '').slice((lines[start] ?? '').indexOf('https://')).trim();
  // Continuation lines: no spaces, until a blank line.
  for (let i = start + 1; i < lines.length; i++) {
    const l = (lines[i] ?? '').trim();
    if (!l || /\s/.test(l) || /^https?:/.test(l)) break;
    url += l;
  }
  url = url.replace(/[\s\x07]+/g, '');
  return /^https:\/\/[^\s"'<>]+$/.test(url) ? url : null;
}

/** The token setup-token prints on success (rejoined if a narrow pane wrapped it). */
export function extractToken(raw: string): string | null {
  const lines = stripAnsi(raw).split('\n').map((l) => l.trim());
  for (let i = 0; i < lines.length; i++) {
    const m = /sk-ant-oat[0-9A-Za-z_-]*/.exec(lines[i] ?? '');
    if (!m) continue;
    let token = m[0];
    // The token runs to the end of its line → continuation lines are pure token characters.
    let j = i;
    while ((lines[j] ?? '').endsWith(token.slice(-8)) && /^[0-9A-Za-z_-]+$/.test(lines[j + 1] ?? '')) {
      token += lines[j + 1];
      j++;
    }
    if (token.length >= 30) return token;
  }
  return null;
}

export function extractOAuthError(raw: string): string | null {
  const line = stripAnsi(raw).split('\n').find((l) => /OAuth error|Invalid code|Error:/i.test(l));
  return line ? line.trim().slice(0, 300) : null;
}

function countErrors(raw: string): number {
  return (stripAnsi(raw).match(/OAuth error/gi) ?? []).length;
}

function lastOAuthError(raw: string): string {
  const lines = stripAnsi(raw).split('\n').filter((l) => /OAuth error/i.test(l));
  return (lines.pop() ?? 'OAuth error').trim().slice(0, 300);
}

export interface TokenInfo {
  set: boolean;
  created_at: string | null;
  expires_at: string | null;
}

export interface LoginInfo {
  pending: boolean;
  url: string | null;
  started_at: string | null;
  error: string | null;
}

export interface AuthManagerOptions {
  tmux: Tmux;
  session: string;
  oauthEnv: string;
  workdir: string;
  claudeBin: () => string | null;
  clock: Clock;
  logger: Logger;
  /** Called after a new token is saved (respawn sessions that needed a login). */
  onTokenSaved?: () => void;
  /** Poll interval / overall waits (tests shorten these). */
  pollMs?: number;
  urlWaitMs?: number;
  codeWaitMs?: number;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class AuthManager {
  private startedAt: number | null = null;
  private lastError: string | null = null;
  private url: string | null = null;

  constructor(private readonly o: AuthManagerOptions) {}

  private metaFile(): string {
    return `${this.o.oauthEnv}.meta.json`;
  }

  token(): TokenInfo {
    let set = false;
    try {
      set = /^CLAUDE_CODE_OAUTH_TOKEN=\S+/m.test(fs.readFileSync(this.o.oauthEnv, 'utf8'));
    } catch {
      set = false;
    }
    if (!set) return { set: false, created_at: null, expires_at: null };
    let created: number | null = null;
    try {
      created = Number((JSON.parse(fs.readFileSync(this.metaFile(), 'utf8')) as { created_at?: number }).created_at) || null;
    } catch {
      try {
        created = fs.statSync(this.o.oauthEnv).mtimeMs;
      } catch {
        created = null;
      }
    }
    return {
      set: true,
      created_at: created ? new Date(created).toISOString() : null,
      expires_at: created ? new Date(created + TOKEN_TTL_MS).toISOString() : null,
    };
  }

  /** Token file mtime (ms) — the fleet respawns login_required sessions started before it. */
  tokenSavedAt(): number | null {
    try {
      return fs.statSync(this.o.oauthEnv).mtimeMs;
    } catch {
      return null;
    }
  }

  private windowAlive(): boolean {
    return this.o.tmux.listWindows(this.o.session).some((w) => w.name === AUTH_WINDOW && !w.paneDead);
  }

  login(): LoginInfo {
    const pending = this.windowAlive();
    if (!pending && this.startedAt) {
      this.startedAt = null;
      this.url = null;
    }
    return {
      pending,
      url: pending ? this.url ?? extractLoginUrl(this.o.tmux.capture(this.o.session, AUTH_WINDOW, true) ?? '') : null,
      started_at: pending && this.startedAt ? new Date(this.startedAt).toISOString() : null,
      error: this.lastError,
    };
  }

  /** Start `claude setup-token` and resolve with the sign-in URL. */
  async start(): Promise<{ url: string }> {
    const claude = this.o.claudeBin();
    if (!claude) throw new ConflictError('Claude Code is not installed on this machine (claude not found)');
    if (!this.o.tmux.installed()) throw new ConflictError('tmux is not installed on this machine');
    this.cancel();
    this.lastError = null;
    this.o.tmux.ensureSession(this.o.session, this.o.workdir);
    const q = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;
    // Without our own token in the env, so setup-token never reuses a stale one.
    this.o.tmux.newWindow(this.o.session, AUTH_WINDOW, this.o.workdir, `env -u CLAUDE_CODE_OAUTH_TOKEN BROWSER=true ${q(claude)} setup-token`);
    this.startedAt = this.o.clock.now();
    const deadline = Date.now() + (this.o.urlWaitMs ?? 30_000);
    while (Date.now() < deadline) {
      await sleep(this.o.pollMs ?? 500);
      const pane = this.o.tmux.capture(this.o.session, AUTH_WINDOW, true) ?? '';
      const url = extractLoginUrl(pane);
      if (url) {
        this.url = url;
        return { url };
      }
      if (!this.windowAlive()) break;
    }
    const pane = this.o.tmux.capture(this.o.session, AUTH_WINDOW, true) ?? '';
    this.cancel();
    this.lastError = (stripAnsi(pane).trim().split('\n').filter(Boolean).pop() ?? '').slice(0, 300) || 'claude setup-token printed no sign-in link';
    throw new ConflictError(`Could not start the sign-in: ${this.lastError}`);
  }

  /**
   * Type the code from the sign-in page into the waiting setup-token. On a bad
   * code Claude Code offers a retry with a NEW link: we press Enter and return
   * it (`retry: true, url`).
   */
  async submitCode(code: string): Promise<{ ok: true; token: TokenInfo }> {
    const c = String(code ?? '').trim();
    if (!c || c.length > 2048 || /[\r\n\0]/.test(c)) throw new ValidationError('paste the code shown after signing in');
    if (!this.windowAlive()) throw new ValidationError('no sign-in is waiting — start one first', { retry: false });
    const errorsBefore = countErrors(this.o.tmux.capture(this.o.session, AUTH_WINDOW, true) ?? '');
    this.o.tmux.sendText(this.o.session, AUTH_WINDOW, c);
    await sleep(this.o.pollMs ?? 300);
    this.o.tmux.sendKey(this.o.session, AUTH_WINDOW, 'Enter');
    const deadline = Date.now() + (this.o.codeWaitMs ?? 45_000);
    while (Date.now() < deadline) {
      await sleep(this.o.pollMs ?? 500);
      const pane = this.o.tmux.capture(this.o.session, AUTH_WINDOW, true) ?? '';
      const token = extractToken(pane);
      if (token) {
        this.saveToken(token);
        this.cancel();
        this.o.logger.info({}, 'claude sign-in: long-lived token saved');
        this.o.onTokenSaved?.();
        return { ok: true, token: this.token() };
      }
      const err = countErrors(pane) > errorsBefore ? lastOAuthError(pane) : null;
      if (err) {
        this.lastError = err;
        // "Press Enter to retry" → a fresh sign-in link.
        this.url = null;
        this.o.tmux.sendKey(this.o.session, AUTH_WINDOW, 'Enter');
        let url: string | null = null;
        const until = Date.now() + 15_000;
        while (Date.now() < until && !url) {
          await sleep(this.o.pollMs ?? 500);
          const p2 = this.o.tmux.capture(this.o.session, AUTH_WINDOW, true) ?? '';
          const u = extractLoginUrl(p2.slice(Math.max(0, p2.lastIndexOf('OAuth error'))));
          if (u) url = u;
        }
        this.url = url;
        throw new ValidationError(err, { retry: Boolean(url), url });
      }
      if (!this.windowAlive()) break;
    }
    this.lastError = 'Claude Code did not return a token';
    throw new ValidationError(this.lastError, { retry: false });
  }

  cancel(): void {
    if (this.o.tmux.listWindows(this.o.session).some((w) => w.name === AUTH_WINDOW)) {
      this.o.tmux.killWindow(this.o.session, AUTH_WINDOW);
    }
    this.startedAt = null;
    this.url = null;
  }

  removeToken(): void {
    fs.rmSync(this.o.oauthEnv, { force: true });
    fs.rmSync(this.metaFile(), { force: true });
  }

  private saveToken(token: string): void {
    fs.mkdirSync(path.dirname(this.o.oauthEnv), { recursive: true, mode: 0o700 });
    writeFileAtomic(this.o.oauthEnv, `CLAUDE_CODE_OAUTH_TOKEN=${token}\n`, 0o600);
    writeFileAtomic(this.metaFile(), JSON.stringify({ created_at: this.o.clock.now() }), 0o600);
  }
}
