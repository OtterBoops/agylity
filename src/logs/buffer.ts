import { format } from 'node:util';

export const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export const LOG_LEVELS = Object.keys(LEVEL_PRIORITY) as LogLevel[];

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

// Masks known secret values and common token shapes before text is retained or served.
export const redact = (text: string, secrets: Iterable<string | undefined> = []): string => {
  let out = text;
  for (const s of secrets) {
    if (!s) continue;
    out = out.split(s).join('[redacted]');
    // A secret inside a URL appears percent-encoded, so match that form too.
    const encoded = encodeURIComponent(s);
    if (encoded !== s) out = out.split(encoded).join('[redacted]');
  }
  out = out.replace(PATTERNS[0]!, '[redacted]');
  out = out.replace(PATTERNS[1]!, '$1[redacted]');
  return out;
};

// Bounded in-memory ring buffer of log lines. Lost on restart by design.
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

  /** Redacts arbitrary text (e.g. console output) using this buffer's secret set. */
  redactText(text: string): string {
    return redact(text, this.secretsProvider());
  }

  /** Entries with id greater than `sinceId`, optionally filtered to a minimum level. */
  since(sinceId = 0, minLevel: LogLevel = 'debug', limit = 500): LogEntry[] {
    if (limit <= 0) return [];
    return this.entries
      .filter((e) => e.id > sinceId && LEVEL_PRIORITY[e.level] >= LEVEL_PRIORITY[minLevel])
      .slice(-limit);
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

// Tees console.log/info/warn/error/debug into the buffer while still printing normally.
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
        // Suppress Node runtime experimental feature warnings from polluting UI log buffer as errors
        if (!msg.includes('ExperimentalWarning: SQLite is an experimental feature')) {
          buffer.push(level, msg);
        }
        // Print the redacted form so stdout matches the buffered copy.
        output = [buffer.redactText(msg)];
      } catch {
        // never let logging break the process
      }
      original(...output);
    };
  }

  return () => {
    for (const [name, fn] of originals) (console as any)[name] = fn;
  };
};
