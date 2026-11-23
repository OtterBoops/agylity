// Zero imports and erasable syntax only: the frontend bundles this file directly.

// One literal class list: the grid renders one cell per pool group, so the column count no longer
// depends on how many of them this account holds.
export const QUOTA_GRID_COLUMNS = 'grid-cols-1 md:grid-cols-2';

const COLUMNS = 2;

export interface QuotaGridPlaceholder {
  key: string;
  className: string;
}

// A count that does not fill the last row would leave the bordered grid framing bare space.
export const quotaGridPlaceholders = (cellCount: number): QuotaGridPlaceholder[] => {
  const missing = (COLUMNS - (cellCount % COLUMNS)) % COLUMNS;
  return Array.from({ length: missing }, (_, i) => ({
    key: `md-${i}`,
    className: 'hidden md:flex',
  }));
};
