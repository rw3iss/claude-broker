import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import type { Clock } from '../ports/clock.js';
import type { DispatchSink } from '../ports/job-dispatcher.js';
import type { Logger } from '../ports/logger.js';
import type { JobService } from './job-service.js';
import type { SessionRegistry } from './session-registry.js';
import {
  encodeMessage,
  parseLine,
  WIRE_VERSION,
  type BrokerDispatchMessage,
  type BrokerToShimMessage,
  type ShimRegisterMessage,
  type ShimToBrokerMessage,
  type ShimToolCallMessage,
} from './wire.js';
import { dispatchTool } from './tool-router.js';

interface Connection {
  id: string;
  socket: net.Socket;
  sessionId: string | null;
  buffer: string;
  toolCallIds: Set<string>;
}

export interface SocketServerOptions {
  service: JobService;
  sessions: SessionRegistry;
  clock: Clock;
  logger: Logger;
  socketPath: string;
}

export class SocketServer implements DispatchSink {
  private readonly service: JobService;
  private readonly sessions: SessionRegistry;
  private readonly clock: Clock;
  private readonly logger: Logger;
  private readonly socketPath: string;
  private readonly server: net.Server;
  private readonly connections = new Map<string, Connection>();
  /** sessionId → connectionId */
  private readonly sessionConn = new Map<string, string>();
  private nextConnId = 0;
  private listening = false;

  constructor(opts: SocketServerOptions) {
    this.service = opts.service;
    this.sessions = opts.sessions;
    this.clock = opts.clock;
    this.logger = opts.logger;
    this.socketPath = opts.socketPath;
    this.server = net.createServer((socket) => this.handleConnection(socket));
  }

  async listen(): Promise<void> {
    if (this.listening) return;
    if (fs.existsSync(this.socketPath)) {
      // Don't steal a socket that another broker is still listening on — that
      // leaves the path pointing at a dead inode (ECONNREFUSED for every new
      // shim). Only unlink when the existing socket is truly stale.
      if (await this.socketHasLiveListener()) {
        throw new Error(
          `another process is already listening on ${this.socketPath}; ` +
            `refusing to take over (stop the running broker first)`,
        );
      }
      try {
        fs.unlinkSync(this.socketPath);
      } catch (err) {
        this.logger.warn(
          { err: err instanceof Error ? err.message : String(err) },
          'failed to unlink stale socket',
        );
      }
    } else {
      const dir = path.dirname(this.socketPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    }
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.socketPath, () => {
        this.server.off('error', reject);
        this.listening = true;
        resolve();
      });
    });
    this.logger.info({ path: this.socketPath }, 'socket server listening');
  }

  async close(): Promise<void> {
    if (!this.listening) return;
    for (const conn of this.connections.values()) {
      this.sendMessage(conn, {
        v: WIRE_VERSION,
        type: 'shutdown',
        reason: 'broker_closing',
      });
      conn.socket.end();
    }
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    this.listening = false;
    try {
      if (fs.existsSync(this.socketPath)) fs.unlinkSync(this.socketPath);
    } catch {
      // best effort
    }
  }

  /**
   * Probe an existing socket file: resolves true if something is actively
   * accepting connections on it, false if the connection is refused (stale
   * file from a dead process) or times out.
   */
  private socketHasLiveListener(): Promise<boolean> {
    return new Promise((resolve) => {
      const probe = net.connect(this.socketPath);
      const finish = (alive: boolean): void => {
        probe.removeAllListeners();
        probe.destroy();
        resolve(alive);
      };
      probe.once('connect', () => finish(true));
      probe.once('error', () => finish(false));
      probe.setTimeout(500, () => finish(false));
    });
  }

  /** DispatchSink — called by JobDispatcher. */
  async send(sessionId: string, message: BrokerDispatchMessage): Promise<void> {
    const conn = this.connectionFor(sessionId);
    if (!conn) {
      throw new Error(`no shim connection for session ${sessionId}`);
    }
    this.sendMessage(conn, { ...message, v: WIRE_VERSION });
  }

  /** Push a cancel notification to the shim for a job. */
  cancelJob(sessionId: string, jobId: string): void {
    const conn = this.connectionFor(sessionId);
    if (!conn) return;
    this.sendMessage(conn, {
      v: WIRE_VERSION,
      type: 'cancel',
      jobId,
    });
  }

  /** Push a comment notification to the shim for a job. */
  commentJob(sessionId: string, jobId: string, note: string): void {
    const conn = this.connectionFor(sessionId);
    if (!conn) return;
    this.sendMessage(conn, {
      v: WIRE_VERSION,
      type: 'comment',
      jobId,
      note,
    });
  }

  private connectionFor(sessionId: string): Connection | undefined {
    const connId = this.sessionConn.get(sessionId);
    return connId ? this.connections.get(connId) : undefined;
  }

  private handleConnection(socket: net.Socket): void {
    const id = `c${++this.nextConnId}`;
    const conn: Connection = {
      id,
      socket,
      sessionId: null,
      buffer: '',
      toolCallIds: new Set(),
    };
    this.connections.set(id, conn);

    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => this.onData(conn, chunk));
    socket.on('end', () => this.onClose(conn, 'remote_end'));
    socket.on('close', () => this.onClose(conn, 'closed'));
    socket.on('error', (err) => {
      this.logger.warn(
        { err: err.message, connId: id },
        'socket error',
      );
    });
  }

  private onData(conn: Connection, chunk: string): void {
    conn.buffer += chunk;
    let nl: number;
    while ((nl = conn.buffer.indexOf('\n')) !== -1) {
      const line = conn.buffer.slice(0, nl);
      conn.buffer = conn.buffer.slice(nl + 1);
      if (line.length === 0) continue;
      this.handleLine(conn, line).catch((err) => {
        this.logger.error(
          { err: err instanceof Error ? err.message : String(err), connId: conn.id },
          'message handler failed',
        );
      });
    }
  }

  private onClose(conn: Connection, reason: string): void {
    if (!this.connections.has(conn.id)) return;
    this.connections.delete(conn.id);
    if (conn.sessionId) {
      const current = this.sessionConn.get(conn.sessionId);
      if (current === conn.id) {
        this.sessionConn.delete(conn.sessionId);
        this.sessions.detach(conn.sessionId, reason);
      }
    }
  }

  private async handleLine(conn: Connection, line: string): Promise<void> {
    let msg: ShimToBrokerMessage;
    try {
      msg = parseLine<ShimToBrokerMessage>(line);
    } catch (err) {
      this.sendError(
        conn,
        'invalid_json',
        err instanceof Error ? err.message : 'invalid json',
      );
      return;
    }
    if (typeof msg !== 'object' || msg === null || !('type' in msg)) {
      this.sendError(conn, 'invalid_message', 'missing type');
      return;
    }
    if (msg.v !== WIRE_VERSION) {
      this.sendError(
        conn,
        'version_mismatch',
        `expected v=${WIRE_VERSION}`,
      );
      conn.socket.end();
      return;
    }

    switch (msg.type) {
      case 'register':
        await this.handleRegister(conn, msg);
        return;
      case 'reconnect':
        await this.handleReconnect(conn, msg);
        return;
      case 'heartbeat':
        if (conn.sessionId) this.sessions.heartbeat(conn.sessionId);
        return;
      case 'toolCall':
        await this.handleToolCall(conn, msg);
        return;
      default: {
        const exhaustive: never = msg;
        void exhaustive;
        this.sendError(conn, 'unknown_message', `unknown type`);
      }
    }
  }

  private async handleRegister(
    conn: Connection,
    msg: ShimRegisterMessage,
  ): Promise<void> {
    if (conn.sessionId) {
      this.sendError(conn, 'already_registered', 'register sent twice');
      return;
    }
    this.attachSession(conn, msg.sessionId, {
      label: msg.label ?? null,
      pid: msg.pid ?? null,
    });
  }

  private async handleReconnect(
    conn: Connection,
    msg: ShimToBrokerMessage & { type: 'reconnect' },
  ): Promise<void> {
    // Reconnect is a soft alias for register. inFlightJobIds is recorded for
    // observability, but the broker's JobStore is the source of truth.
    this.attachSession(conn, msg.sessionId);
    this.logger.info(
      { sessionId: msg.sessionId, inFlight: msg.inFlightJobIds?.length ?? 0 },
      'shim reconnected',
    );
  }

  /**
   * Bind a connection to a session id: evict any prior connection holding
   * that id (the new connection wins), record the mapping, register the
   * session, and ack with `registered`.
   */
  private attachSession(
    conn: Connection,
    sessionId: string,
    extra?: { label?: string | null; pid?: number | null },
  ): void {
    conn.sessionId = sessionId;
    const prior = this.sessionConn.get(sessionId);
    if (prior && prior !== conn.id) {
      const priorConn = this.connections.get(prior);
      if (priorConn) {
        priorConn.socket.end();
        this.connections.delete(prior);
      }
    }
    this.sessionConn.set(sessionId, conn.id);
    this.sessions.register({ id: sessionId, transport: conn, ...extra });
    this.sendMessage(conn, {
      v: WIRE_VERSION,
      type: 'registered',
      sessionId,
    });
  }

  private async handleToolCall(
    conn: Connection,
    msg: ShimToolCallMessage,
  ): Promise<void> {
    if (!conn.sessionId) {
      this.sendToolResult(conn, msg.id, undefined, 'not_registered');
      return;
    }
    conn.toolCallIds.add(msg.id);
    const ctx = { sessionId: conn.sessionId };
    try {
      const result = await dispatchTool(this.service, msg.name, msg.args, ctx);
      this.sendToolResult(conn, msg.id, result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.sendToolResult(conn, msg.id, undefined, message);
    } finally {
      conn.toolCallIds.delete(msg.id);
    }
  }

  private sendMessage(conn: Connection, msg: BrokerToShimMessage): void {
    try {
      conn.socket.write(encodeMessage(msg));
    } catch (err) {
      this.logger.warn(
        { err: err instanceof Error ? err.message : String(err), connId: conn.id },
        'failed to write message',
      );
    }
  }

  private sendError(conn: Connection, code: string, message: string, id?: string): void {
    this.sendMessage(conn, {
      v: WIRE_VERSION,
      type: 'error',
      code,
      message,
      ...(id ? { id } : {}),
    });
  }

  private sendToolResult(
    conn: Connection,
    id: string,
    result: unknown,
    error?: string,
  ): void {
    this.sendMessage(conn, {
      v: WIRE_VERSION,
      type: 'toolResult',
      id,
      ...(error !== undefined ? { error } : { result }),
    });
  }
}
