import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { LogBuffer } from '../../../src/logs/buffer.js';
import type { LogRecord, LogSink } from '../../../src/logs/logger.js';

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

/** Sink that forwards records directly to an in-memory LogBuffer. */
export const createBufferSink =
  (buffer: LogBuffer): LogSink =>
  (record: LogRecord) => {
    buffer.push(record.level, record.formatted);
  };

/** In-memory sink recording log entries for assertions. */
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
