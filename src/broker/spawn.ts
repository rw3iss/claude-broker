import { spawn } from 'node:child_process';
import type { Clock } from '../ports/clock.js';
import type { Logger } from '../ports/logger.js';
import type { SessionRegistry } from './session-registry.js';
import { TimeoutError } from '../lib/errors.js';

export interface SpawnSessionOptions {
  label: string;
  cwd?: string;
  env?: Record<string, string>;
}

export interface SpawnHelperOptions {
  sessions: SessionRegistry;
  clock: Clock;
  logger: Logger;
  /** Path to the `claude` binary; defaults to "claude" on PATH. */
  claudeBinary?: string;
  /** Channel passed to `--dangerously-load-development-channels`; default `server:claude-broker`. */
  channelArg?: string;
  /** How long to wait for the shim to attach. */
  timeoutMs?: number;
  /** Polling interval for attach detection. */
  pollIntervalMs?: number;
}

/**
 * Best-effort helper that shells out to `claude --dangerously-load-development-channels <arg>` and
 * waits for a shim with the given label to attach. The registered `claude-broker` shim MCP server
 * (see `claude mcp add`) provides the job tools; the dev-channels flag is what authorizes the
 * `server:` channel so Claude injects the pushed events. NOTE: this launch shows a one-time
 * "Loading development channels" confirmation that must be ACCEPTED to set the channel's `dev`
 * flag — which a headless (no-pty) spawn can't do. So this helper is best-effort only; prefer
 * launching `claude --dangerously-skip-permissions --dangerously-load-development-channels
 * server:claude-broker` yourself (in tmux) and accepting the prompt. See the README.
 */
export function makeSpawnHelper(opts: SpawnHelperOptions) {
  const claudeBinary = opts.claudeBinary ?? 'claude';
  const channelArg = opts.channelArg ?? 'server:claude-broker';
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const pollIntervalMs = opts.pollIntervalMs ?? 250;

  return async function spawnSession(
    input: SpawnSessionOptions,
  ): Promise<{ sessionId: string }> {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...(input.env ?? {}),
      CLAUDE_BROKER_SESSION_LABEL: input.label,
    };

    const child = spawn(claudeBinary, ['--dangerously-load-development-channels', channelArg], {
      cwd: input.cwd,
      env,
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    child.on('error', (err) => {
      opts.logger.warn(
        { err: err.message, label: input.label },
        'spawned claude exited with error',
      );
    });

    opts.logger.info(
      { pid: child.pid, label: input.label, binary: claudeBinary },
      'spawned claude session',
    );

    const deadline = opts.clock.now() + timeoutMs;
    while (opts.clock.now() < deadline) {
      const match = opts.sessions.findByLabel(input.label);
      if (match) return { sessionId: match.id };
      await new Promise((r) => setTimeout(r, pollIntervalMs));
    }
    throw new TimeoutError(
      `timed out waiting for session label="${input.label}" to attach`,
    );
  };
}
