import type { DatabaseSync } from 'node:sqlite';
import { logger } from '../logs/logger.js';

export interface ColumnSpec {
  name: string;
  ddl: string;
}

export const renderColumns = (columns: readonly ColumnSpec[]): string =>
  columns.map((column) => `        ${column.ddl}`).join(',\n');

// ALTER TABLE ADD COLUMN cannot add PRIMARY KEY/UNIQUE columns or NOT NULL columns without a default.
const isAddableColumn = (ddl: string): boolean => {
  const upper = ddl.toUpperCase();
  if (upper.includes('PRIMARY KEY') || upper.includes('UNIQUE')) return false;
  if (upper.includes('NOT NULL') && !upper.includes('DEFAULT')) return false;
  return true;
};

/**
 * Additively upgrades a table to its expected column set. Never drops or rewrites a column; it only
 * ALTER TABLE ADD COLUMNs anything the existing table is missing, logging additions at info and
 * columns that cannot be added automatically at warn.
 */
export const migrateColumns = (
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
    if (!isAddableColumn(column.ddl)) {
      logger.warn(
        'Cannot add column %s.%s to legacy schema; manual repair required',
        tableName,
        column.name
      );
      continue;
    }
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${column.ddl}`);
    added.push(column.name);
  }
  if (added.length > 0) {
    logger.info('Migrated %s: added column(s) %s', tableName, added.join(', '));
  }
};
