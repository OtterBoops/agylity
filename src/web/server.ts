import http from 'node:http';
import type net from 'node:net';
import { handleRequest, type WebServerOptions } from './routes.js';
import { logger } from '../logs/logger.js';
import { resolveWebUiAuthToken, BUILTIN_DEFAULTS } from '../config/registry.js';

const IN_FLIGHT_GRACE_MS = 5000;

const createWebServer = (options: WebServerOptions): http.Server => {
  const inFlight = new Set<Promise<void>>();
  const shutdownController = new AbortController();
  const server = http.createServer((req, res) => {
    const handled = handleRequest(req, res, options, shutdownController.signal).catch(
      (err: any) => {
        logger
          .child('web')
          .error('Unhandled route error for %s %s: %s', req.method, req.url, err?.stack ?? err);
        // The message stays in the log: it can carry absolute paths and SQL detail.
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Internal Server Error' }));
        } else if (!res.writableEnded && !res.destroyed) {
          res.end();
        }
      }
    );
    inFlight.add(handled);
    void handled.finally(() => inFlight.delete(handled));
  });

  const sockets = new Set<net.Socket>();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => {
      sockets.delete(socket);
    });
  });

  SERVER_STATE.set(server, { sockets, inFlight, shutdownController });

  return server;
};

/** Per-server lifecycle state; kept off the server object so nothing has to cast to reach it. */
interface ServerState {
  sockets: Set<net.Socket>;
  inFlight: Set<Promise<void>>;
  shutdownController: AbortController;
}

const SERVER_STATE = new WeakMap<http.Server, ServerState>();

const isLoopbackHost = (host: string): boolean => {
  const h = host.trim().toLowerCase();
  return h === '127.0.0.1' || h === '::1' || h === 'localhost';
};

export const startWebServer = async (
  options: WebServerOptions
): Promise<{ server: http.Server; port: number; host: string }> => {
  // A SecretDecryptionError propagates: a secret that cannot be decrypted must never read as absent.
  const resolved = options.configStore.resolveConfig();
  const host = options.host ?? resolved.webUiHost ?? '0.0.0.0';
  const port = options.port ?? resolved.webUiPort ?? BUILTIN_DEFAULTS.webUiPort;
  const expectedToken = resolveWebUiAuthToken(resolved);
  const log = options.logger ?? logger.child('web');

  if (!expectedToken) {
    if (!isLoopbackHost(host)) {
      throw new Error(
        `Refusing to start the control plane on ${host}:${port} without WEB_UI_AUTH_TOKEN. ` +
          'Set WEB_UI_AUTH_TOKEN, or bind to loopback with WEB_UI_HOST=127.0.0.1.'
      );
    }
    log.warn(
      'WEB_UI_AUTH_TOKEN is not set; the control plane is unauthenticated on %s:%d (loopback only).',
      host,
      port
    );
  }

  const server = createWebServer(options);

  return new Promise((resolve, reject) => {
    let settled = false;

    const errorHandler = (err: any) => {
      if (!settled) {
        settled = true;
        server.removeListener('listening', listeningHandler);
        reject(err);
      }
    };

    const listeningHandler = () => {
      if (!settled) {
        settled = true;
        server.removeListener('error', errorHandler);
        const addr = server.address() as net.AddressInfo | string | null;
        const actualPort = typeof addr === 'object' && addr !== null ? addr.port : port;
        const actualHost = typeof addr === 'object' && addr !== null ? addr.address : host;
        log.info('Web server listening on http://%s:%d', actualHost, actualPort);
        resolve({ server, port: actualPort, host: actualHost });
      }
    };

    server.once('error', errorHandler);
    server.once('listening', listeningHandler);
    server.listen(port, host);
  });
};

export const closeWebServer = async (server: http.Server): Promise<void> => {
  // Abort long-polls first so shutdown never stalls waiting on idle runners.
  SERVER_STATE.get(server)?.shutdownController.abort();

  // Stop accepting new connections before draining in-flight work.
  const closePromise = new Promise<void>((resolve, reject) => {
    server.close((err) => {
      if (err) {
        if ((err as NodeJS.ErrnoException).code === 'ERR_SERVER_NOT_RUNNING') {
          resolve();
          return;
        }
        reject(err);
      } else {
        logger.child('web').info('Web server closed cleanly.');
        resolve();
      }
    });
  });

  if (typeof server.closeIdleConnections === 'function') {
    try {
      server.closeIdleConnections();
    } catch {}
  }

  // Accepted work may still be writing, and the caller closes the database right after this resolves.
  const inFlight = SERVER_STATE.get(server)?.inFlight;
  if (inFlight && inFlight.size > 0) {
    const deadline = Date.now() + IN_FLIGHT_GRACE_MS;
    while (inFlight.size > 0) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        Promise.allSettled([...inFlight]),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, remaining);
          timer.unref();
        }),
      ]);
      if (timer) clearTimeout(timer);
    }
  }

  const sockets = SERVER_STATE.get(server)?.sockets;
  if (sockets) {
    for (const socket of sockets) {
      socket.destroy();
    }
    sockets.clear();
  }

  if (typeof server.closeAllConnections === 'function') {
    try {
      server.closeAllConnections();
    } catch {}
  }

  if (typeof server.closeIdleConnections === 'function') {
    try {
      server.closeIdleConnections();
    } catch {}
  }

  await closePromise;
};
