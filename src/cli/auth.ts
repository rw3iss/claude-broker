import readline from 'node:readline/promises';
import { Command } from 'commander';
import { dieOnError, httpJson, printJson, resolveClient, runJson, withConfigOption } from './client.js';

/** `claude-broker auth …` — the long-lived Claude token managed sessions use (0.6). */
export function authCommand(): Command {
  const cmd = new Command('auth').description('Claude sign-in for managed sessions (long-lived setup-token)');

  withConfigOption(cmd.command('status').description('Claude Code install, token and pending sign-in')).action(
    async (opts: { config?: string }) => {
      await runJson(opts, 'GET', '/auth', 'auth status failed');
    },
  );

  withConfigOption(
    cmd.command('login').description('Sign in: prints a link, then reads the code from stdin'),
  ).action(async (opts: { config?: string }) => {
    const client = resolveClient(opts);
    const start = await httpJson(client, 'POST', '/auth/login', {});
    dieOnError(start, 'could not start the sign-in');
    let url: string = start.body.url;
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        console.error(`\nOpen this link, sign in, then paste the code shown:\n\n${url}\n`);
        const code = (await rl.question('Code: ')).trim();
        const r = await httpJson(client, 'POST', '/auth/login/code', { code });
        if (r.status < 400) {
          printJson(r.body);
          return;
        }
        const details = r.body?.error?.details ?? {};
        console.error(`Sign-in failed: ${r.body?.error?.message ?? r.status}`);
        if (!details.retry || !details.url) process.exit(1);
        url = details.url;
      }
      process.exit(1);
    } finally {
      rl.close();
    }
  });

  withConfigOption(cmd.command('cancel').description('Abandon a pending sign-in')).action(async (opts: { config?: string }) => {
    await runJson(opts, 'DELETE', '/auth/login', 'cancel failed');
  });

  withConfigOption(cmd.command('logout').description('Delete the saved token')).action(async (opts: { config?: string }) => {
    await runJson(opts, 'DELETE', '/auth/token', 'logout failed');
  });

  return cmd;
}
