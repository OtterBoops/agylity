type RowKeyAction =
  'up' | 'down' | 'first' | 'last' | 'page-up' | 'page-down' | 'open' | 'abort' | 'filter';

interface KeyLike {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
}

export const resolveRowKey = (event: KeyLike): RowKeyAction | null => {
  if (event.ctrlKey || event.metaKey || event.altKey) return null;
  switch (event.key) {
    case 'j':
    case 'ArrowDown':
      return 'down';
    case 'k':
    case 'ArrowUp':
      return 'up';
    case 'Home':
      return 'first';
    case 'End':
      return 'last';
    case 'PageDown':
      return 'page-down';
    case 'PageUp':
      return 'page-up';
    case 'Enter':
    case ' ':
      return 'open';
    case 'x':
    case 'X':
      return 'abort';
    case '/':
      return 'filter';
    default:
      return null;
  }
};

export const moveRowIndex = (
  current: number,
  total: number,
  action: RowKeyAction,
  pageSize = 10
): number => {
  if (total <= 0) return -1;
  const last = total - 1;
  const from = current < 0 ? 0 : current;
  switch (action) {
    case 'down':
      return Math.min(last, from + 1);
    case 'up':
      return Math.max(0, from - 1);
    case 'first':
      return 0;
    case 'last':
      return last;
    case 'page-down':
      return Math.min(last, from + pageSize);
    case 'page-up':
      return Math.max(0, from - pageSize);
    default:
      return from;
  }
};
