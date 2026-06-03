import path from 'node:path';
import type { Config } from '../../config/schema.js';

/**
 * Resolve the session-log root directory. Precedence:
 *   CLAUDE_BROKER_LOG_DIR env  >  config.logging.sessions.dir  >  zod default.
 *
 * Both the daemon (writer) and the `claude-broker logs` command (reader) call
 * this so they always agree on where logs live, even when only the env var is
 * set and no config file exists.
 */
export function resolveLogDir(config: Config): string {
  const env = process.env.CLAUDE_BROKER_LOG_DIR?.trim();
  return env && env.length > 0 ? env : config.logging.sessions.dir;
}

/** Directory holding one session's logs: `<root>/<sessionId>/`. */
export function sessionLogDir(root: string, sessionId: string): string {
  return path.join(root, sanitizeSessionId(sessionId));
}

/** The active (current) job log for a session — stable name, tail -F friendly. */
export function activeJobLog(root: string, sessionId: string): string {
  return path.join(sessionLogDir(root, sessionId), 'jobs.log');
}

/**
 * Session ids/labels are user-controlled and become path segments, so strip
 * anything that could escape the log root or confuse the filesystem.
 */
export function sanitizeSessionId(sessionId: string): string {
  const cleaned = sessionId.replace(/[^A-Za-z0-9_.-]/g, '_').replace(/^\.+/, '');
  return cleaned.length > 0 ? cleaned : 'unknown';
}
