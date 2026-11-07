import type http from 'node:http';

export const MAX_BODY_BYTES = 64 * 1024; // 64 KB (65,536 bytes)

export class PayloadTooLargeError extends Error {
  readonly statusCode = 413;

  constructor(message = 'Request body exceeds maximum allowed size of 65536 bytes') {
    super(message);
    this.name = 'PayloadTooLargeError';
  }
}

export const STANDARD_SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
};

export const sendJson = (
  res: http.ServerResponse,
  status: number,
  data: unknown,
  headers: Record<string, string> = {}
): void => {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    ...STANDARD_SECURITY_HEADERS,
    ...headers,
  });
  res.end(JSON.stringify(data));
};

/** Path segments arrive percent-encoded; a malformed escape must be a 400, not a crash. */
export const safeDecodeSegment = (value: string): string | null => {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
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

export const readBody = async (
  req: http.IncomingMessage,
  resOrMaxBytes?: http.ServerResponse | number,
  optionalMaxBytes?: number
): Promise<string> => {
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

    const cleanup = () => {
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      req.off('close', onClose);
    };

    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
    req.on('close', onClose);
  });
};

// Empty-body policy: 'reject' (default) -> 400; 'allow' -> resolve to emptyBodyValue;
// 'malformed' -> no special case, so the empty string fails JSON.parse and 400s as malformed.
export type EmptyBodyPolicy = 'reject' | 'allow' | 'malformed';

export interface ReadJsonBodyOptions {
  emptyBody?: EmptyBodyPolicy;
  emptyBodyValue?: unknown;
}

export type ReadJsonBodyResult = { ok: true; body: unknown } | { ok: false };

const rejectEmptyBody = (res: http.ServerResponse): ReadJsonBodyResult => {
  sendJson(res, 400, { error: 'Request body cannot be empty' });
  return { ok: false };
};

const rejectMalformedJson = (res: http.ServerResponse): ReadJsonBodyResult => {
  sendJson(res, 400, { error: 'Malformed JSON payload' });
  return { ok: false };
};

// Reads and parses a JSON request body, writing the 400 response itself on failure.
export const readJsonBody = async (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  options: ReadJsonBodyOptions = {}
): Promise<ReadJsonBodyResult> => {
  const { emptyBody = 'reject', emptyBodyValue = {} } = options;
  const raw = await readBody(req, res);

  if (!raw.trim()) {
    if (emptyBody === 'allow') return { ok: true, body: emptyBodyValue };
    if (emptyBody === 'malformed') return rejectMalformedJson(res);
    return rejectEmptyBody(res);
  }

  try {
    return { ok: true, body: JSON.parse(raw) };
  } catch {
    return rejectMalformedJson(res);
  }
};

/** String field or undefined; non-string inputs are treated as absent. */
export const toStringOrUndefined = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined;

/** Trimmed, non-empty string or undefined; blank/absent/non-string inputs are absent. */
export const toTrimmedStringOrUndefined = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
};

/** Array of trimmed, non-empty strings, or undefined when the field is not an array. */
/** A dispatch refused by the safety floor or missing telemetry is a 4xx, not a 200 body. */
export const isSafetyBlockCode = (code?: string): boolean =>
  code === 'OVERAGE_PROTECTION_TRIGGERED' || code === 'TELEMETRY_UNAVAILABLE';

export const toStringArray = (value: unknown): string[] | undefined =>
  Array.isArray(value) ? value.map((item) => String(item).trim()).filter(Boolean) : undefined;

/** Finite number or undefined; absent/NaN/Infinity/non-number inputs are absent. */
export const toFiniteNumberOrUndefined = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;
