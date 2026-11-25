import type { DatabaseSync } from 'node:sqlite';
import { logger } from '../logs/logger.js';

export interface ColumnSpec {
  name: string;
  ddl: string;
}

const renderColumns = (columns: readonly ColumnSpec[]): string =>
  columns.map((column) => `        ${column.ddl}`).join(',\n');

/** A table-level constraint shares the spec list but has no column of its own to add. */
const isTableConstraint = (ddl: string): boolean =>
  /^(?:PRIMARY\s+KEY|UNIQUE|FOREIGN\s+KEY|CHECK)\s*\(/i.test(ddl.trim());

const isAddableColumn = (ddl: string): boolean => {
  const upper = ddl.toUpperCase();
  if (upper.includes('PRIMARY KEY') || upper.includes('UNIQUE')) return false;
  if (upper.includes('NOT NULL') && !upper.includes('DEFAULT')) return false;
  return true;
};

// SQLite only allows a literal default when the table already holds rows, so an expression default
// has to be added bare and backfilled.
const expressionDefault = (ddl: string): string | undefined =>
  /\bDEFAULT\s*(\([\s\S]*\))\s*$/i.exec(ddl.trim())?.[1];

const addableDdl = (ddl: string): string =>
  ddl
    .replace(/\s*\bDEFAULT\b[\s\S]*$/i, '')
    .replace(/\s*\bNOT\s+NULL\b/i, '')
    .trim();

/** Additively upgrades a table to its expected column set; never drops or rewrites a column. */
const migrateColumns = (
  db: DatabaseSync,
  tableName: string,
  columns: readonly ColumnSpec[]
): void => {
  const existing = new Set(
    (db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>).map((row) =>
      String(row.name)
    )
  );
  const added: string[] = [];
  for (const column of columns) {
    if (existing.has(column.name)) continue;
    if (isTableConstraint(column.ddl)) continue;
    if (!isAddableColumn(column.ddl)) {
      logger.warn(
        'Cannot add column %s.%s to legacy schema; manual repair required',
        tableName,
        column.name
      );
      continue;
    }
    const backfill = expressionDefault(column.ddl);
    if (backfill && db.prepare(`SELECT 1 FROM ${tableName} LIMIT 1`).get() !== undefined) {
      // Savepoint stays atomic both standalone and inside an enclosing migration transaction.
      db.exec('SAVEPOINT migrate_column_backfill');
      try {
        db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${addableDdl(column.ddl)}`);
        db.exec(`UPDATE ${tableName} SET ${column.name} = ${backfill}`);
        db.exec('RELEASE SAVEPOINT migrate_column_backfill');
      } catch (err) {
        try {
          db.exec('ROLLBACK TO SAVEPOINT migrate_column_backfill');
          db.exec('RELEASE SAVEPOINT migrate_column_backfill');
        } catch {}
        throw err;
      }
      logger.warn(
        'Added %s.%s without NOT NULL or a default: SQLite refuses an expression default on a populated table',
        tableName,
        column.name
      );
      added.push(column.name);
      continue;
    }
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${column.ddl}`);
    added.push(column.name);
  }
  if (added.length > 0) {
    logger.info('Migrated %s: added column(s) %s', tableName, added.join(', '));
  }
};

/** Creates the table when absent, then brings an existing one up to the declared column set. */
export const ensureTableSchema = (
  db: DatabaseSync,
  tableName: string,
  columns: readonly ColumnSpec[]
): void => {
  db.exec(`CREATE TABLE IF NOT EXISTS ${tableName} (\n${renderColumns(columns)}\n      )`);
  migrateColumns(db, tableName, columns);
};
