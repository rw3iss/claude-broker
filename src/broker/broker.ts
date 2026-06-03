import type { Config } from '../../config/schema.js';
import { buildContainer, type Container } from '../lib/container.js';
import { buildHttpServer, type BuiltHttpServer } from './http-server.js';
import { SocketServer } from './socket-server.js';
import { StaticBearerAuthenticator } from './auth.js';
import { Sweeper } from './sweeper.js';
import { makeSpawnHelper } from './spawn.js';
import { SessionLogger } from './session-logger.js';
import { resolveLogDir } from '../lib/log-paths.js';

export interface BrokerHandle {
  container: Container;
  http: BuiltHttpServer;
  socket: SocketServer;
  sweeper: Sweeper;
  sessionLogger: SessionLogger | null;
  shutdown(reason?: string): Promise<void>;
  httpAddress: string;
}

export interface StartBrokerOptions {
  config: Config;
  /** Set to false to skip starting the HTTP listener (used by tests). */
  startHttp?: boolean;
  /** Set to false to skip starting the unix socket listener. */
  startSocket?: boolean;
}

export async function startBroker(opts: StartBrokerOptions): Promise<BrokerHandle> {
  const { config } = opts;
  const container = await buildContainer(config);
  const logger = container.logger.child({ comp: 'broker' });

  const socket = new SocketServer({
    service: container.service,
    sessions: container.sessions,
    clock: container.clock,
    logger: container.logger.child({ comp: 'socket' }),
    socketPath: config.broker.socket.path,
  });
  container.setDispatchSink(socket);

  const spawnSession = makeSpawnHelper({
    sessions: container.sessions,
    clock: container.clock,
    logger: container.logger.child({ comp: 'spawn' }),
  });

  const http = buildHttpServer({
    service: container.service,
    sessions: container.sessions,
    bus: container.bus,
    clock: container.clock,
    logger: container.logger.child({ comp: 'http' }),
    auth: new StaticBearerAuthenticator(config.broker.http.auth_token),
    longPollMaxSec: config.broker.defaults.long_poll_max_sec,
    notifyCancel: (sessionId, jobId) => socket.cancelJob(sessionId, jobId),
    notifyComment: (sessionId, jobId, note) =>
      socket.commentJob(sessionId, jobId, note),
    spawnSession,
  });

  await container.dispatcher.start();

  const sessionLogging = config.logging.sessions;
  const logRoot = resolveLogDir(config);
  let sessionLogger: SessionLogger | null = null;
  if (sessionLogging.enabled) {
    sessionLogger = new SessionLogger({
      bus: container.bus,
      logger: container.logger.child({ comp: 'session-log' }),
      root: logRoot,
      maxBytes: sessionLogging.max_bytes,
    });
    sessionLogger.start();
  }

  const sweeper = new Sweeper({
    store: container.store,
    service: container.service,
    sessions: container.sessions,
    clock: container.clock,
    logger: container.logger.child({ comp: 'sweeper' }),
    intervalMs: config.broker.defaults.sweep_interval_sec * 1000,
    heartbeatTimeoutMs: config.broker.defaults.heartbeat_timeout_sec * 1000,
    orphanGraceMs: config.broker.defaults.orphan_grace_sec * 1000,
    // Auto-retention: prune log files older than retain_days, if configured.
    logRetention:
      sessionLogging.enabled && sessionLogging.retain_days
        ? { root: logRoot, retainDays: sessionLogging.retain_days }
        : undefined,
  });
  sweeper.start();

  let httpAddress = '';
  if (opts.startSocket !== false) {
    await socket.listen();
  }
  if (opts.startHttp !== false) {
    const result = await http.listen(
      config.broker.http.host,
      config.broker.http.port,
    );
    httpAddress = result.address;
  }

  logger.info(
    {
      http: httpAddress,
      socket: opts.startSocket === false ? null : config.broker.socket.path,
    },
    'broker started',
  );

  return {
    container,
    http,
    socket,
    sweeper,
    sessionLogger,
    httpAddress,
    async shutdown(reason = 'shutdown') {
      logger.info({ reason }, 'broker shutting down');
      sweeper.stop();
      sessionLogger?.stop();
      await http.close();
      await socket.close();
      await container.dispose();
    },
  };
}
