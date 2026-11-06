/**
 * Everything needed to launch ONE managed Claude Code session — the lessons of
 * CivicGate's launcher, in one place:
 *  - absolute shim path in a per-session MCP config (a bare `claude-broker`
 *    resolved against a boot-time PATH silently failed: 9 sessions, 0 attached);
 *  - PATH with ~/.local/bin;
 *  - ENABLE_TOOL_SEARCH=false (else after /clear "I don't have a complete_job tool");
 *  - a long-lived `claude setup-token` token sourced INSIDE the window from a
 *    0600 env file (shared ~/.claude credentials refreshed by N sessions got
 *    blanked → "Login expired"), never on a command line;
 *  - a neutral, pre-trusted working dir (a repo's CLAUDE.md rode along in every job);
 *  - worker settings via --settings (skipDangerousModePermissionPrompt, model, effort);
 *  - --strict-mcp-config + --dangerously-load-development-channels.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { writeFileAtomic, type DesiredSession } from './spec.js';

export function homeDir(): string {
  return process.env.HOME || os.homedir();
}

function isExecutable(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** First executable `name` among the configured path, the usual install spots, then PATH. */
export function findBinary(name: string, configured?: string): string | null {
  const h = homeDir();
  const candidates = [
    configured,
    path.join(h, '.local', 'bin', name),
    path.join(h, '.claude', 'local', name),
    path.join('/usr/local/bin', name),
    path.join('/usr/bin', name),
    ...String(process.env.PATH ?? '').split(':').filter(Boolean).map((d) => path.join(d, name)),
  ].filter((c): c is string => Boolean(c));
  for (const c of candidates) if (path.isAbsolute(c) && isExecutable(c)) return c;
  return null;
}

let versionCache: { bin: string; version: string | null; at: number } | null = null;

/** `claude --version`, cached 10 min. */
export function claudeVersion(bin: string | null): string | null {
  if (!bin) return null;
  if (versionCache && versionCache.bin === bin && Date.now() - versionCache.at < 600_000) return versionCache.version;
  const r = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 10_000 });
  const version = r.status === 0 ? (r.stdout.trim().split('\n')[0] ?? null) : null;
  versionCache = { bin, version, at: Date.now() };
  return version;
}

/**
 * How the shim is launched from a session's MCP config: `node <bin> shim`
 * with ABSOLUTE paths, so no PATH lookup can fail. Override with
 * `fleet.shim_command` (a whitespace-separated command line).
 */
export function shimCommand(override?: string): { command: string; args: string[] } {
  if (override) {
    const parts = override.trim().split(/\s+/);
    return { command: parts[0] ?? 'claude-broker', args: parts.slice(1) };
  }
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const bin = path.join(dir, 'bin', 'claude-broker');
    if (fs.existsSync(bin)) return { command: process.execPath, args: [bin, 'shim'] };
    dir = path.dirname(dir);
  }
  const found = findBinary('claude-broker');
  return found ? { command: found, args: ['shim'] } : { command: 'claude-broker', args: ['shim'] };
}

/** Claude Code's global config file (CLAUDE_CONFIG_DIR aware). */
export function claudeConfigFile(): string {
  const dir = process.env.CLAUDE_CONFIG_DIR;
  return dir ? path.join(dir, '.claude.json') : path.join(homeDir(), '.claude.json');
}

/**
 * Pre-trust `dir` so a fresh session never stops at "Do you trust this
 * folder?". Writes only when needed, atomically; leaves every other key alone.
 */
export function preTrustDir(dir: string, configFile = claudeConfigFile()): boolean {
  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(fs.readFileSync(configFile, 'utf8')) as Record<string, unknown>;
  } catch {
    data = {};
  }
  const projects = (data.projects && typeof data.projects === 'object' ? data.projects : {}) as Record<string, Record<string, unknown>>;
  const p = projects[dir] ?? {};
  if (p.hasTrustDialogAccepted === true && p.hasCompletedProjectOnboarding === true) return false;
  projects[dir] = { ...p, hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true };
  data.projects = projects;
  let mode = 0o600;
  try {
    mode = fs.statSync(configFile).mode & 0o777;
  } catch {
    /* new file */
  }
  writeFileAtomic(configFile, JSON.stringify(data, null, 2), mode);
  return true;
}

export interface FleetPaths {
  stateDir: string;
  oauthEnv: string;
  workdir: string;
}

export interface LaunchInputs {
  session: DesiredSession;
  paths: FleetPaths;
  cwd: string;
  claudeBin: string;
  socketPath: string;
  brokerToken: string;
  shim: { command: string; args: string[] };
}

export function sessionId(label: string): string {
  return `fleet-${label}`;
}

/** Worker settings for `--settings` (the CivicGate worker settings, minus personal bits). */
export function workerSettings(session: DesiredSession): Record<string, unknown> {
  return {
    skipDangerousModePermissionPrompt: true,
    permissions: { defaultMode: 'bypassPermissions' },
    autoCompactEnabled: true,
    promptSuggestionEnabled: false,
    awaySummaryEnabled: false,
    fileCheckpointingEnabled: false,
    ...(session.model ? { model: session.model } : {}),
    ...(session.effort ? { effortLevel: session.effort } : {}),
  };
}

export function mcpConfig(inp: LaunchInputs): Record<string, unknown> {
  return {
    mcpServers: {
      'claude-broker': {
        type: 'stdio',
        command: inp.shim.command,
        args: inp.shim.args,
        env: {
          CLAUDE_BROKER_SOCKET: inp.socketPath,
          CLAUDE_BROKER_SESSION_LABEL: inp.session.label,
          CLAUDE_BROKER_SESSION_ID: sessionId(inp.session.label),
          CLAUDE_BROKER_TOKEN: inp.brokerToken,
        },
      },
    },
  };
}

const q = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/** The shell command a window runs. Secrets stay in files; nothing sensitive is on the command line. */
export function launchCommand(inp: LaunchInputs, files: { mcp: string; settings: string }): string {
  const h = homeDir();
  return [
    `[ -f ${q(inp.paths.oauthEnv)} ] && { set -a; . ${q(inp.paths.oauthEnv)}; set +a; }`,
    `export PATH=${q(path.join(h, '.local', 'bin'))}:"$PATH"`,
    `export ENABLE_TOOL_SEARCH=false CLAUDE_BROKER_SESSION_LABEL=${q(inp.session.label)} CLAUDE_BROKER_SESSION_ID=${q(sessionId(inp.session.label))}`,
    `exec ${q(inp.claudeBin)} --strict-mcp-config --mcp-config ${q(files.mcp)} --settings ${q(files.settings)} --dangerously-skip-permissions --dangerously-load-development-channels server:claude-broker`,
  ].join('; ');
}

/** Write the session's MCP config + settings (0600) and return the command to run. */
export function prepareLaunch(inp: LaunchInputs): string {
  const dir = path.join(inp.paths.stateDir, 'sessions');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const mcp = path.join(dir, `${inp.session.label}.mcp.json`);
  const settings = path.join(dir, `${inp.session.label}.settings.json`);
  writeFileAtomic(mcp, JSON.stringify(mcpConfig(inp), null, 2));
  writeFileAtomic(settings, JSON.stringify(workerSettings(inp.session), null, 2));
  return launchCommand(inp, { mcp, settings });
}
