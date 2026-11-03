import http from 'node:http';
import type net from 'node:net';
import { handleRequest, type WebServerOptions } from './routes.js';
import { logger } from '../logs/logger.js';
import { resolveWebUiAuthToken, BUILTIN_DEFAULTS } from '../config/schema.js';

export { type WebServerOptions };

export const createWebServer = (options: WebServerOptions): http.Server => {
  const server = http.createServer(async (req, res) => {
    try {
      await handleRequest(req, res, options);
    } catch (err: any) {
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
  });

  const sockets = new Set<net.Socket>();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => {
      sockets.delete(socket);
    });
  });

  (server as any).__activeSockets = sockets;

  return server;
};

/** Only a literal loopback bind is reachable from this machine alone. */
const isLoopbackHost = (host: string): boolean => {
  const h = host.trim().toLowerCase();
  return h === '127.0.0.1' || h === '::1' || h === 'localhost';
};

export const startWebServer = async (
  options: WebServerOptions
): Promise<{ server: http.Server; port: number; host: string }> => {
  // A SecretDecryptionError from resolveConfig propagates: a secret that cannot be decrypted
  // must never be treated as an absent one.
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

// Performs graceful teardown of the web server, closing active connections and releasing the port.
export const closeWebServer = async (server: http.Server): Promise<void> => {
  return new Promise((resolve, reject) => {
    const sockets = (server as any).__activeSockets as Set<net.Socket> | undefined;
    if (sockets) {
      for (const socket of sockets) {
        socket.destroy();
      }
      sockets.clear();
    }

    if (typeof server.closeAllConnections === 'function') {
      try {
        server.closeAllConnections();
      } catch {
        // ignore
      }
    }

    if (typeof server.closeIdleConnections === 'function') {
      try {
        server.closeIdleConnections();
      } catch {
        // ignore
      }
    }

    server.close((err) => {
      if (err) {
        if ((err as any).code === 'ERR_SERVER_NOT_RUNNING') {
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
};

export default {
  createWebServer,
  startWebServer,
  closeWebServer,
};
