// Upstream reports an idle 100% pool as resetting at the Unix epoch. No window has started, so that
// timestamp carries no deadline and must never be formatted as a date or counted down.
const ISO_RESET_TIME_PREFIX = /^\d{4}-\d{2}-\d{2}T/;

export const resetTimeMs = (value?: string | null): number | null => {
  if (!value) return null;
  const text = value.trim();
  if (!ISO_RESET_TIME_PREFIX.test(text)) return null;
  const ms = Date.parse(text);
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return ms;
};

export const isValidResetTime = (value?: string | null): boolean => resetTimeMs(value) !== null;

/** The one spelling of "unset": an empty string, so a stored pool never holds an epoch placeholder. */
export const normalizeResetTime = (value?: string | null): string =>
  isValidResetTime(value) ? (value ?? '').trim() : '';
