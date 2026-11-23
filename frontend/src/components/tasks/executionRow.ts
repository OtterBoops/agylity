import { taskBadgeClass } from './badges';
import type { TimeFormat } from '../../utils/time';

export const statusDotTextClass = (status: string): string =>
  taskBadgeClass(status)
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
