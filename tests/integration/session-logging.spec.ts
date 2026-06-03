import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import { describe, it, expect } from 'vitest';
import { startBroker } from '../../src/broker/broker.js';
import { loadConfigFromString } from '../../src/lib/config.js';
import { startMockClaude } from '../e2e/helpers/mock-claude.js';

function pickPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, () => {
      const addr = srv.address();
      if (typeof addr === 'object' && addr) {
        const p = addr.port;
        srv.close(() => resolve(p));
      } else reject(new Error('no port'));
    });
  });
}

async function waitFor(pred: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 15));
  }
}

describe('daemon session logging (end to end)', () => {
  it('captures job input and output to <dir>/<session>/jobs.log when enabled', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-slog-e2e-'));
    const logDir = path.join(tmp, 'logs');
    const sock = path.join(tmp, 'broker.sock');
    const port = await pickPort();
    const config = loadConfigFromString(`
broker:
  http: { host: 127.0.0.1, port: ${port}, auth_token: t }
  socket: { path: ${sock} }
  defaults: { job_ttl_sec: 30, heartbeat_timeout_sec: 60, sweep_interval_sec: 5, long_poll_max_sec: 5, client_ref_window_sec: 60, orphan_grace_sec: 60 }
storage: { job_store: { driver: sqlite, sqlite: { path: ${tmp}/jobs.sqlite } } }
dispatch: { driver: inproc }
logging:
  level: error
  pretty: false
  sessions:
    enabled: true
    dir: ${logDir}
    max_bytes: 5242880
instructions: test
`);
    const broker = await startBroker({ config });
    try {
      const claude = await startMockClaude({
        socketPath: sock,
        sessionId: 'logsess',
        label: 'logsess',
        respond: (content) => ({ kind: 'complete', result: { echoed: content } }),
      });

      const submit = await fetch(`http://127.0.0.1:${port}/jobs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer t' },
        body: JSON.stringify({ session_id: 'logsess', content: 'investigate X' }),
      });
      const { job_id } = (await submit.json()) as { job_id: string };

      const logFile = path.join(logDir, 'logsess', 'jobs.log');
      await waitFor(() => {
        if (!fs.existsSync(logFile)) return false;
        const t = fs.readFileSync(logFile, 'utf8');
        return t.includes('"ev":"output"');
      }, 2000);

      const lines = fs
        .readFileSync(logFile, 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l));
      const input = lines.find((l) => l.ev === 'input');
      const output = lines.find((l) => l.ev === 'output');
      expect(input).toMatchObject({ jobId: job_id, content: 'investigate X' });
      expect(output).toMatchObject({ status: 'completed', result: { echoed: 'investigate X' } });

      claude.stop();
    } finally {
      await broker.shutdown('test');
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }, 8000);

  it('writes nothing when logging is disabled (default)', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-slog-off-'));
    const logDir = path.join(tmp, 'logs');
    const sock = path.join(tmp, 'broker.sock');
    const port = await pickPort();
    const config = loadConfigFromString(`
broker:
  http: { host: 127.0.0.1, port: ${port}, auth_token: t }
  socket: { path: ${sock} }
  defaults: { job_ttl_sec: 30, heartbeat_timeout_sec: 60, sweep_interval_sec: 5, long_poll_max_sec: 5, client_ref_window_sec: 60, orphan_grace_sec: 60 }
storage: { job_store: { driver: sqlite, sqlite: { path: ${tmp}/jobs.sqlite } } }
dispatch: { driver: inproc }
logging:
  level: error
  pretty: false
  sessions:
    dir: ${logDir}
instructions: test
`);
    expect(config.logging.sessions.enabled).toBe(false);
    const broker = await startBroker({ config });
    try {
      expect(broker.sessionLogger).toBeNull();
    } finally {
      await broker.shutdown('test');
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }, 8000);
});
