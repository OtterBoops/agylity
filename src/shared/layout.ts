// Two columns: `COLUMNS` below must agree, or a placeholder lands outside the last row.
export const QUOTA_GRID_COLUMNS = 'grid-cols-1 md:grid-cols-2';

const COLUMNS = 2;

interface QuotaGridPlaceholder {
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
