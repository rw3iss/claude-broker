import { Command } from 'commander';
import { daemonCommand } from './daemon.js';
import { jobsCommand } from './jobs.js';
import { sessionsCommand } from './sessions.js';
import { configCommand } from './config.js';
import { shimCommand } from './shim.js';
import { updateCommand } from './update.js';
import { logsCommand } from './logs.js';
import { shellInitCommand } from './shell-init.js';
import { fleetCommand, poolsCommand } from './fleet.js';
import { authCommand } from './auth.js';
import { packageVersion } from '../lib/version.js';
import { loadBrokerEnvFile } from '../lib/env-file.js';

// CLI commands in a plain shell: take CLAUDE_BROKER_TOKEN etc. from the daemon's env
// file (~/.config/claude-broker/claude-broker.env) when they are not exported.
loadBrokerEnvFile();

const PKG_VERSION = packageVersion();

const program = new Command()
  .name('claude-broker')
  .description('Claude Code channel broker — long-running daemon + shim')
  .version(PKG_VERSION);

program.addCommand(daemonCommand());
program.addCommand(shimCommand());
program.addCommand(jobsCommand());
program.addCommand(sessionsCommand());
program.addCommand(configCommand());
program.addCommand(updateCommand());
program.addCommand(logsCommand());
program.addCommand(shellInitCommand());
program.addCommand(fleetCommand());
program.addCommand(poolsCommand());
program.addCommand(authCommand());

program.parseAsync(process.argv).catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
