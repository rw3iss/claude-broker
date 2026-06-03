import net from 'node:net';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SocketServer } from '../../src/broker/socket-server.js';
import { JobService } from '../../src/broker/job-service.js';
import { SessionRegistry } from '../../src/broker/session-registry.js';
import { SseBus } from '../../src/broker/sse-bus.js';
import { SqliteJobStore } from '../../src/adapters/job-store/sqlite.js';
import { InProcessJobDispatcher } from '../../src/adapters/job-dispatcher/inproc.js';
import { realClock } from '../../src/adapters/clock/real.js';
import { silentLogger } from '../../src/adapters/logger/pino.js';
import { encodeMessage, WIRE_VERSION } from '../../src/broker/wire.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.resolve(here, '..', '..', 'migrations');

interface ClientHandle {
  socket: net.Socket;
  messages: unknown[];
  waitFor: (pred: (m: any) => boolean, timeoutMs?: number) => Promise<any>;
  send: (m: object) => void;
  close: () => void;
}

function clientConnect(socketPath: string): Promise<ClientHandle> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    const messages: unknown[] = [];
    let buffer = '';
    const waiters: Array<(m: any) => boolean> = [];
    const waiterResolvers: Array<(m: any) => void> = [];

    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      let nl: number;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        const msg = JSON.parse(line);
        messages.push(msg);
        for (let i = waiters.length - 1; i >= 0; i--) {
          if (waiters[i](msg)) {
            waiterResolvers[i](msg);
            waiters.splice(i, 1);
            waiterResolvers.splice(i, 1);
          }
        }
      }
    });
    socket.on('error', reject);
    socket.on('connect', () => {
      resolve({
        socket,
        messages,
        waitFor: (pred, timeoutMs = 1000) =>
          new Promise((res, rej) => {
            const existing = messages.find((m) => pred(m));
            if (existing) return res(existing);
            const id = setTimeout(
              () => rej(new Error('timeout waiting for message')),
              timeoutMs,
            );
            waiters.push((m) => {
              if (pred(m)) {
                clearTimeout(id);
                return true;
              }
              return false;
            });
            waiterResolvers.push(res);
          }),
        send: (m) => socket.write(encodeMessage(m)),
        close: () => socket.end(),
      });
    });
  });
}

describe('SocketServer integration', () => {
  let tmp: string;
  let socketPath: string;
  let store: SqliteJobStore;
  let sessions: SessionRegistry;
  let bus: SseBus;
  let dispatcher: InProcessJobDispatcher;
  let service: JobService;
  let server: SocketServer;

  beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-sock-'));
    socketPath = path.join(tmp, 'broker.sock');
    store = new SqliteJobStore({
      path: path.join(tmp, 'jobs.sqlite'),
      clock: realClock,
      migrationsDir,
    });
    sessions = new SessionRegistry(realClock);
    bus = new SseBus();
    let sinkRef: { send: (s: string, m: any) => Promise<void> } = {
      send: async () => {},
    };
    dispatcher = new InProcessJobDispatcher({
      store,
      clock: realClock,
      logger: silentLogger(),
      sink: {
        async send(sessionId, msg) {
          await sinkRef.send(sessionId, msg);
        },
      },
      sessionGate: {
        isAttached: (id) => sessions.get(id)?.status === 'attached',
      },
    });
    service = new JobService({
      store,
      dispatcher,
      sessions,
      bus,
      clock: realClock,
      logger: silentLogger(),
      defaults: { job_ttl_sec: 300, client_ref_window_sec: 86400 },
    });
    server = new SocketServer({
      service,
      sessions,
      clock: realClock,
      logger: silentLogger(),
      socketPath,
    });
    sinkRef = server;
    sessions.on('attached', ({ session }) => {
      void dispatcher.notifySessionAttached(session.id);
    });
    await dispatcher.start();
    await server.listen();
  });

  afterEach(async () => {
    await server.close();
    await dispatcher.stop();
    await store.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('refuses to take over a socket that a live broker is already listening on', async () => {
    // `server` is already listening on socketPath (beforeEach). A second
    // SocketServer on the same path must NOT steal it (which would leave the
    // path pointing at a dead inode → ECONNREFUSED for new shims).
    const intruder = new SocketServer({
      service,
      sessions,
      clock: realClock,
      logger: silentLogger(),
      socketPath,
    });
    await expect(intruder.listen()).rejects.toThrow(/already listening/);
    // The original is unharmed — a client still connects + registers.
    const client = await clientConnect(socketPath);
    client.send({ v: WIRE_VERSION, type: 'register', sessionId: 'still-ok' });
    const reg = await client.waitFor((m: any) => m.type === 'registered');
    expect(reg.sessionId).toBe('still-ok');
    client.close();
  });

  it('register → dispatch → toolCall (complete_job) → toolResult roundtrip', async () => {
    const client = await clientConnect(socketPath);
    client.send({ v: WIRE_VERSION, type: 'register', sessionId: 'sess-1', label: 'foo' });
    const registered = await client.waitFor((m: any) => m.type === 'registered');
    expect(registered.sessionId).toBe('sess-1');

    const job = await service.submit({ session_id: 'sess-1', content: 'do' });
    const dispatch = await client.waitFor((m: any) => m.type === 'dispatch');
    expect(dispatch.jobId).toBe(job.id);
    expect(dispatch.meta.job_id).toBe(job.id);

    client.send({
      v: WIRE_VERSION,
      type: 'toolCall',
      id: 'corr-1',
      name: 'complete_job',
      args: { job_id: job.id, result: { summary: 'done' } },
    });
    const result = await client.waitFor(
      (m: any) => m.type === 'toolResult' && m.id === 'corr-1',
    );
    expect(result.result).toMatchObject({ ok: true, status: 'completed' });

    const stored = await store.get(job.id);
    expect(stored?.status).toBe('completed');
    expect(stored?.result).toEqual({ summary: 'done' });
    client.close();
  });

  it('two simultaneous shims route to the correct session', async () => {
    const c1 = await clientConnect(socketPath);
    const c2 = await clientConnect(socketPath);
    c1.send({ v: WIRE_VERSION, type: 'register', sessionId: 's-A' });
    c2.send({ v: WIRE_VERSION, type: 'register', sessionId: 's-B' });
    await c1.waitFor((m: any) => m.type === 'registered');
    await c2.waitFor((m: any) => m.type === 'registered');

    const jobA = await service.submit({ session_id: 's-A', content: 'A' });
    const jobB = await service.submit({ session_id: 's-B', content: 'B' });
    const dA = await c1.waitFor((m: any) => m.type === 'dispatch');
    const dB = await c2.waitFor((m: any) => m.type === 'dispatch');
    expect(dA.jobId).toBe(jobA.id);
    expect(dB.jobId).toBe(jobB.id);
    c1.close();
    c2.close();
  });

  it('reconnect re-attaches the same session_id', async () => {
    const c1 = await clientConnect(socketPath);
    c1.send({ v: WIRE_VERSION, type: 'register', sessionId: 's1' });
    await c1.waitFor((m: any) => m.type === 'registered');
    c1.close();
    await new Promise((r) => setTimeout(r, 50));

    const c2 = await clientConnect(socketPath);
    c2.send({
      v: WIRE_VERSION,
      type: 'reconnect',
      sessionId: 's1',
      inFlightJobIds: [],
    });
    const re = await c2.waitFor((m: any) => m.type === 'registered');
    expect(re.sessionId).toBe('s1');
    expect(sessions.get('s1')?.status).toBe('attached');
    c2.close();
  });

  it('rejects version mismatch', async () => {
    const c = await clientConnect(socketPath);
    c.socket.write(
      JSON.stringify({ v: 999, type: 'register', sessionId: 'x' }) + '\n',
    );
    const err = await c.waitFor((m: any) => m.type === 'error');
    expect(err.code).toBe('version_mismatch');
  });

  it('crashing one shim does not affect the other', async () => {
    const c1 = await clientConnect(socketPath);
    const c2 = await clientConnect(socketPath);
    c1.send({ v: WIRE_VERSION, type: 'register', sessionId: 'sA' });
    c2.send({ v: WIRE_VERSION, type: 'register', sessionId: 'sB' });
    await c1.waitFor((m: any) => m.type === 'registered');
    await c2.waitFor((m: any) => m.type === 'registered');
    c1.socket.destroy();
    await new Promise((r) => setTimeout(r, 50));
    expect(sessions.get('sA')?.status).toBe('detached');
    expect(sessions.get('sB')?.status).toBe('attached');

    const job = await service.submit({ session_id: 'sB', content: 'after-crash' });
    const dispatch = await c2.waitFor((m: any) => m.type === 'dispatch');
    expect(dispatch.jobId).toBe(job.id);
    c2.close();
  });
});
