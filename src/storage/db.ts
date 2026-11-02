import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  encryptSecret,
  decryptSecret,
  isSecretKey,
  resolveMasterKey,
  ENCRYPTION_PREFIX,
} from './crypto.js';
import { logger } from '../logs/logger.js';

export interface SettingRecord {
  key: string;
  value: string; // JSON encoded
  updated_at: string;
}

export interface DatabaseConnectionOptions {
  path: string;
  keyPath?: string;
  busyTimeoutMs?: number;
}

export type DatabaseOptions = string | DatabaseConnectionOptions;

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
          : undefined;
    this.masterKey = resolveMasterKey(keyPath);

    // Directory auto-creation guard: if path !== ':memory:' mkdirSync(dirname(path), { recursive: true })
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

    // Prepare cached SQL statements for fast CRUD operations
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
    // Enable WAL mode for high concurrency
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA synchronous = NORMAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(busyTimeoutMs))};`);
  }

  private runMigrations(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);

    // CREATE TABLE IF NOT EXISTS never upgrades an existing table, so diff the columns too.
    const expected: Array<[string, string]> = [
      ['key', 'TEXT PRIMARY KEY'],
      ['value', 'TEXT NOT NULL'],
      ['updated_at', "TEXT NOT NULL DEFAULT (datetime('now'))"],
    ];
    const existing = new Set(
      (this.db.prepare('PRAGMA table_info(settings)').all() as Array<{ name: string }>).map(
        (c) => c.name
      )
    );
    for (const [name, definition] of expected) {
      if (existing.has(name)) continue;
      // ALTER TABLE cannot add a primary key, nor a NOT NULL column without a default.
      if (definition.includes('PRIMARY KEY') || definition === 'TEXT NOT NULL') {
        logger
          .child('storage')
          .warn('settings table is missing column %s and it cannot be added automatically', name);
        continue;
      }
      this.db.exec(`ALTER TABLE settings ADD COLUMN ${name} ${definition}`);
      logger.child('storage').info('Added missing column settings.%s', name);
    }
  }

  public getRawDb(): DatabaseSync {
    return this.db;
  }

  public get<T = unknown>(key: string): T | undefined {
    const row = this.selectKeyStmt.get(key) as { value: string } | undefined;
    if (!row) return undefined;
    // Decrypt outside the parse guard so SecretDecryptionError propagates instead of being swallowed.
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.value);
    } catch {
      parsed = row.value;
    }
    if (typeof parsed === 'string' && parsed.startsWith(ENCRYPTION_PREFIX)) {
      return decryptSecret(parsed, this.masterKey) as unknown as T;
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
    if (isSecretKey(key) && typeof value === 'string' && value.trim() !== '') {
      finalValue = encryptSecret(value, this.masterKey);
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
          val = decryptSecret(val, this.masterKey);
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

export { AppDatabase as Database };
export * from './crypto.js';
export default AppDatabase;
