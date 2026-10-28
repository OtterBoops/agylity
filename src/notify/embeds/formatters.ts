/**
 * Renders a monospaced geometric square progress bar enclosed in backticks:
 * `[■■■□□□□□□□]` **30%**
 */
export function renderSquareProgressBar(fraction: number, totalBars = 10): string {
  const safeFraction = Number.isFinite(fraction) ? fraction : 0;
  const clamped = Math.max(0, Math.min(1, safeFraction));
  const safeTotalBars = Number.isFinite(totalBars) && totalBars > 0 ? Math.floor(totalBars) : 10;
  const filled = Math.round(clamped * safeTotalBars);
  const empty = Math.max(0, safeTotalBars - filled);
  const bar = '■'.repeat(filled) + '□'.repeat(empty);
  const percent = Math.round(clamped * 100);
  return `\`[${bar}]\` **${percent}%**`;
}

/**
 * Formats an ISO reset timestamp into Discord's relative countdown and localized time tags:
 * <t:1793215200:R> (<t:1793215200:t>) -> "in 3 hours (11:51 PM)"
 */
export function formatResetWindow(rawResetTime?: string): string {
  if (!rawResetTime) return 'Unknown';
  try {
    const d = new Date(rawResetTime);
    if (!isNaN(d.getTime())) {
      const unixSec = Math.floor(d.getTime() / 1000);
      return `<t:${unixSec}:R> (<t:${unixSec}:t>)`;
    }
  } catch {}
  return rawResetTime;
}

/**
 * Formats a list of model names as inline code tags separated by bullets.
 */
export function formatModelPills(models?: string[]): string {
  if (!models || models.length === 0) return '';
  return models.map((m) => `\`${m}\``).join(' • ');
}
