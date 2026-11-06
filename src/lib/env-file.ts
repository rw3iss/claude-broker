import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Where the setup tooling (and the CMS plugin's setup script) keeps the daemon's env. */
export function defaultEnvFile(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLAUDE_BROKER_ENV_FILE || path.join(os.homedir(), '.config', 'claude-broker', 'claude-broker.env');
}

/**
 * Fill CLAUDE_BROKER_* variables that are not already set from the env file, so
 * `claude-broker fleet status` etc. work in a plain shell on a box whose daemon
 * reads that file through systemd (EnvironmentFile=). Variables already in the
 * environment win; only CLAUDE_BROKER_* keys are taken. Returns the keys loaded.
 */
export function loadBrokerEnvFile(env: NodeJS.ProcessEnv = process.env, file = defaultEnvFile(env)): string[] {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const loaded: string[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?(CLAUDE_BROKER_[A-Z0-9_]+)=(.*)$/.exec(line);
    if (!m) continue;
    const [, key, value] = m;
    if (env[key] !== undefined && env[key] !== '') continue;
    env[key] = value.trim().replace(/^(['"])(.*)\1$/, '$2');
    loaded.push(key);
  }
  return loaded;
}
