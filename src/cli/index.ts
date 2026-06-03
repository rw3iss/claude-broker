import { Command } from 'commander';
import { daemonCommand } from './daemon.js';
import { jobsCommand } from './jobs.js';
import { sessionsCommand } from './sessions.js';
import { configCommand } from './config.js';
import { shimCommand } from './shim.js';
import { updateCommand } from './update.js';
import { logsCommand } from './logs.js';
import { shellInitCommand } from './shell-init.js';
import { packageVersion } from '../lib/version.js';

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

program.parseAsync(process.argv).catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
