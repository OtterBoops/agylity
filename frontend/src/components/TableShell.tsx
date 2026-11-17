import type { ComponentChildren, JSX } from 'preact';

const cx = (...parts: Array<string | false | null | undefined>): string =>
  parts.filter(Boolean).join(' ');

type DataAttributes = { [key: `data-${string}`]: string | number | boolean | undefined };

interface TableShellProps {
  children: ComponentChildren;
  class?: string;
}

export const TableShell = ({ children, class: className }: TableShellProps) => (
  <div
    class={cx('overflow-hidden rounded-xl border border-pine-highlight bg-pine-surface', className)}
  >
    <div class="overflow-x-auto">{children}</div>
  </div>
);

interface TableHeadRowProps {
  children: ComponentChildren;
}

export const TableHeadRow = ({ children }: TableHeadRowProps) => (
  <tr class="h-8 bg-pine-overlay/40 text-xs tracking-wider text-pine-subtle uppercase">
    {children}
  </tr>
);

interface THProps {
  children?: ComponentChildren;
  class?: string;
}

export const TH = ({ children, class: className }: THProps) => (
  <th scope="col" class={cx('px-2.5 text-left align-middle font-normal', className)}>
    {children}
  </th>
);

interface TableRowProps
  extends Omit<JSX.HTMLAttributes<HTMLTableRowElement>, 'class'>, DataAttributes {
  children?: ComponentChildren;
  class?: string;
}

export const TableRow = ({ children, class: className, ...rowProps }: TableRowProps) => (
  <tr
    class={cx(
      'h-8 border-b border-pine-highlight/50 last:border-0 hover:bg-pine-overlay/40',
      className
    )}
    {...rowProps}
  >
    {children}
  </tr>
);
