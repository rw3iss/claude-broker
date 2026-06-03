import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');

function runCli(
  args: string[],
  env: Record<string, string>,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(
      'npx',
      ['tsx', path.join(repoRoot, 'src/cli/index.ts'), ...args],
      { env: { ...process.env, ...env }, cwd: repoRoot },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c.toString()));
    child.stderr.on('data', (c) => (stderr += c.toString()));
    child.on('close', (code) => resolve({ code: code ?? 0, stdout, stderr }));
  });
}

describe('claude-broker logs CLI', () => {
  let dir: string;
  let env: Record<string, string>;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-logscli-'));
    env = { CLAUDE_BROKER_LOG_DIR: dir, CLAUDE_BROKER_TOKEN: 'x' };
    const sess = path.join(dir, 'trader');
    fs.mkdirSync(sess, { recursive: true });
    fs.writeFileSync(
      path.join(sess, 'jobs.log'),
      '{"ev":"input","jobId":"j1"}\n{"ev":"output","jobId":"j1","status":"completed"}\n',
    );
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('views a session job log', async () => {
    const r = await runCli(['logs', 'trader'], env);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('"ev":"input"');
    expect(r.stdout).toContain('"status":"completed"');
  });

  it('honors -n to show the last N lines', async () => {
    const r = await runCli(['logs', 'trader', '-n', '1'], env);
    expect(r.stdout.trim().split('\n')).toHaveLength(1);
    expect(r.stdout).toContain('output');
  });

  it('lists sessions with sizes', async () => {
    const r = await runCli(['logs', 'list'], env);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('trader');
    expect(r.stdout).toMatch(/file\(s\)/);
  });

  it('errors with guidance for an unknown session', async () => {
    const r = await runCli(['logs', 'nope'], env);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('no logs for session "nope"');
    expect(r.stderr).toContain('available sessions: trader');
  });

  it('clears a session and reports what was removed', async () => {
    const r = await runCli(['logs', 'clear', 'trader'], env);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/cleared 1 file\(s\).*for session "trader"/);
    expect(fs.existsSync(path.join(dir, 'trader'))).toBe(false);
  });

  it('clear --days-before keeps fresh files', async () => {
    const r = await runCli(['logs', 'clear', 'trader', '--days-before', '1'], env);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/older than 1 day/);
    // jobs.log was just written (fresh) → not deleted.
    expect(fs.existsSync(path.join(dir, 'trader', 'jobs.log'))).toBe(true);
  });

  it('shell-init emits a cll function', async () => {
    const r = await runCli(['shell-init'], env);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('cll() {');
    expect(r.stdout).toContain('claude-broker logs');
  });
});
