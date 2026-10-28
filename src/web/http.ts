import type http from 'node:http';

export const MAX_BODY_BYTES = 64 * 1024; // 64 KB (65,536 bytes)

export class PayloadTooLargeError extends Error {
  readonly statusCode = 413;

  constructor(message = 'Request body exceeds maximum allowed size of 65536 bytes') {
    super(message);
    this.name = 'PayloadTooLargeError';
  }
}

export const sendJson = (
  res: http.ServerResponse,
  status: number,
  data: unknown,
  headers: Record<string, string> = {}
): void => {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(data));
};

export const methodNotAllowed = (res: http.ServerResponse): void => {
  sendJson(res, 405, { error: 'Method Not Allowed' });
};

export const sendPayloadTooLarge = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  message = 'Request body exceeds maximum allowed size of 65536 bytes'
): void => {
  if (res.headersSent) return;

  res.writeHead(413, {
    'Content-Type': 'application/json',
    Connection: 'close',
  });

  const payload = JSON.stringify({
    error: 'Payload Too Large',
    message,
  });

  res.write(payload);

  if (req.readableEnded || req.complete) {
    if (!res.writableEnded && !res.destroyed) {
      res.end();
    }
    return;
  }

  let cleanupCalled = false;
  let timer: NodeJS.Timeout | undefined;

  const cleanup = () => {
    if (cleanupCalled) return;
    cleanupCalled = true;
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    req.off('data', onData);
    req.off('end', onEnd);
    req.off('error', onError);
    req.off('close', onClose);
    res.off('close', onClose);
    res.off('finish', onClose);
  };

  const safeEnd = (destroySocket = false) => {
    cleanup();
    try {
      if (!res.writableEnded && !res.destroyed) {
        res.end();
      }
    } catch {}
    if (destroySocket) {
      try {
        req.destroy();
      } catch {}
    }
  };

  const onData = () => {
    // Discard incoming chunks to drain the socket receive buffer
  };

  const onEnd = () => {
    safeEnd(false);
  };

  const onClose = () => {
    safeEnd(false);
  };

  const onError = () => {
    safeEnd(false);
  };

  // Safety timeout: abort uncooperative or infinite streams after 3000ms
  timer = setTimeout(() => {
    safeEnd(true);
  }, 3000);
  timer.unref();

  req.on('data', onData);
  req.on('end', onEnd);
  req.on('error', onError);
  req.on('close', onClose);
  res.once('close', onClose);
  res.once('finish', onClose);

  req.resume();
};

export async function readBody(
  req: http.IncomingMessage,
  resOrMaxBytes?: http.ServerResponse | number,
  optionalMaxBytes?: number
): Promise<string> {
  let res: http.ServerResponse | undefined;
  let maxBytes = MAX_BODY_BYTES;

  if (typeof resOrMaxBytes === 'number') {
    maxBytes = resOrMaxBytes;
  } else if (resOrMaxBytes) {
    res = resOrMaxBytes;
    if (typeof optionalMaxBytes === 'number') {
      maxBytes = optionalMaxBytes;
    }
  }

  if (req.readableEnded || req.complete) {
    return '';
  }
  if (req.destroyed) {
    throw new Error('Cannot read body from destroyed request');
  }

  return new Promise<string>((resolve, reject) => {
    let totalBytes = 0;
    const chunks: Buffer[] = [];
    let exceeded = false;

    const onData = (chunk: Buffer | string) => {
      if (exceeded) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += buf.length;

      if (totalBytes > maxBytes) {
        exceeded = true;
        chunks.length = 0;
        cleanup();
        const msg = `Request body exceeds maximum allowed size of ${maxBytes} bytes`;
        if (res && !res.headersSent) {
          sendPayloadTooLarge(req, res, msg);
        }
        reject(new PayloadTooLargeError(msg));
        return;
      }

      chunks.push(buf);
    };

    const onEnd = () => {
      if (exceeded) return;
      cleanup();
      resolve(Buffer.concat(chunks).toString('utf-8'));
    };

    const onError = (err: Error) => {
      if (exceeded) return;
      cleanup();
      reject(err);
    };

    const onClose = () => {
      if (exceeded) return;
      cleanup();
      if (!req.complete && !req.readableEnded) {
        reject(new Error('Request closed before body was fully received'));
      }
    };

    function cleanup() {
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      req.off('close', onClose);
    }

    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
    req.on('close', onClose);
  });
}
