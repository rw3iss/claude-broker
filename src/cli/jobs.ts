import { Command } from 'commander';
import {
  printJson,
  resolveClient,
  httpJson,
  dieOnError,
  runJson,
  withConfigOption,
} from './client.js';

interface SubmitOpts {
  config?: string;
  session?: string;
  sessionLabel?: string;
  pool?: string;
  content?: string;
  contentFile?: string;
  ttl?: string;
  priority?: string;
  mode?: string;
  clientRef?: string;
  meta?: string[];
  wait?: boolean;
  waitTimeout: string;
}

export function jobsCommand(): Command {
  const cmd = new Command('jobs').description('Submit and manage jobs');

  withConfigOption(
    cmd
      .command('list')
      .description('List jobs')
      .option('--status <statuses>', 'comma-separated status filter')
      .option('--session <id>', 'session id filter')
      .option('--limit <n>', 'max rows', '50'),
  ).action(
    async (opts: {
      config?: string;
      status?: string;
      session?: string;
      limit: string;
    }) => {
      const qs = new URLSearchParams();
      if (opts.status) qs.set('status', opts.status);
      if (opts.session) qs.set('session_id', opts.session);
      qs.set('limit', opts.limit);
      await runJson(opts, 'GET', `/jobs?${qs.toString()}`, 'list failed');
    },
  );

  withConfigOption(
    cmd.command('get <job_id>').description('Fetch a single job'),
  ).action(async (jobId: string, opts: { config?: string }) => {
    await runJson(opts, 'GET', `/jobs/${encodeURIComponent(jobId)}`, 'get failed');
  });

  withConfigOption(
    cmd
      .command('submit')
      .description('Submit a job')
      .option('--session <id>', 'session id')
      .option('--session-label <label>', 'session label')
      .option('--pool <pool>', 'pool: least-busy healthy session labelled <pool> or <pool>-<n>')
      .option('--content <text>', 'job content')
      .option('--content-file <path>', 'read content from file (alternative to --content)')
      .option('--ttl <sec>', 'TTL in seconds')
      .option('--priority <p>', 'high|normal|low', 'normal')
      .option('--mode <m>', 'serial|fire-and-forget', 'serial')
      .option('--client-ref <ref>', 'idempotency key')
      .option('--meta <kv...>', 'meta entries in key=value form')
      .option('--wait', 'wait for completion before returning')
      .option('--wait-timeout <sec>', 'long-poll timeout', '60'),
  ).action(async (opts: SubmitOpts) => {
    const content =
      opts.content ??
      (opts.contentFile
        ? await (await import('node:fs/promises')).readFile(opts.contentFile, 'utf8')
        : null);
    if (!content) {
      console.error('--content or --content-file required');
      process.exit(2);
    }
    const meta: Record<string, string> = {};
    for (const pair of opts.meta ?? []) {
      const idx = pair.indexOf('=');
      if (idx < 0) {
        console.error(`bad --meta ${pair}: expected key=value`);
        process.exit(2);
      }
      meta[pair.slice(0, idx)] = pair.slice(idx + 1);
    }
    const body = {
      session_id: opts.session,
      session_label: opts.sessionLabel,
      pool: opts.pool,
      content,
      meta: Object.keys(meta).length ? meta : undefined,
      ttl_sec: opts.ttl ? Number(opts.ttl) : undefined,
      priority: opts.priority,
      mode: opts.mode,
      client_ref: opts.clientRef,
    };

    // Two-step when --wait: submit, then long-poll on the same client.
    const client = resolveClient(opts);
    const submitRes = await httpJson(client, 'POST', '/jobs', body);
    dieOnError(submitRes, 'submit failed');
    if (!opts.wait) {
      printJson(submitRes.body);
      return;
    }
    const jobId: string = submitRes.body.job_id;
    const waitRes = await httpJson(
      client,
      'GET',
      `/jobs/${encodeURIComponent(jobId)}/wait?timeout=${opts.waitTimeout}`,
    );
    dieOnError(waitRes, 'wait failed');
    printJson(waitRes.body);
    if (waitRes.body.status !== 'completed') process.exit(1);
  });

  withConfigOption(
    cmd.command('cancel <job_id>').description('Cancel a job'),
  ).action(async (jobId: string, opts: { config?: string }) => {
    await runJson(
      opts,
      'DELETE',
      `/jobs/${encodeURIComponent(jobId)}`,
      'cancel failed',
    );
  });

  return cmd;
}
