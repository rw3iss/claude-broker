import { Command } from 'commander';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { loadConfig } from '../lib/config.js';
import { startBroker } from '../broker/broker.js';
import { withConfigOption } from './client.js';

const PID_FILE_DEFAULT = path.join(
  process.env.XDG_RUNTIME_DIR || os.tmpdir(),
  'claude-broker.pid',
);

export function daemonCommand(): Command {
  const cmd = new Command('daemon').description('Manage the long-running broker process');

  withConfigOption(
    cmd
      .command('start')
      .description('Start the broker in the foreground (or --detach to background)')
      .option('--detach', 'fork into background and write a pidfile', false)
      .option('--pidfile <path>', 'pidfile path', PID_FILE_DEFAULT)
      .option('--log-sessions', 'enable per-session job I/O logging', false)
      .option('--log-dir <path>', 'session log directory (overrides config + env)'),
  ).action(async (opts: {
    config?: string;
    detach?: boolean;
    pidfile?: string;
    logSessions?: boolean;
    logDir?: string;
  }) => {
      if (opts.detach) {
        // Re-exec ourselves without --detach, detached.
        const args = process.argv.slice(2).filter((a) => a !== '--detach');
        const out = fs.openSync(path.join(os.tmpdir(), 'claude-broker.log'), 'a');
        const child = spawn(process.execPath, [process.argv[1], ...args], {
          detached: true,
          stdio: ['ignore', out, out],
          env: process.env,
        });
        if (opts.pidfile) {
          fs.writeFileSync(opts.pidfile, String(child.pid));
        }
        child.unref();
        console.log(`broker started in background; pid=${child.pid}`);
        return;
      }
      // --log-dir wins over CLAUDE_BROKER_LOG_DIR by becoming it, so every
      // resolveLogDir() call in this process agrees.
      if (opts.logDir) process.env.CLAUDE_BROKER_LOG_DIR = opts.logDir;
      const config = loadConfig({ path: opts.config });
      if (opts.logSessions) config.logging.sessions.enabled = true;
      const broker = await startBroker({ config });
      console.log(`broker listening on ${broker.httpAddress}`);
      if (config.logging.sessions.enabled) {
        const { resolveLogDir } = await import('../lib/log-paths.js');
        console.log(
          `session logging ON → ${resolveLogDir(config)}/<session>/jobs.log`,
        );
      }
      if (opts.pidfile && !opts.detach) {
        try {
          fs.writeFileSync(opts.pidfile, String(process.pid));
        } catch {
          // best effort
        }
      }
      let shutting = false;
      const shutdown = async (signal: string) => {
        if (shutting) return;
        shutting = true;
        try {
          await broker.shutdown(signal);
        } finally {
          if (opts.pidfile) {
            try { fs.unlinkSync(opts.pidfile); } catch { /* ignore */ }
          }
          process.exit(0);
        }
      };
      process.once('SIGTERM', () => void shutdown('SIGTERM'));
      process.once('SIGINT', () => void shutdown('SIGINT'));
    });

  cmd
    .command('stop')
    .description('Stop a broker started with --detach')
    .option('--pidfile <path>', 'pidfile path', PID_FILE_DEFAULT)
    .action((opts: { pidfile?: string }) => {
      const pidfile = opts.pidfile ?? PID_FILE_DEFAULT;
      if (!fs.existsSync(pidfile)) {
        console.error(`pidfile not found at ${pidfile}`);
        process.exit(1);
      }
      const pid = Number(fs.readFileSync(pidfile, 'utf8').trim());
      if (!Number.isFinite(pid)) {
        console.error(`invalid pid in ${pidfile}`);
        process.exit(1);
      }
      try {
        process.kill(pid, 'SIGTERM');
        console.log(`SIGTERM → pid ${pid}`);
      } catch (err) {
        console.error(
          `failed to signal pid ${pid}: ${err instanceof Error ? err.message : String(err)}`,
        );
        process.exit(1);
      }
    });

  withConfigOption(
    cmd
      .command('status')
      .description('Query the broker via its /healthz endpoint'),
  ).action(async (opts: { config?: string }) => {
      const config = loadConfig({ path: opts.config });
      const url = `http://${config.broker.http.host}:${config.broker.http.port}/healthz`;
      try {
        const res = await fetch(url);
        const body = await res.json();
        console.log(JSON.stringify(body, null, 2));
        process.exit(res.ok ? 0 : 1);
      } catch (err) {
        console.error(
          `cannot reach broker at ${url}: ${err instanceof Error ? err.message : String(err)}`,
        );
        process.exit(2);
      }
    });

  return cmd;
}
