import { renderSquareProgressBar } from '../embeds/index.js';

export { renderSquareProgressBar };

/**
 * Generates an ASCII visual progress bar for quota fractions (e.g. "██████░░░░" or "■■■■■■□□□□").
 */
export const generateProgressBar = (
  fraction: number,
  totalBars = 10,
  filledChar = '█',
  emptyChar = '░'
): string => {
  const safeFraction = Number.isFinite(fraction) ? fraction : 0;
  const clamped = Math.max(0, Math.min(1, safeFraction));
  const safeTotalBars = Number.isFinite(totalBars) && totalBars > 0 ? Math.floor(totalBars) : 10;
  const filled = Math.round(clamped * safeTotalBars);
  const empty = Math.max(0, safeTotalBars - filled);
  return filledChar.repeat(filled) + emptyChar.repeat(empty);
};

export const formatProgressBar = (fraction: number, totalBars = 10): string => {
  const safeTotalBars = Number.isFinite(totalBars) && totalBars > 0 ? Math.floor(totalBars) : 10;
  const bar = generateProgressBar(fraction, safeTotalBars);
  const percent = Math.round(
    Math.max(0, Math.min(1, Number.isFinite(fraction) ? fraction : 0)) * 100
  );
  return `[${bar}] ${percent}%`;
};

export const renderProgressBar = (fraction: number, totalBars = 10): string => {
  const safeTotalBars = Number.isFinite(totalBars) && totalBars > 0 ? Math.floor(totalBars) : 10;
  const bar = generateProgressBar(fraction, safeTotalBars);
  const percent = Math.round(
    Math.max(0, Math.min(1, Number.isFinite(fraction) ? fraction : 0)) * 100
  );
  return `\`[${bar}]\` **${percent}%**`;
};
