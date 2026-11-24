import type { DispatchStatusUpdate } from '../types.js';

const TERMINAL_STEPS = ['completed', 'no_changes', 'failed', 'aborted'];

export const normalizeStep = (status: DispatchStatusUpdate): string =>
  String(status.status ?? status.step ?? 'executing').toLowerCase();

export const isTerminalStep = (step: string): boolean => TERMINAL_STEPS.includes(step);

export const renderSquareProgressBar = (fraction: number, totalBars = 10): string => {
  const safeFraction = Number.isFinite(fraction) ? fraction : 0;
  const clamped = Math.max(0, Math.min(1, safeFraction));
  const safeTotalBars = Number.isFinite(totalBars) && totalBars > 0 ? Math.floor(totalBars) : 10;
  const filled = Math.round(clamped * safeTotalBars);
  const empty = Math.max(0, safeTotalBars - filled);
  const bar = '▰'.repeat(filled) + '▱'.repeat(empty);
  const percent = Math.round(clamped * 100);
  return `\`${bar}\` **${percent}%**`;
};

export const formatResetWindow = (rawResetTime?: string): string => {
  if (!rawResetTime) return 'Unknown';
  try {
    const d = new Date(rawResetTime);
    if (!isNaN(d.getTime())) {
      const unixSec = Math.floor(d.getTime() / 1000);
      return `<t:${unixSec}:R> (<t:${unixSec}:t>)`;
    }
  } catch {}
  return rawResetTime;
};

export const formatModelPills = (models?: string[]): string => {
  if (!models || models.length === 0) return '';
  return models.map((m) => `\`${m}\``).join(' • ');
};

const PROMPT_LINE_PREFIX = /^(?:\s*(?:#{1,6}|[-*+>]|\d+[.)])\s*)+/;

/** Strips Markdown syntax and collapses newlines so Discord's `*...*` prompt preview never breaks mid-token. */
export const formatPromptPreview = (prompt: string, maxLen = 300): string => {
  const normalized = prompt
    .replace(/```[^\r\n]*\r?\n?/g, ' ')
    .split(/\r?\n/)
    .map((line) => line.replace(PROMPT_LINE_PREFIX, '').trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[`*_~|]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!normalized) return '';
  if (normalized.length <= maxLen) return normalized;

  const budget = Math.max(1, maxLen - 1);
  const head = normalized.slice(0, budget + 1);
  const boundary = head.lastIndexOf(' ');
  const body = boundary > 0 ? head.slice(0, boundary) : normalized.slice(0, budget);
  return `${body.replace(/[\s.,;:!?–—-]+$/, '')}…`;
};
