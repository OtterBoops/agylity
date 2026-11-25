import { format } from 'node:util';
import type { LogEntry, LogLevel } from '../shared/contracts.js';

// The log record the API serves is a wire payload, declared once in the shared contracts.
export type { LogEntry, LogLevel };

export const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export const LOG_LEVELS = Object.keys(LEVEL_PRIORITY) as LogLevel[];

const REDACTED = '[redacted]';

const DISCORD_TOKEN_PATTERN = /[MNO][A-Za-z\d_-]{23,27}\.[A-Za-z\d_-]{6,7}\.[A-Za-z\d_-]{27,}/g;
// A bare bearer credential outside a header line still names its scheme, so the scheme stays.
const BARE_BEARER_PATTERN = /\b(bearer\s+)[A-Za-z\d._~+/-]{8,}=*/gi;

// A proxy/fetch error keeps the header name, never the credential that rode on it.
const AUTH_PREFIX = `(?:proxy-)?authorization["']?\\s*[:=]\\s*`;
const AUTH_PATTERNS: Array<[RegExp, string]> = [
  [new RegExp(`(${AUTH_PREFIX})"(?:\\\\.|[^"\\\\])*"?`, 'gi'), `$1"${REDACTED}"`],
  [new RegExp(`(${AUTH_PREFIX})'(?:\\\\.|[^'\\\\])*'?`, 'gi'), `$1'${REDACTED}'`],
  [new RegExp(`(${AUTH_PREFIX}(?:(?:bearer|basic|token)\\s+)?)[^\\s"',}]+`, 'gi'), `$1${REDACTED}`],
];

// The value runs through its closing quote or past a scheme, so a two-word credential keeps no tail.
const KEYWORD_PREFIX = `(?:token|secret|password|csrf[_-]?token|x-codeium-csrf-token)["']?\\s*[:=]\\s*(?:(?:bearer|basic|token)\\s+)?`;

const KEYWORD_PATTERNS: Array<[RegExp, string]> = [
  [new RegExp(`(${KEYWORD_PREFIX})"(?:\\\\.|[^"\\\\])*"?`, 'gi'), `$1"${REDACTED}"`],
  [new RegExp(`(${KEYWORD_PREFIX})'(?:\\\\.|[^'\\\\])*'?`, 'gi'), `$1'${REDACTED}'`],
  [new RegExp(`(${KEYWORD_PREFIX})[^\\s"',}]+`, 'gi'), `$1${REDACTED}`],
];

const redact = (text: string, secrets: Iterable<string | undefined> = []): string => {
  let out = text;
  for (const s of secrets) {
    if (!s) continue;
    out = out.split(s).join(REDACTED);
    const encoded = encodeURIComponent(s);
    if (encoded !== s) out = out.split(encoded).join(REDACTED);
  }
  out = out.replace(DISCORD_TOKEN_PATTERN, REDACTED);
  for (const [pattern, replacement] of AUTH_PATTERNS) out = out.replace(pattern, replacement);
  out = out.replace(BARE_BEARER_PATTERN, `$1${REDACTED}`);
  for (const [pattern, replacement] of KEYWORD_PATTERNS) out = out.replace(pattern, replacement);
  return out;
};

// Bounded in-memory ring buffer; entries are lost on restart by design.
export class LogBuffer {
  private entries: LogEntry[] = [];
  private nextId = 1;

  constructor(
    private readonly capacity = 1000,
    private readonly secretsProvider: () => Iterable<string | undefined> = () => []
  ) {}

  push(level: LogLevel, message: string): LogEntry {
    const entry: LogEntry = {
      id: this.nextId++,
      ts: new Date().toISOString(),
      level,
      message: redact(message, this.secretsProvider()).slice(0, 4000),
    };
    this.entries.push(entry);
    if (this.entries.length > this.capacity) {
      this.entries.splice(0, this.entries.length - this.capacity);
    }
    return entry;
  }

  redactText(text: string): string {
    return redact(text, this.secretsProvider());
  }

  since(sinceId = 0, minLevel: LogLevel = 'debug', limit = 500): LogEntry[] {
    if (limit <= 0) return [];
    const matches = this.entries.filter(
      (e) => e.id > sinceId && LEVEL_PRIORITY[e.level] >= LEVEL_PRIORITY[minLevel]
    );
    // A first load wants the newest page; a polled cursor must page forward or it skips lines.
    return sinceId > 0 ? matches.slice(0, limit) : matches.slice(-limit);
  }

  get size(): number {
    return this.entries.length;
  }

  get latestId(): number {
    return this.nextId - 1;
  }

  clear(): void {
    this.entries = [];
  }
}

export const installConsoleTee = (buffer: LogBuffer): (() => void) => {
  const methods: Array<[keyof Console, LogLevel]> = [
    ['log', 'info'],
    ['info', 'info'],
    ['warn', 'warn'],
    ['error', 'error'],
    ['debug', 'debug'],
  ];
  const originals = new Map<keyof Console, (...args: unknown[]) => void>();

  for (const [name, level] of methods) {
    const original = (console[name] as (...args: unknown[]) => void).bind(console);
    originals.set(name, console[name] as (...args: unknown[]) => void);
    (console as any)[name] = (...args: unknown[]) => {
      let output: unknown[] = args;
      try {
        const msg = format(...args);
        if (!msg.includes('ExperimentalWarning: SQLite is an experimental feature')) {
          buffer.push(level, msg);
        }
        output = [buffer.redactText(msg)];
      } catch {}
      original(...output);
    };
  }

  return () => {
    for (const [name, fn] of originals) (console as any)[name] = fn;
  };
};
