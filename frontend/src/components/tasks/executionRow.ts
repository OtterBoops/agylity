import type { TimeFormat } from '../../utils/time';
import { taskStatusBadgeClass } from '../../utils/status';

export const statusDotTextClass = (status: string): string =>
  taskStatusBadgeClass(status)
    .split(/\s+/)
    .find((token) => token.startsWith('text-')) ?? 'text-pine-subtle';

const SHORT_MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

const pad = (value: number): string => String(value).padStart(2, '0');

export const formatCompactDateTime = (
  value: Date | string | number | null | undefined,
  timeFormat: TimeFormat
): string => {
  if (!value) return '\u2014';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '\u2014';
  const datePart = `${date.getDate()} ${SHORT_MONTHS[date.getMonth()]}`;
  const hours = date.getHours();
  const minutes = pad(date.getMinutes());
  if (timeFormat === '24h') return `${datePart} ${pad(hours)}:${minutes}`;
  const suffix = hours >= 12 ? 'PM' : 'AM';
  const hour12 = hours % 12 === 0 ? 12 : hours % 12;
  return `${datePart} ${pad(hour12)}:${minutes} ${suffix}`;
};

export interface IssueLink {
  url: string;
  label: string;
}

export interface IssueLinkSummary {
  links: IssueLink[];
  overflow: number;
}

const MAX_VISIBLE_ISSUE_LINKS = 3;

// Issue URLs end in the issue number, so the short label is just the last path segment.
export const githubIssueLabel = (url: string): string => {
  const path = url.split(/[?#]/)[0] ?? '';
  const segment = path
    .split('/')
    .filter((part) => part !== '')
    .pop();
  return segment ? `#${segment}` : url;
};

// Rows and cards stay one line tall: three links plus a count for the rest.
export const summarizeIssueLinks = (urls: readonly string[] | undefined): IssueLinkSummary => {
  const list = urls ?? [];
  return {
    links: list
      .slice(0, MAX_VISIBLE_ISSUE_LINKS)
      .map((url) => ({ url, label: githubIssueLabel(url) })),
    overflow: Math.max(0, list.length - MAX_VISIBLE_ISSUE_LINKS),
  };
};
