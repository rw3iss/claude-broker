import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Command } from 'commander';
import { loadConfig } from '../lib/config.js';
import { defaultLogDir } from '../../config/schema.js';
import { sanitizeSessionId } from '../lib/log-paths.js';
import { pruneLogsOlderThan } from '../broker/rolling-log.js';

const DEFAULT_SESSION = 'default';

interface ViewOpts {
  config?: string;
  lines?: string;
  follow?: boolean;
  transcript?: boolean;
  all?: boolean;
}

export function logsCommand(): Command {
  const cmd = new Command('logs').description(
    'View and manage per-session logs (job I/O + terminal transcripts)',
  );

  cmd
    .argument('[session]', 'session id or label (defaults to "default")')
    .option('-c, --config <path>', 'config file (to resolve the log dir)')
    .option('-n, --lines <N>', 'show only the last N lines')
    .option('-f, --follow', 'follow the active log (like tail -F)')
    .option('--transcript', 'view the terminal transcript instead of job I/O')
    .option('--all', 'include rolled archive segments, not just the active file')
    .action((session: string | undefined, opts: ViewOpts) => {
      view(session ?? DEFAULT_SESSION, opts);
    });

  cmd
    .command('list')
    .description('List sessions that have logs, with sizes')
    .option('-c, --config <path>', 'config file')
    .action((opts: { config?: string }) => list(opts.config));

  cmd
    .command('clear [session]')
    .description('Delete logs for a session, or --all sessions')
    .option('-c, --config <path>', 'config file')
    .option('--all', 'clear logs for every session')
    .option('--days-before <N>', 'only delete files older than N days')
    .action(
      (
        session: string | undefined,
        opts: { config?: string; all?: boolean; daysBefore?: string },
      ) => clear(session, opts),
    );

  cmd.addHelpText(
    'after',
    `
Examples:
  claude-broker logs                      # tail-style view of the "default" session's job log
  claude-broker logs trader               # view session "trader"'s job log
  claude-broker logs trader -n 50         # last 50 lines
  claude-broker logs trader -f            # live-follow (watch a session externally)
  claude-broker logs trader --transcript  # the full Claude terminal transcript
  claude-broker logs trader --all         # include rolled archive segments
  claude-broker logs list                 # which sessions have logs
  claude-broker logs clear trader         # delete session "trader"'s logs
  claude-broker logs clear --all          # delete every session's logs
  claude-broker logs clear --all --days-before 2   # delete log files older than 2 days

The log directory is CLAUDE_BROKER_LOG_DIR, else logging.sessions.dir from
config, else ~/.local/state/claude-broker/logs. A session's logs live under
<dir>/<session>/ as jobs.log (+ rolled jobs.<ts>.log) and transcript-*.log.`,
  );

  return cmd;
}

// --- resolution -----------------------------------------------------------

function logRoot(configPath?: string): string {
  const env = process.env.CLAUDE_BROKER_LOG_DIR?.trim();
  if (env) return env;
  try {
    return loadConfig({ path: configPath }).logging.sessions.dir;
  } catch {
    // logs is read-only and shouldn't require a valid auth_token etc.
    return defaultLogDir();
  }
}

function sessionDir(root: string, session: string): string {
  return path.join(root, sanitizeSessionId(session));
}

function listSessions(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

/** Job-log segments for a session: archives (oldest→newest) then active. */
function jobLogFiles(dir: string, all: boolean): string[] {
  const active = path.join(dir, 'jobs.log');
  if (!all) return fs.existsSync(active) ? [active] : [];
  const archives = (fs.existsSync(dir) ? fs.readdirSync(dir) : [])
    .filter((f) => /^jobs\..+\.log$/.test(f))
    .sort()
    .map((f) => path.join(dir, f));
  return fs.existsSync(active) ? [...archives, active] : archives;
}

/** Transcript files: newest only, or all (oldest→newest) when `all`. */
function transcriptFiles(dir: string, all: boolean): string[] {
  const files = (fs.existsSync(dir) ? fs.readdirSync(dir) : [])
    .filter((f) => /^transcript-.+\.log$/.test(f))
    .sort()
    .map((f) => path.join(dir, f));
  if (all) return files;
  return files.length ? [files[files.length - 1]] : [];
}

// --- actions --------------------------------------------------------------

function view(session: string, opts: ViewOpts): void {
  const root = logRoot(opts.config);
  const dir = sessionDir(root, session);
  if (!fs.existsSync(dir)) {
    console.error(`no logs for session "${session}" under ${root}`);
    const available = listSessions(root);
    if (available.length) {
      console.error(`available sessions: ${available.join(', ')}`);
    } else {
      console.error('(no sessions have logs yet — is logging enabled on the daemon?)');
    }
    process.exit(2);
  }

  const files = opts.transcript
    ? transcriptFiles(dir, Boolean(opts.all))
    : jobLogFiles(dir, Boolean(opts.all));

  if (files.length === 0) {
    console.error(
      `no ${opts.transcript ? 'transcript' : 'job'} log for session "${session}"`,
    );
    process.exit(2);
  }

  if (opts.follow) {
    // Follow the active/newest file by name so rotation is handled (tail -F).
    const target = files[files.length - 1];
    const n = opts.lines ?? '10';
    const child = spawn('tail', ['-n', n, '-F', target], { stdio: 'inherit' });
    child.on('exit', (code) => process.exit(code ?? 0));
    return;
  }

  const text = files.map((f) => fs.readFileSync(f, 'utf8')).join('');
  if (opts.lines) {
    const n = Number(opts.lines);
    const lines = text.split('\n');
    // Preserve a trailing newline split artifact by filtering the empty tail.
    const body = lines[lines.length - 1] === '' ? lines.slice(0, -1) : lines;
    process.stdout.write(body.slice(-n).join('\n') + '\n');
  } else {
    process.stdout.write(text);
  }
}

function list(configPath?: string): void {
  const root = logRoot(configPath);
  const sessions = listSessions(root);
  if (sessions.length === 0) {
    console.log(`no session logs under ${root}`);
    return;
  }
  console.log(`logs under ${root}:`);
  for (const s of sessions) {
    const { count, bytes } = dirStats(sessionDir(root, s));
    console.log(`  ${s.padEnd(24)} ${count} file(s)  ${humanBytes(bytes)}`);
  }
}

function clear(
  session: string | undefined,
  opts: { config?: string; all?: boolean; daysBefore?: string },
): void {
  const root = logRoot(opts.config);
  if (!session && !opts.all) {
    console.error('specify a <session>, or --all to clear every session');
    process.exit(2);
  }
  const scope = session ? sessionDir(root, session) : root;
  if (!fs.existsSync(scope)) {
    console.log(`nothing to clear (${scope} does not exist)`);
    return;
  }

  const label = session ? `session "${session}"` : 'all sessions';

  if (opts.daysBefore !== undefined) {
    const days = Number(opts.daysBefore);
    if (!Number.isFinite(days) || days < 0) {
      console.error(`--days-before must be a non-negative number`);
      process.exit(2);
    }
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    const deleted = pruneLogsOlderThan(scope, cutoff);
    console.log(
      `cleared ${deleted.length} file(s) older than ${days} day(s) for ${label}`,
    );
    return;
  }

  const { count, bytes } = dirStats(scope);
  if (session) {
    fs.rmSync(scope, { recursive: true, force: true });
  } else {
    // --all: wipe each session dir but keep the root.
    for (const s of listSessions(root)) {
      fs.rmSync(sessionDir(root, s), { recursive: true, force: true });
    }
  }
  console.log(`cleared ${count} file(s) (${humanBytes(bytes)}) for ${label}`);
}

// --- helpers --------------------------------------------------------------

function dirStats(dir: string): { count: number; bytes: number } {
  let count = 0;
  let bytes = 0;
  if (!fs.existsSync(dir)) return { count, bytes };
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const sub = dirStats(full);
      count += sub.count;
      bytes += sub.bytes;
    } else if (entry.isFile()) {
      count += 1;
      try {
        bytes += fs.statSync(full).size;
      } catch {
        /* ignore */
      }
    }
  }
  return { count, bytes };
}

function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}

