import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';

/**
 * Boolean that also accepts the forms env interpolation produces. After
 * `${VAR:-false}` is substituted into YAML, an unquoted `1` parses as the
 * NUMBER 1 and `true` as a boolean — so we must handle numbers and strings,
 * not just booleans. Accepts: true/1/"1"/"true"/"yes"/"on" → true;
 * false/0/"0"/"false"/"no"/"off"/"" → false. Plain `z.coerce.boolean()` is
 * unusable here because any non-empty string — even "false" — coerces to true.
 */
const zBool = z.preprocess((v) => {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(s)) return true;
    if (['0', 'false', 'no', 'off', ''].includes(s)) return false;
  }
  return v;
}, z.boolean());

/** Optional positive int that treats "" / null (from `${VAR:-}`) as unset. */
const zOptionalPositiveInt = z.preprocess(
  (v) => (v === '' || v === null ? undefined : v),
  z.coerce.number().int().positive().optional(),
);

/** Optional non-empty string that treats "" / null (from `${VAR:-}`) as unset. */
const zOptionalString = z.preprocess(
  (v) => (v === '' || v === null ? undefined : v),
  z.string().min(1).optional(),
);

export function defaultLogDir(): string {
  return path.join(os.homedir(), '.local', 'state', 'claude-broker', 'logs');
}

export const HttpConfigSchema = z.object({
  host: z.string().default('127.0.0.1'),
  port: z.number().int().min(1).max(65535).default(4180),
  auth_token: z.string().min(1),
});

export const SocketConfigSchema = z.object({
  path: z.string().default('/tmp/claude-broker.sock'),
});

export const BrokerDefaultsSchema = z.object({
  job_ttl_sec: z.number().int().positive().default(300),
  heartbeat_timeout_sec: z.number().int().positive().default(30),
  sweep_interval_sec: z.number().int().positive().default(30),
  long_poll_max_sec: z.number().int().positive().default(600),
  client_ref_window_sec: z.number().int().positive().default(86400),
  orphan_grace_sec: z.number().int().positive().default(120),
});

/**
 * Auto-clear: reset an idle session's context window (the automated `/clear`).
 * The broker types the keys into the session's TUI externally (tmux send-keys or
 * a custom command) — it can't clear via the job channel, which only carries
 * message content. Off by default: keystroke injection is environment-specific
 * (needs a tmux pane or a custom command) and must not fire blind.
 */
export const AutoClearConfigSchema = z.object({
  enabled: zBool.default(false),
  /** Clear only after this many seconds of no job activity. */
  idle_sec: z.coerce.number().int().positive().default(180),
  /** Require at least this many finished jobs since the last clear. */
  min_jobs: z.coerce.number().int().nonnegative().default(1),
  /** Never clear the same session more often than this. */
  cooldown_sec: z.coerce.number().int().positive().default(300),
  /** How often (seconds) the manager evaluates sessions. */
  check_interval_sec: z.coerce.number().int().positive().default(30),
  /** Keystrokes typed into the TUI to reset context. */
  keys: z.string().min(1).default('/clear'),
  /** Explicit tmux target (session:window.pane, or session name). Auto-detected if unset. */
  tmux_target: zOptionalString,
  /** Custom shell command template; overrides the tmux path entirely. */
  command: zOptionalString,
});

export const BrokerConfigSchema = z.object({
  http: HttpConfigSchema,
  socket: SocketConfigSchema.default({}),
  defaults: BrokerDefaultsSchema.default({}),
  auto_clear: AutoClearConfigSchema.default({}),
});

export const SqliteStoreConfigSchema = z.object({
  path: z.string().min(1),
});

export const PostgresStoreConfigSchema = z.object({
  url: z.string().url(),
});

export const JobStoreConfigSchema = z.discriminatedUnion('driver', [
  z.object({ driver: z.literal('sqlite'), sqlite: SqliteStoreConfigSchema }),
  z.object({
    driver: z.literal('postgres'),
    postgres: PostgresStoreConfigSchema,
  }),
]);

export const StorageConfigSchema = z.object({
  job_store: JobStoreConfigSchema,
});

export const DispatchConfigSchema = z.discriminatedUnion('driver', [
  z.object({ driver: z.literal('inproc') }),
  z.object({
    driver: z.literal('bullmq'),
    bullmq: z.object({
      redis: z.string().min(1),
      queue: z.string().min(1),
    }),
  }),
]);

export const SessionLoggingConfigSchema = z.object({
  /** Master switch for daemon-side per-session job I/O logging. */
  enabled: zBool.default(false),
  /** Directory logs are written under, as `<dir>/<sessionId>/jobs.log`. */
  dir: z.string().min(1).default(defaultLogDir()),
  /** Active `jobs.log` rolls to a timestamped archive past this size. */
  max_bytes: z.coerce.number().int().positive().default(5 * 1024 * 1024),
  /** If set, the sweeper deletes log files older than this many days. */
  retain_days: zOptionalPositiveInt,
});

export const LoggingConfigSchema = z.object({
  level: z
    .enum(['trace', 'debug', 'info', 'warn', 'error'])
    .default('info'),
  pretty: z.boolean().default(true),
  sessions: SessionLoggingConfigSchema.default({}),
});

export const ConfigSchema = z.object({
  broker: BrokerConfigSchema,
  storage: StorageConfigSchema,
  dispatch: DispatchConfigSchema.default({ driver: 'inproc' }),
  logging: LoggingConfigSchema.default({}),
  instructions: z.string().min(1),
  instructions_append: z.string().optional(),
});

export type Config = z.infer<typeof ConfigSchema>;
export type BrokerConfig = z.infer<typeof BrokerConfigSchema>;
export type AutoClearConfig = z.infer<typeof AutoClearConfigSchema>;
export type JobStoreConfig = z.infer<typeof JobStoreConfigSchema>;
export type DispatchConfig = z.infer<typeof DispatchConfigSchema>;
export type LoggingConfig = z.infer<typeof LoggingConfigSchema>;
export type SessionLoggingConfig = z.infer<typeof SessionLoggingConfigSchema>;
