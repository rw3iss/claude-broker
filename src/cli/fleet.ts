import fs from 'node:fs';
import { Command } from 'commander';
import { runJson, withConfigOption } from './client.js';

/** `claude-broker fleet …` — managed sessions (0.6). */
export function fleetCommand(): Command {
  const cmd = new Command('fleet').description('Managed Claude sessions (launched + supervised by the daemon)');

  withConfigOption(cmd.command('status').description('Spec, tmux/claude availability and every managed session')).action(
    async (opts: { config?: string }) => {
      await runJson(opts, 'GET', '/fleet', 'fleet status failed');
    },
  );

  withConfigOption(
    cmd
      .command('set <file>')
      .description('Replace the fleet spec with a JSON file ({ pools: [{ name, count, model?, effort? }], … })'),
  ).action(async (file: string, opts: { config?: string }) => {
    const spec = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    await runJson(opts, 'PUT', '/fleet', 'fleet set failed', spec);
  });

  withConfigOption(cmd.command('apply').description('Start missing sessions, stop ones the spec no longer wants')).action(
    async (opts: { config?: string }) => {
      await runJson(opts, 'POST', '/fleet/apply', 'fleet apply failed', {});
    },
  );

  withConfigOption(cmd.command('stop').description('Close every managed session window (spec kept)')).action(
    async (opts: { config?: string }) => {
      await runJson(opts, 'POST', '/fleet/stop', 'fleet stop failed', {});
    },
  );

  withConfigOption(cmd.command('restart <label>').description('Respawn one managed session')).action(
    async (label: string, opts: { config?: string }) => {
      await runJson(opts, 'POST', `/fleet/sessions/${encodeURIComponent(label)}/restart`, 'restart failed', {});
    },
  );

  return cmd;
}

/** `claude-broker pools` — label families with load + health. */
export function poolsCommand(): Command {
  return withConfigOption(new Command('pools').description('Session pools (labels <pool> / <pool>-<n>) with load and health')).action(
    async (opts: { config?: string }) => {
      await runJson(opts, 'GET', '/pools', 'pools failed');
    },
  );
}
