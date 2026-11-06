import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AuthManager, extractLoginUrl, extractToken } from '../../src/fleet/auth.js';
import { Tmux } from '../../src/fleet/tmux.js';
import { realClock } from '../../src/adapters/clock/real.js';
import { silentLogger } from '../../src/adapters/logger/pino.js';
import { FakeTmux } from '../helpers/fake-tmux.js';

const fixtures = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'fixtures', 'panes');
const SETUP = fs.readFileSync(path.join(fixtures, 'setup-token.txt'), 'utf8');
const TOKEN = 'sk-ant-oat01-' + 'A'.repeat(40) + '_b-c';

describe('setup-token output parsing', () => {
  it('rejoins a sign-in URL the app wrapped at 80 columns', () => {
    const url = extractLoginUrl(SETUP)!;
    expect(url.startsWith('https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e')).toBe(true);
    expect(url.endsWith('state=F_iGYWWfOeGFOUy0vVOjdlm-pb8hKVklLFQ6nK8t4rk')).toBe(true);
    expect(url).not.toMatch(/\s/);
  });

  it('finds the token, also when wrapped', () => {
    expect(extractToken(`Your token:\n\n${TOKEN}\n\nStore it securely.`)).toBe(TOKEN);
    expect(extractToken(`${TOKEN.slice(0, 30)}\n${TOKEN.slice(30)}\n`)).toBe(TOKEN);
    expect(extractToken('no token here')).toBeNull();
  });
});

describe('AuthManager (fake tmux)', () => {
  let tmp: string;
  let fake: FakeTmux;
  let saved = 0;
  let auth: AuthManager;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-auth-'));
    fake = new FakeTmux();
    saved = 0;
    auth = new AuthManager({
      tmux: new Tmux('test-sock', fake.exec),
      session: 'claude-broker',
      oauthEnv: path.join(tmp, 'cfg', 'oauth.env'),
      workdir: tmp,
      claudeBin: () => '/usr/bin/claude',
      clock: realClock,
      logger: silentLogger(),
      onTokenSaved: () => saved++,
      pollMs: 5,
      urlWaitMs: 500,
      codeWaitMs: 500,
    });
    // The setup-token window prints its link as soon as it exists.
    fake.onNewWindow = (w) => {
      if (w.name === '_auth') w.pane = SETUP;
    };
  });

  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('start → url; good code → token saved 0600, window killed, token never returned', async () => {
    const { url } = await auth.start();
    expect(url).toContain('oauth/authorize');
    expect(fake.windows.get('_auth')?.command).toContain('setup-token');
    expect(auth.login()).toMatchObject({ pending: true, url });
    fake.onKey = (w, key) => {
      if (key === 'Enter') w.pane += `\n${TOKEN}\n`;
    };
    const res = await auth.submitCode('abc#def');
    expect(res.ok).toBe(true);
    expect(JSON.stringify(res)).not.toContain('sk-ant');
    const file = path.join(tmp, 'cfg', 'oauth.env');
    expect(fs.readFileSync(file, 'utf8')).toBe(`CLAUDE_CODE_OAUTH_TOKEN=${TOKEN}\n`);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fake.windows.has('_auth')).toBe(false);
    expect(saved).toBe(1);
    expect(auth.token()).toMatchObject({ set: true });
    expect(auth.token().expires_at).not.toBeNull();
  });

  it('bad code → validation error with retry + a fresh link', async () => {
    await auth.start();
    let enters = 0;
    fake.onKey = (w, key) => {
      if (key !== 'Enter') return;
      enters++;
      if (enters === 1) w.pane += '\nOAuth error: Request failed with status code 400 Press Enter to retry.\n';
      else w.pane += '\n' + SETUP.replace('state=F_iG', 'state=NEW_');
    };
    await expect(auth.submitCode('nope')).rejects.toMatchObject({ status: 400, details: { retry: true } });
    expect(fs.existsSync(path.join(tmp, 'cfg', 'oauth.env'))).toBe(false);
  });

  it('refuses a code with a newline, and a code with no login waiting', async () => {
    await expect(auth.submitCode('a\nb')).rejects.toMatchObject({ status: 400 });
    await expect(auth.submitCode('abc')).rejects.toMatchObject({ status: 400 });
  });

  it('removeToken clears it', async () => {
    await auth.start();
    fake.onKey = (w, key) => {
      if (key === 'Enter') w.pane += `\n${TOKEN}\n`;
    };
    await auth.submitCode('ok');
    auth.removeToken();
    expect(auth.token()).toEqual({ set: false, created_at: null, expires_at: null });
  });
});
