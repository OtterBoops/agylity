import type { DispatchStatusUpdate } from '../types.js';

export const TERMINAL_STEPS = ['completed', 'no_changes', 'failed', 'aborted'];

/** One step derivation, so no adapter can disagree on what a status update says. */
export const normalizeStep = (status: DispatchStatusUpdate): string =>
  String(status.status ?? status.step ?? 'executing').toLowerCase();

export const isTerminalStep = (step: string): boolean => TERMINAL_STEPS.includes(step);

// Renders a monospaced block bar, e.g. `▰▰▰▱▱▱▱▱▱▱` **30%**.
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

// ISO reset -> Discord tags: `<t:...:R> (<t:...:t>)`.
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
