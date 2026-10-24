import { format } from 'node:util';
import type { LogBuffer, LogLevel } from './buffer.js';

export type { LogLevel };

export interface LogRecord {
  level: LogLevel;
  namespace?: string;
  message: string;
  timestamp: string;
  args: unknown[];
  formatted: string;
}

export type LogSink = (record: LogRecord) => void;

export interface LoggerOptions {
  namespace?: string;
  minLevel?: LogLevel;
  sinks?: LogSink[];
  parent?: DefaultLogger;
}

export interface Logger {
  readonly namespace?: string;
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
  child(namespace: string): Logger;
  setLevel(level: LogLevel): void;
  getLevel(): LogLevel;
  addSink(sink: LogSink): () => void;
  removeSink(sink: LogSink): void;
  clearSinks(): void;
  setSinks(sinks: LogSink[]): void;
}

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export class DefaultLogger implements Logger {
  public readonly namespace?: string;
  private minLevel?: LogLevel;
  private customSinks?: LogSink[];
  private readonly parent?: DefaultLogger;

  constructor(options: LoggerOptions = {}) {
    this.namespace = options.namespace;
    this.minLevel = options.minLevel;
    this.customSinks = options.sinks ? [...options.sinks] : undefined;
    this.parent = options.parent;
  }

  public getLevel(): LogLevel {
    if (this.minLevel) return this.minLevel;
    if (this.parent) return this.parent.getLevel();
    const envLevel = process.env.LOG_LEVEL?.trim().toLowerCase();
    if (envLevel && envLevel in LEVEL_PRIORITY) {
      return envLevel as LogLevel;
    }
    return 'info';
  }

  public setLevel(level: LogLevel): void {
    this.minLevel = level;
  }

  public getSinks(): LogSink[] {
    if (this.customSinks) return this.customSinks;
    if (this.parent) return this.parent.getSinks();
    return [createConsoleSink()];
  }

  public addSink(sink: LogSink): () => void {
    if (!this.customSinks) {
      this.customSinks = this.parent
        ? [...this.parent.getSinks(), sink]
        : [createConsoleSink(), sink];
    } else {
      this.customSinks.push(sink);
    }
    return () => this.removeSink(sink);
  }

  public removeSink(sink: LogSink): void {
    if (!this.customSinks) {
      this.customSinks = this.parent ? [...this.parent.getSinks()] : [createConsoleSink()];
    }
    this.customSinks = this.customSinks.filter((s) => s !== sink);
  }

  public clearSinks(): void {
    this.customSinks = [];
  }

  public setSinks(sinks: LogSink[]): void {
    this.customSinks = [...sinks];
  }

  public child(childNamespace: string): Logger {
    const combined = this.namespace ? `${this.namespace}:${childNamespace}` : childNamespace;
    return new DefaultLogger({
      namespace: combined,
      parent: this,
    });
  }

  public debug(message: string, ...args: unknown[]): void {
    this.log('debug', message, ...args);
  }

  public info(message: string, ...args: unknown[]): void {
    this.log('info', message, ...args);
  }

  public warn(message: string, ...args: unknown[]): void {
    this.log('warn', message, ...args);
  }

  public error(message: string, ...args: unknown[]): void {
    this.log('error', message, ...args);
  }

  private log(level: LogLevel, message: string, ...args: unknown[]): void {
    const currentMin = this.getLevel();
    if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[currentMin]) {
      return;
    }

    try {
      const rawFormatted = format(message, ...args);
      const tag = this.namespace ? `[${this.namespace}]` : '';
      const formatted = tag
        ? rawFormatted.startsWith(tag)
          ? rawFormatted
          : `${tag} ${rawFormatted}`
        : rawFormatted;

      const record: LogRecord = {
        level,
        namespace: this.namespace,
        message,
        timestamp: new Date().toISOString(),
        args,
        formatted,
      };

      const sinks = this.getSinks();
      for (const sink of sinks) {
        try {
          sink(record);
        } catch {
          // A misbehaving sink must never interrupt the application
        }
      }
    } catch {
      // Logging formatting must never crash execution
    }
  }
}

/**
 * Standard console sink writing to stdout / stderr via console methods.
 */
export const createConsoleSink = (): LogSink => {
  return (record: LogRecord) => {
    switch (record.level) {
      case 'debug':
        console.debug(record.formatted);
        break;
      case 'info':
        console.log(record.formatted);
        break;
      case 'warn':
        console.warn(record.formatted);
        break;
      case 'error':
        console.error(record.formatted);
        break;
    }
  };
};

/**
 * Sink that forwards records directly to an in-memory LogBuffer.
 */
export const createBufferSink = (buffer: LogBuffer): LogSink => {
  return (record: LogRecord) => {
    buffer.push(record.level, record.formatted);
  };
};

/**
 * In-memory sink recording log entries for assertions and tests.
 */
export const createMemorySink = () => {
  const records: LogRecord[] = [];
  return {
    sink: (record: LogRecord) => {
      records.push(record);
    },
    get records() {
      return [...records];
    },
    clear: () => {
      records.length = 0;
    },
  };
};

/**
 * Factory for creating custom or scoped loggers.
 */
export const createLogger = (optionsOrNamespace?: LoggerOptions | string): Logger => {
  if (typeof optionsOrNamespace === 'string') {
    return new DefaultLogger({ namespace: optionsOrNamespace });
  }
  return new DefaultLogger(optionsOrNamespace);
};

/**
 * Root universal logger instance.
 */
export const logger: Logger = createLogger();
