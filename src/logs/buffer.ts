import { format } from 'node:util';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  id: number;
  ts: string;
  level: LogLevel;
  message: string;
}

const PATTERNS: RegExp[] = [
  // Discord bot tokens: <id>.<ts>.<hmac>
  /[MNO][A-Za-z\d_-]{23,27}\.[A-Za-z\d_-]{6,7}\.[A-Za-z\d_-]{27,}/g,
  // key=value / key: value pairs for sensitive names
  /((?:token|secret|password|csrf[_-]?token|x-codeium-csrf-token)["']?\s*[:=]\s*["']?)[^\s"',}]+/gi,
];

/**
 * Masks known secret values and common token shapes before text is retained or served.
 */
export const redact = (text: string, secrets: Iterable<string | undefined> = []): string => {
  let out = text;
  for (const s of secrets) {
    if (s && s.length >= 6) out = out.split(s).join('[redacted]');
  }
  out = out.replace(PATTERNS[0]!, '[redacted]');
  out = out.replace(PATTERNS[1]!, '$1[redacted]');
  return out;
};

/**
 * Bounded in-memory ring buffer of log lines. Lost on restart by design.
 */
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

  /** Entries with id greater than `sinceId`, optionally filtered to a minimum level. */
  since(sinceId = 0, minLevel: LogLevel = 'debug', limit = 500): LogEntry[] {
    const rank: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };
    return this.entries
      .filter((e) => e.id > sinceId && rank[e.level] >= rank[minLevel])
      .slice(-limit);
  }

  get size(): number {
    return this.entries.length;
  }

  clear(): void {
    this.entries = [];
  }
}

/**
 * Tees console.log/info/warn/error/debug into the buffer while still printing normally.
 * Returns an uninstall function restoring the original console methods.
 */
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
      try {
        buffer.push(level, format(...args));
      } catch {
        // never let logging break the process
      }
      original(...args);
    };
  }

  return () => {
    for (const [name, fn] of originals) (console as any)[name] = fn;
  };
};
