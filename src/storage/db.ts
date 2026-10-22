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

export interface SettingRecord {
  key: string;
  value: string; // JSON encoded
  updated_at: string;
}

export interface DatabaseConnectionOptions {
  path: string;
  keyPath?: string;
}

export type DatabaseOptions = string | DatabaseConnectionOptions;

export interface DispatchRecord {
  id: number;
  createdAt: string;
  repository: string;
  prompt: string;
  requestedBy: string;
  success: boolean;
  branch?: string;
  error?: string;
  durationMs: number;
}

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

    this.db = new DatabaseSync(this.dbPath);
    this.initPragmas();
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

  private initPragmas(): void {
    // Enable WAL mode for high concurrency
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA synchronous = NORMAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
  }

  private runMigrations(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_settings_key ON settings(key);

      CREATE TABLE IF NOT EXISTS dispatches (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        repository TEXT NOT NULL,
        prompt TEXT NOT NULL,
        requested_by TEXT NOT NULL,
        success INTEGER NOT NULL,
        branch TEXT,
        error TEXT,
        duration_ms INTEGER NOT NULL DEFAULT 0
      );
    `);
  }

  public recordDispatch(entry: Omit<DispatchRecord, 'id' | 'createdAt'>): void {
    this.db
      .prepare(
        'INSERT INTO dispatches (repository, prompt, requested_by, success, branch, error, duration_ms) VALUES (?, ?, ?, ?, ?, ?, ?)'
      )
      .run(
        entry.repository,
        entry.prompt.slice(0, 4000),
        entry.requestedBy,
        entry.success ? 1 : 0,
        entry.branch ?? null,
        entry.error ?? null,
        Math.max(0, Math.round(entry.durationMs))
      );
  }

  public listDispatches(limit = 50): DispatchRecord[] {
    const rows = this.db
      .prepare(
        'SELECT id, created_at, repository, prompt, requested_by, success, branch, error, duration_ms FROM dispatches ORDER BY id DESC LIMIT ?'
      )
      .all(Math.min(Math.max(1, limit), 500)) as Array<Record<string, any>>;
    return rows.map((r) => ({
      id: Number(r.id),
      createdAt: String(r.created_at),
      repository: String(r.repository),
      prompt: String(r.prompt),
      requestedBy: String(r.requested_by),
      success: r.success === 1,
      branch: r.branch ?? undefined,
      error: r.error ?? undefined,
      durationMs: Number(r.duration_ms),
    }));
  }

  public getRawDb(): DatabaseSync {
    return this.db;
  }

  public get<T = unknown>(key: string): T | undefined {
    const row = this.selectKeyStmt.get(key) as { value: string } | undefined;
    if (!row) return undefined;
    try {
      const parsed = JSON.parse(row.value);
      if (typeof parsed === 'string' && parsed.startsWith(ENCRYPTION_PREFIX)) {
        return decryptSecret(parsed, this.masterKey) as unknown as T;
      }
      return parsed as T;
    } catch {
      if (typeof row.value === 'string' && row.value.startsWith(ENCRYPTION_PREFIX)) {
        return decryptSecret(row.value, this.masterKey) as unknown as T;
      }
      return row.value as unknown as T;
    }
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
