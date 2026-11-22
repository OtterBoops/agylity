// Zero imports and erasable syntax only: the frontend bundles this file directly.

// One literal class list: the grid renders one cell per pool group, so the column count no longer
// depends on how many of them this account holds.
export const QUOTA_GRID_COLUMNS = 'grid-cols-1 md:grid-cols-2 xl:grid-cols-3';

const COLUMNS_AT_MD = 2;
const COLUMNS_AT_XL = 3;

export interface QuotaGridPlaceholder {
  key: string;
  className: string;
}

// A count that does not fill the last row would leave the bordered grid framing bare space, and
// the shortfall differs per breakpoint, so each filler carries its own range.
export const quotaGridPlaceholders = (cellCount: number): QuotaGridPlaceholder[] => {
  const missing = (columns: number): number => (columns - (cellCount % columns)) % columns;
  const slots: QuotaGridPlaceholder[] = [];

  for (let i = 0; i < missing(COLUMNS_AT_MD); i++) {
    slots.push({ key: `md-${i}`, className: 'hidden md:flex xl:hidden' });
  }
  for (let i = 0; i < missing(COLUMNS_AT_XL); i++) {
    slots.push({ key: `xl-${i}`, className: 'hidden xl:flex' });
  }

  return slots;
};
