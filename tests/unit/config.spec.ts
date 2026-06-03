import { describe, expect, it } from 'vitest';
import { interpolateEnv } from '../../src/lib/env.js';
import { loadConfigFromString } from '../../src/lib/config.js';

const minimal = `
broker:
  http:
    host: 127.0.0.1
    port: 4180
    auth_token: secret-abc
storage:
  job_store:
    driver: sqlite
    sqlite:
      path: /tmp/jobs.sqlite
instructions: |
  do the thing
`;

describe('interpolateEnv', () => {
  it('substitutes set vars', () => {
    expect(interpolateEnv('hello ${NAME}', { NAME: 'world' })).toBe('hello world');
  });

  it('uses fallbacks when unset', () => {
    expect(interpolateEnv('hello ${NAME:-stranger}', {})).toBe('hello stranger');
  });

  it('uses fallbacks when empty', () => {
    expect(interpolateEnv('hello ${NAME:-stranger}', { NAME: '' })).toBe(
      'hello stranger',
    );
  });

  it('throws when required var is missing', () => {
    expect(() => interpolateEnv('hello ${NAME}', {})).toThrow(/NAME/);
  });

  it('leaves non-matching text alone', () => {
    expect(interpolateEnv('plain text', {})).toBe('plain text');
  });
});

describe('logging.sessions.enabled coercion', () => {
  // After `${CLAUDE_BROKER_LOG_SESSIONS:-false}` interpolates, an unquoted `1`
  // parses as a YAML NUMBER and `true` as a boolean — both must coerce.
  const withSessions = (envExpr: string) => `
broker:
  http: { host: 127.0.0.1, port: 4180, auth_token: t }
storage:
  job_store: { driver: sqlite, sqlite: { path: /tmp/jobs.sqlite } }
logging:
  sessions:
    enabled: ${envExpr}
instructions: do
`;

  it('coerces numeric 1 (the env=1 case) to true', () => {
    const cfg = loadConfigFromString(
      withSessions('${CLAUDE_BROKER_LOG_SESSIONS:-false}'),
      { CLAUDE_BROKER_LOG_SESSIONS: '1' },
    );
    expect(cfg.logging.sessions.enabled).toBe(true);
  });

  it('coerces numeric 0 to false', () => {
    const cfg = loadConfigFromString(
      withSessions('${CLAUDE_BROKER_LOG_SESSIONS:-false}'),
      { CLAUDE_BROKER_LOG_SESSIONS: '0' },
    );
    expect(cfg.logging.sessions.enabled).toBe(false);
  });

  it('accepts the boolean form true', () => {
    const cfg = loadConfigFromString(
      withSessions('${CLAUDE_BROKER_LOG_SESSIONS:-false}'),
      { CLAUDE_BROKER_LOG_SESSIONS: 'true' },
    );
    expect(cfg.logging.sessions.enabled).toBe(true);
  });

  it('defaults to false when unset', () => {
    const cfg = loadConfigFromString(
      withSessions('${CLAUDE_BROKER_LOG_SESSIONS:-false}'),
      {},
    );
    expect(cfg.logging.sessions.enabled).toBe(false);
  });
});

describe('loadConfigFromString', () => {
  it('parses a minimal valid config', () => {
    const cfg = loadConfigFromString(minimal, {});
    expect(cfg.broker.http.port).toBe(4180);
    expect(cfg.broker.http.auth_token).toBe('secret-abc');
    expect(cfg.storage.job_store.driver).toBe('sqlite');
    expect(cfg.broker.defaults.job_ttl_sec).toBe(300);
    expect(cfg.dispatch.driver).toBe('inproc');
    expect(cfg.logging.level).toBe('info');
  });

  it('interpolates env vars before parsing', () => {
    const yamlText = `
broker:
  http:
    host: 127.0.0.1
    port: 4180
    auth_token: \${MY_TOKEN}
storage:
  job_store:
    driver: sqlite
    sqlite:
      path: /tmp/jobs.sqlite
instructions: |
  do
`;
    const cfg = loadConfigFromString(yamlText, { MY_TOKEN: 'live-token' });
    expect(cfg.broker.http.auth_token).toBe('live-token');
  });

  it('throws with path info when port is out of range', () => {
    const bad = minimal.replace('port: 4180', 'port: 99999');
    expect(() => loadConfigFromString(bad, {})).toThrow(/broker\.http\.port/);
  });

  it('throws when required fields are missing', () => {
    const bad = `
broker:
  http:
    host: 127.0.0.1
storage:
  job_store:
    driver: sqlite
    sqlite:
      path: /tmp/jobs.sqlite
instructions: do
`;
    expect(() => loadConfigFromString(bad, {})).toThrow(/auth_token/);
  });

  it('rejects unknown dispatch driver', () => {
    const bad =
      minimal +
      `
dispatch:
  driver: weird
`;
    expect(() => loadConfigFromString(bad, {})).toThrow();
  });
});
