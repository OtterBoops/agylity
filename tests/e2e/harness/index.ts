import http from 'node:http';
import dgram from 'node:dgram';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * Safely imports a module, returning null if the file does not yet exist.
 * This allows progressive testability while milestones are implemented.
 */
export const tryImport = async <T>(specifier: string): Promise<T | null> => {
  try {
    return await import(specifier);
  } catch (err: any) {
    if (
      err.code === 'ERR_MODULE_NOT_FOUND' ||
      err.message?.includes('Cannot find module') ||
      err.message?.includes('Failed to load')
    ) {
      return null;
    }
    throw err;
  }
};

/**
 * Creates an isolated temporary directory for test databases and state files.
 */
export const makeTempDir = (prefix = 'agylity_test_'): { dir: string; cleanup: () => void } => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return {
    dir,
    cleanup: () => {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore cleanup errors on open handles
      }
    },
  };
};

export interface MockRpcOptions {
  expectedCsrfToken?: string;
  statusCode?: number;
  responseBody?: unknown;
  onRequest?: (req: http.IncomingMessage, body: string) => void;
}

/**
 * Creates a mock HTTP server simulating Antigravity Language Server Connect-RPC.
 */
export const createMockRpcServer = async (
  port = 0,
  options: MockRpcOptions = {}
): Promise<{ server: http.Server; port: number; url: string; close: () => Promise<void> }> => {
  const expectedToken = options.expectedCsrfToken ?? 'test-csrf-token';
  const defaultBody = options.responseBody ?? {
    clientModelConfigs: [
      {
        model: 'MODEL_CLAUDE_3_5_SONNET',
        modelFamily: 'claude',
        displayName: 'Claude 3.5 Sonnet',
        remainingFraction: 0.82,
        resetTime: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
      },
      {
        model: 'MODEL_GEMINI_2_5_PRO',
        modelFamily: 'gemini-argon',
        displayName: 'Gemini 2.5 Pro',
        remainingFraction: 0.5,
        resetTime: new Date(Date.now() + 12 * 3600 * 1000).toISOString(),
      },
      {
        model: 'MODEL_GEMINI_2_5_FLASH',
        modelFamily: 'gemini-flash',
        displayName: 'Gemini 2.5 Flash',
        remainingFraction: 0.95,
        resetTime: new Date(Date.now() + 3 * 3600 * 1000).toISOString(),
      },
    ],
  };

  const server = http.createServer((req, res) => {
    let rawBody = '';
    req.on('data', (chunk) => {
      rawBody += chunk;
    });

    req.on('end', () => {
      if (options.onRequest) {
        options.onRequest(req, rawBody);
      }

      if (req.method !== 'POST') {
        res.writeHead(405, { 'Content-Type': 'text/plain' });
        res.end('Method Not Allowed');
        return;
      }

      if (req.url !== '/exa.language_server_pb.LanguageServerService/GetCascadeModelConfigData') {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('404 page not found');
        return;
      }

      const csrf = req.headers['x-codeium-csrf-token'];
      if (!csrf || csrf !== expectedToken) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            code: 'unauthenticated',
            message: 'unauthenticated: invalid or missing CSRF token',
          })
        );
        return;
      }

      const contentType = req.headers['content-type'];
      if (!contentType || !contentType.includes('application/json')) {
        res.writeHead(415, { 'Content-Type': 'text/plain' });
        res.end('Unsupported Media Type');
        return;
      }

      const code = options.statusCode ?? 200;
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(
        typeof options.responseBody === 'string'
          ? options.responseBody
          : JSON.stringify(defaultBody)
      );
    });
  });

  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', () => resolve()));
  const addr = server.address() as { port: number };

  return {
    server,
    port: addr.port,
    url: `http://127.0.0.1:${addr.port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve()))
      ),
  };
};

/**
 * Creates a mock UDP socket listener to verify Wake-on-LAN Magic Packets.
 */
export const createMockUdpListener = async (
  port = 0
): Promise<{
  socket: dgram.Socket;
  port: number;
  packets: Buffer[];
  close: () => Promise<void>;
}> => {
  const socket = dgram.createSocket('udp4');
  const packets: Buffer[] = [];

  socket.on('message', (msg) => {
    packets.push(Buffer.from(msg));
  });

  await new Promise<void>((resolve) => socket.bind(port, '127.0.0.1', () => resolve()));
  const addr = socket.address();

  return {
    socket,
    port: addr.port,
    packets,
    close: () => new Promise<void>((resolve) => socket.close(() => resolve())),
  };
};

/**
 * Validates whether a buffer is a compliant magic packet frame.
 */
export const isValidMagicPacket = (buf: Buffer, expectedMac: string): boolean => {
  if (buf.length !== 102) return false;

  // First 6 bytes must be 0xFF
  for (let i = 0; i < 6; i++) {
    if (buf[i] !== 0xff) return false;
  }

  // Normalize MAC into 6 bytes
  const stripped = expectedMac.replace(/[:-]/g, '').trim().toLowerCase();
  if (stripped.length !== 12) return false;
  const macBytes = Buffer.from(stripped, 'hex');

  // Verify 16 consecutive repetitions of the 6-byte MAC address
  for (let rep = 0; rep < 16; rep++) {
    for (let b = 0; b < 6; b++) {
      if (buf[6 + rep * 6 + b] !== macBytes[b]) return false;
    }
  }

  return true;
};

/**
 * Mock Discord interaction object simulating commands, selects, and modals.
 */
export const createMockDiscordInteraction = (
  options: {
    userId?: string;
    channelId?: string;
    commandName?: string;
    selectedRepo?: string;
    taskPrompt?: string;
  } = {}
) => {
  let deferred = false;
  let deferredAt: number | null = null;
  let replied = false;
  let replyData: unknown = null;
  let editedData: unknown = null;
  let modalShown: unknown = null;

  return {
    user: { id: options.userId ?? 'user-123', username: 'otter' },
    channelId: options.channelId ?? 'channel-sentry-1',
    commandName: options.commandName ?? 'quota',
    values: options.selectedRepo ? [options.selectedRepo] : [],
    fields: {
      getTextInputValue: (id: string) =>
        id === 'task_prompt' ? (options.taskPrompt ?? 'Fix memory leak') : '',
    },
    isChatInputCommand: () => options.commandName !== undefined,
    isStringSelectMenu: () => options.selectedRepo !== undefined,
    isModalSubmit: () => options.taskPrompt !== undefined,
    async deferReply(opts?: { ephemeral?: boolean }) {
      deferred = true;
      deferredAt = Date.now();
      return { deferred: true, opts };
    },
    async reply(payload: unknown) {
      replied = true;
      replyData = payload;
      return payload;
    },
    async editReply(payload: unknown) {
      editedData = payload;
      return payload;
    },
    async showModal(modal: unknown) {
      modalShown = modal;
      return modal;
    },
    get state() {
      return { deferred, deferredAt, replied, replyData, editedData, modalShown };
    },
  };
};
