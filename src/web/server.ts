import http from 'node:http';
import type net from 'node:net';
import { handleRequest, type WebServerOptions } from './routes.js';

export { type WebServerOptions };

/**
 * Creates a native node:http server instance wired to Agylity REST route handlers.
 */
export const createWebServer = (options: WebServerOptions): http.Server => {
  const server = http.createServer(async (req, res) => {
    try {
      await handleRequest(req, res, options);
    } catch (err: any) {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Internal Server Error', message: err?.message }));
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

/**
 * Starts the native HTTP server listening on the configured host and port.
 * Handles port collisions (EADDRINUSE) cleanly by rejecting the returned promise.
 */
export const startWebServer = async (
  options: WebServerOptions
): Promise<{ server: http.Server; port: number; host: string }> => {
  const resolved = options.configStore.resolveConfig();
  const host = options.host ?? resolved.webUiHost ?? '0.0.0.0';
  const port = options.port ?? resolved.webUiPort ?? 3000;
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
        resolve({ server, port: actualPort, host: actualHost });
      }
    };

    server.once('error', errorHandler);
    server.once('listening', listeningHandler);
    server.listen(port, host);
  });
};

/**
 * Performs graceful teardown of the web server, closing active connections and releasing the port.
 */
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
