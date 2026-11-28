import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  encryptSecret,
  decryptSecret,
  isSecretKey,
  resolveMasterKey,
  ENCRYPTION_PREFIX,
  SECRET_JSON_MARKER,
} from './crypto.js';
import { ensureTableSchema, type ColumnSpec } from './schema.js';
import { applyMigrations } from './migrations.js';
import { logger } from '../logs/logger.js';

interface SettingRecord {
  key: string;
  value: string;
  updated_at: string;
}

interface DatabaseConnectionOptions {
  path: string;
  keyPath?: string;
  busyTimeoutMs?: number;
}

type DatabaseOptions = string | DatabaseConnectionOptions;

// A marked payload was JSON; anything else is a legacy bare-string secret and stays a string.
const decodeSecretPayload = (plaintext: string): unknown => {
  if (!plaintext.startsWith(SECRET_JSON_MARKER)) return plaintext;
  try {
    return JSON.parse(plaintext.slice(SECRET_JSON_MARKER.length));
  } catch {
    return plaintext.slice(SECRET_JSON_MARKER.length);
  }
};

const SETTINGS_COLUMNS: readonly ColumnSpec[] = [
  { name: 'key', ddl: 'key TEXT PRIMARY KEY' },
  { name: 'value', ddl: 'value TEXT NOT NULL' },
  { name: 'updated_at', ddl: "updated_at TEXT NOT NULL DEFAULT (datetime('now'))" },
];

export class AppDatabase {
  private db: DatabaseSync;
  private dbPath: string;
  private masterKey: Buffer;
  private selectKeyStmt: StatementSync;
  private selectRecordStmt: StatementSync;
  private selectAllStmt: StatementSync;
  private upsertStmt: StatementSync;
  private deleteStmt: StatementSync;
  private clearStmt: StatementSync;

  constructor(options: DatabaseOptions = 'data/agylity.db') {
    this.dbPath = typeof options === 'string' ? options : options.path;
    const keyPath =
      typeof options === 'object' && options.keyPath
        ? options.keyPath
        : this.dbPath !== ':memory:'
          ? join(dirname(this.dbPath), '.agylity.key')
          : ':memory:';
    this.masterKey = resolveMasterKey(keyPath);

    if (this.dbPath !== ':memory:') {
      const parentDir = dirname(this.dbPath);
      if (parentDir && parentDir !== '.' && !existsSync(parentDir)) {
        mkdirSync(parentDir, { recursive: true });
      }
    }

    const busyTimeoutMs =
      typeof options === 'object' && options.busyTimeoutMs !== undefined
        ? options.busyTimeoutMs
        : 5000;

    this.db = new DatabaseSync(this.dbPath);
    this.initPragmas(busyTimeoutMs);
    this.runMigrations();

    this.selectKeyStmt = this.db.prepare('SELECT value FROM settings WHERE key = ?');
    this.selectRecordStmt = this.db.prepare(
      'SELECT key, value, updated_at FROM settings WHERE key = ?'
    );
    this.selectAllStmt = this.db.prepare('SELECT key, value, updated_at FROM settings');
    this.upsertStmt = this.db.prepare(
      "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now')) " +
        'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at'
    );
    this.deleteStmt = this.db.prepare('DELETE FROM settings WHERE key = ?');
    this.clearStmt = this.db.prepare('DELETE FROM settings');
  }

  private initPragmas(busyTimeoutMs = 5000): void {
    this.db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(busyTimeoutMs))};`);
    this.db.exec('PRAGMA synchronous = NORMAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    // WAL lets the dashboard read while a writer holds the database, but converting a fresh file needs
    // an exclusive lock, so a second process opening it at the same moment must not fail the boot.
    const journalMode = String(
      (this.db.prepare('PRAGMA journal_mode').get() as { journal_mode?: string } | undefined)
        ?.journal_mode ?? ''
    ).toLowerCase();
    if (journalMode === 'wal') return;
    try {
      this.db.exec('PRAGMA journal_mode = WAL;');
    } catch (err) {
      logger
        .child('storage')
        .warn(
          'Database stayed in %s journal mode: %s',
          journalMode || 'unknown',
          err instanceof Error ? err.message : String(err)
        );
    }
  }

  private runMigrations(): void {
    ensureTableSchema(this.db, 'settings', SETTINGS_COLUMNS);
    applyMigrations(this.db);
  }

  public getRawDb(): DatabaseSync {
    return this.db;
  }

  /** The key this database actually encrypts with, which a custom `keyPath` or `:memory:` overrides. */
  public getMasterKey(): Buffer {
    return this.masterKey;
  }

  public get<T = unknown>(key: string): T | undefined {
    const row = this.selectKeyStmt.get(key) as { value: string } | undefined;
    if (!row) return undefined;
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.value);
    } catch {
      parsed = row.value;
    }
    if (typeof parsed === 'string' && parsed.startsWith(ENCRYPTION_PREFIX)) {
      return decodeSecretPayload(decryptSecret(parsed, this.masterKey)) as T;
    }
    return parsed as T;
  }

  public getRaw(key: string): string | undefined {
    const row = this.selectKeyStmt.get(key) as { value: string } | undefined;
    return row ? row.value : undefined;
  }

  public getRecord(key: string): SettingRecord | undefined {
    return this.selectRecordStmt.get(key) as unknown as SettingRecord | undefined;
  }

  public set(key: string, value: unknown): void {
    let finalValue = value;
    if (isSecretKey(key) && value !== undefined && value !== null) {
      const payload =
        typeof value === 'string' ? value : `${SECRET_JSON_MARKER}${JSON.stringify(value)}`;
      if (payload.trim() !== '') {
        finalValue = encryptSecret(payload, this.masterKey);
      }
    }
    const serialized = typeof finalValue === 'undefined' ? 'null' : JSON.stringify(finalValue);
    this.upsertStmt.run(key, serialized);
  }

  public delete(key: string): boolean {
    const info = this.deleteStmt.run(key) as unknown as { changes?: number };
    return (info?.changes ?? 0) > 0;
  }

  public getAll(): Record<string, unknown> {
    const rows = this.selectAllStmt.all() as unknown as Array<{ key: string; value: string }>;
    return Object.fromEntries(
      rows.map((r) => {
        let val: unknown;
        try {
          val = JSON.parse(r.value);
        } catch {
          val = r.value;
        }
        if (typeof val === 'string' && val.startsWith(ENCRYPTION_PREFIX)) {
          val = decodeSecretPayload(decryptSecret(val, this.masterKey));
        }
        return [r.key, val];
      })
    );
  }

  public getAllRecords(): SettingRecord[] {
    return this.selectAllStmt.all() as unknown as SettingRecord[];
  }

  public clear(): void {
    this.clearStmt.run();
  }

  public close(): void {
    this.db.close();
  }
}

export * from './crypto.js';
