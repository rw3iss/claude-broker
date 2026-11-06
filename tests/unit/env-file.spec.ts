import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadBrokerEnvFile } from '../../src/lib/env-file.js';

describe('loadBrokerEnvFile', () => {
  it('fills unset CLAUDE_BROKER_* keys only, without overriding the environment', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-envfile-'));
    const file = path.join(dir, 'claude-broker.env');
    fs.writeFileSync(file, '# c\nCLAUDE_BROKER_TOKEN="abc"\nexport CLAUDE_BROKER_LOG_SESSIONS=1\nOTHER=x\nCLAUDE_BROKER_SOCKET=/s\n');
    const env: NodeJS.ProcessEnv = { CLAUDE_BROKER_SOCKET: '/keep' };
    expect(loadBrokerEnvFile(env, file).sort()).toEqual(['CLAUDE_BROKER_LOG_SESSIONS', 'CLAUDE_BROKER_TOKEN']);
    expect(env).toEqual({ CLAUDE_BROKER_SOCKET: '/keep', CLAUDE_BROKER_TOKEN: 'abc', CLAUDE_BROKER_LOG_SESSIONS: '1' });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('is a no-op when the file is missing', () => {
    expect(loadBrokerEnvFile({}, '/nonexistent/x.env')).toEqual([]);
  });
});
