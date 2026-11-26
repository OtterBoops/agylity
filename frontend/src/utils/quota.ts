import { resetTimeMs } from '../../../src/shared/resetTime.ts';

/*
 * Everything a quota card says about its reset window is derived here, not in the component: the
 * epoch-zero placeholder upstream sends for an unstarted window must read as idle rather than as a
 * deadline that has already passed.
 */

export type ResetWindowState = 'unset' | 'now' | 'counting';

export type QuotaTone =
  'ready' | 'burst' | 'tapped' | 'floor' | 'spent' | 'urgent' | 'soon' | 'idle';

export type ResetVerb = 'Resets' | 'Refreshes';

export const resetWindowState = (
  rawResetTime: string | null | undefined,
  nowMs: number
): ResetWindowState => {
  const deadlineMs = resetTimeMs(rawResetTime);
  if (deadlineMs === null) return 'unset';
  return deadlineMs - nowMs <= 0 ? 'now' : 'counting';
};

export const formatCountdown = (remainingMs: number): string => {
  const totalSecs = Math.max(0, Math.floor(remainingMs / 1000));
  const days = Math.floor(totalSecs / 86400);
  const hours = Math.floor((totalSecs % 86400) / 3600);
  const mins = Math.floor((totalSecs % 3600) / 60);
  const secs = totalSecs % 60;

  if (days > 0) return `${days}d ${hours}h`;
  if (hours >= 2) return `${hours}h ${mins}m`;
  if (hours > 0) return `${hours}h ${mins}m ${secs}s`;
  return `${mins}m ${secs}s`;
};

/** Complete phrasing including the verb, so a caller must never prefix it with the verb again. */
export const resetWindowLabel = (
  rawResetTime: string | null | undefined,
  nowMs: number,
  verb: ResetVerb = 'Resets'
): string => {
  const deadlineMs = resetTimeMs(rawResetTime);
  if (deadlineMs === null) return 'Starts on first use';
  const remainingMs = deadlineMs - nowMs;
  if (remainingMs <= 0) return verb === 'Refreshes' ? 'Refreshing now' : 'Resetting now';
  return `${verb} in ${formatCountdown(remainingMs)}`;
};

export const resetDateLabel = (rawResetTime: string | null | undefined): string => {
  const deadlineMs = resetTimeMs(rawResetTime);
  if (deadlineMs === null) return '';
  return new Date(deadlineMs).toLocaleDateString(undefined, {
    weekday: 'short',
    hour: 'numeric',
    minute: 'numeric',
  });
};

export const quotaStatus = (input: {
  weeklyPercent: number;
  shortTermPercent: number | null;
  minHeadroomPercent: number;
  weeklyHours: number;
  windowActive: boolean;
}): { tone: QuotaTone; text: string } => {
  const { weeklyPercent, shortTermPercent, minHeadroomPercent, weeklyHours, windowActive } = input;
  const effectivePercent =
    shortTermPercent !== null ? Math.min(weeklyPercent, shortTermPercent) : weeklyPercent;

  // The safety floor is settable up to 100, so it can sit above the 25% notice band.
  if (
    shortTermPercent !== null &&
    shortTermPercent < minHeadroomPercent &&
    weeklyPercent >= minHeadroomPercent
  ) {
    return { tone: 'burst', text: '5h Burst Cooldown' };
  }
  if (weeklyPercent === 0) return { tone: 'tapped', text: 'Tapped out' };
  if (effectivePercent < minHeadroomPercent) {
    return { tone: 'floor', text: 'Safety floor' };
  }
  if (effectivePercent <= 25) {
    return { tone: 'spent', text: 'Well spent' };
  }
  // Nothing has been drawn from a pool whose window never opened, so no expiry is imminent.
  if (!windowActive) return { tone: 'idle', text: 'Idle' };
  if (weeklyHours <= 3) return { tone: 'urgent', text: 'Use it or lose it' };
  if (weeklyHours <= 12) return { tone: 'soon', text: 'Expiring soon' };
  return { tone: 'ready', text: 'Ready to burn' };
};
