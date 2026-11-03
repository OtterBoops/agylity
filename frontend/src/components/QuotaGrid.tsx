import { useEffect, useState } from 'preact/hooks';
import type { QuotaSnapshot } from '../types';

interface QuotaGridProps {
  quota: QuotaSnapshot[];
  minHeadroomPercent?: number;
}

const formatResetHuman = (hours: number): string => {
  if (hours <= 0) return '0m';
  if (hours >= 24) {
    const days = Math.floor(hours / 24);
    const rem = Math.floor(hours % 24);
    return rem > 0 ? `${days}d ${rem}h` : `${days}d`;
  }
  const totalMinutes = Math.round(hours * 60);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
};

const formatResetDate = (isoStr?: string): string => {
  if (!isoStr) return 'N/A';
  try {
    const d = new Date(isoStr);
    return d.toLocaleDateString(undefined, {
      weekday: 'short',
      hour: 'numeric',
      minute: 'numeric',
    });
  } catch {
    return 'N/A';
  }
};

export const QuotaGrid = ({ quota, minHeadroomPercent = 10 }: QuotaGridProps) => {
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const getLiveCountdown = (isoStr?: string, fallbackHours?: number): string => {
    if (!isoStr) return formatResetHuman(fallbackHours ?? 0);
    const targetMs = new Date(isoStr).getTime();
    if (isNaN(targetMs)) return formatResetHuman(fallbackHours ?? 0);
    const diffMs = targetMs - now;
    if (diffMs <= 0) return 'Resetting now';

    const totalSecs = Math.floor(diffMs / 1000);
    const days = Math.floor(totalSecs / 86400);
    const hours = Math.floor((totalSecs % 86400) / 3600);
    const mins = Math.floor((totalSecs % 3600) / 60);
    const secs = totalSecs % 60;

    if (days > 0) return `${days}d ${hours}h`;
    if (hours >= 2) return `${hours}h ${mins}m`;
    if (hours > 0) return `${hours}h ${mins}m ${secs}s`;
    return `${mins}m ${secs}s`;
  };

  if (quota.length === 0) {
    return (
      <div
        id="quotaGrid"
        class="mb-8 grid grid-cols-1 gap-4 sm:gap-6 md:grid-cols-2 xl:grid-cols-3"
      >
        <div class="flex flex-col gap-4 rounded-xl border border-pine-highlight bg-pine-surface p-5 shadow-sm sm:p-6">
          <p class="text-sm text-pine-muted">Probing Antigravity Language Server models...</p>
        </div>
      </div>
    );
  }

  return (
    <div id="quotaGrid" class="mb-8 grid grid-cols-1 gap-4 sm:gap-6 md:grid-cols-2 xl:grid-cols-3">
      {quota.map((pool) => {
        const poolDisplayName = pool.displayName || pool.family || pool.poolId;
        const weeklyFraction = pool.weekly?.remainingFraction ?? pool.remainingFraction;
        const weeklyHours = pool.weekly?.hoursUntilReset ?? pool.hoursUntilReset;
        const weeklyResetTime = pool.weekly?.resetTime ?? pool.resetTime;
        const weeklyPct = Math.round(weeklyFraction * 100);
        const shortTerm = pool.shortTerm;
        const shortTermPct = shortTerm ? Math.round(shortTerm.remainingFraction * 100) : null;
        const shortTermHours = shortTerm ? shortTerm.hoursUntilReset : null;

        // Badges use the effective budget: min(weekly, shortTerm).
        const effectivePct = shortTermPct !== null ? Math.min(weeklyPct, shortTermPct) : weeklyPct;
        let badgeClasses = 'bg-pine-iris/20 text-pine-iris border border-pine-iris';
        let barColor = 'bg-pine-iris';
        let statusText = 'Ready to burn';

        if (shortTermPct !== null && shortTermPct <= 10 && weeklyPct > minHeadroomPercent) {
          badgeClasses = 'bg-pine-gold/20 text-pine-gold border border-pine-gold';
          barColor = 'bg-pine-gold';
          statusText = '5h Burst Cooldown';
        } else if (weeklyPct === 0) {
          badgeClasses = 'bg-pine-pine/20 text-pine-foam border border-pine-pine';
          barColor = 'bg-pine-pine';
          statusText = 'Tapped out';
        } else if (effectivePct <= minHeadroomPercent) {
          // At or below the safety floor, dispatch is blocked by default
          badgeClasses = 'bg-pine-pine/20 text-pine-foam border border-pine-pine';
          barColor = 'bg-pine-foam';
          statusText = minHeadroomPercent > 0 ? 'Safety floor' : 'Well spent';
        } else if (effectivePct <= 25) {
          badgeClasses = 'bg-pine-pine/20 text-pine-foam border border-pine-pine';
          barColor = 'bg-pine-foam';
          statusText = 'Well spent';
        } else if (weeklyHours <= 3) {
          badgeClasses = 'bg-pine-love/20 text-pine-love border border-pine-love';
          barColor = 'bg-pine-love';
          statusText = 'Use it or lose it';
        } else if (weeklyHours <= 12) {
          badgeClasses = 'bg-pine-gold/20 text-pine-gold border border-pine-gold';
          barColor = 'bg-pine-gold';
          statusText = 'Expiring soon';
        }

        const weeklyCountdown = getLiveCountdown(weeklyResetTime, weeklyHours);
        const weeklyDateStr = formatResetDate(weeklyResetTime);

        let velocityLabel = null;
        if (weeklyPct <= minHeadroomPercent) {
          velocityLabel = (
            <span class="inline-flex items-center gap-1 font-mono text-xs font-semibold text-pine-foam">
              Floor engaged
            </span>
          );
        } else if (weeklyHours > 0) {
          const burnRate = ((weeklyFraction * 100) / weeklyHours).toFixed(1);
          velocityLabel = (
            <span
              class="inline-flex items-center gap-1 font-mono text-xs font-semibold text-pine-iris"
              title="Target quota burn rate to fully utilize pool before reset"
            >
              ~{burnRate}%/hr pace
            </span>
          );
        }

        return (
          <div
            key={pool.poolId}
            class="flex h-full flex-col justify-between gap-4 rounded-xl border border-pine-highlight bg-pine-surface p-4 shadow-sm transition-colors hover:border-pine-iris/50 sm:gap-4 sm:p-5"
          >
            {/* Header: Title, Pool ID, and Weekly Eval Status Badge */}
            <div class="flex items-start justify-between gap-3">
              <div class="min-w-0 flex-1">
                <h2
                  class="text-base/snug font-semibold text-pine-text sm:text-lg"
                  title={poolDisplayName}
                >
                  {poolDisplayName}
                </h2>
                <div class="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-pine-muted">
                  <span class="inline-flex items-center gap-1">
                    Pool:{' '}
                    <span class="rounded-sm bg-pine-overlay px-1.5 py-0.5 font-mono text-xs whitespace-nowrap text-pine-iris">
                      {pool.poolId}
                    </span>
                  </span>
                  {typeof pool.remainingCredits === 'number' ? (
                    <span
                      class="inline-flex items-center gap-1 rounded-sm bg-pine-overlay px-1.5 py-0.5 font-mono text-xs whitespace-nowrap text-pine-muted"
                      title="Google One AI credits remaining. Whether usage past the limit is billed is not exposed by the language server."
                    >
                      {pool.remainingCredits} credits
                    </span>
                  ) : null}
                </div>
              </div>
              <span
                class={`shrink-0 rounded-sm px-2.5 py-1 text-xs font-bold tracking-wider whitespace-nowrap uppercase ${badgeClasses}`}
              >
                {statusText}
              </span>
            </div>

            {/* Quota 1: Weekly Limit */}
            <div class="flex flex-col gap-2 rounded-lg border border-pine-highlight bg-pine-overlay/30 p-3 sm:p-3.5">
              <div class="flex items-center justify-between text-sm font-semibold sm:text-base">
                <span class="font-medium text-pine-text">Weekly Limit</span>
                <span class="font-mono text-sm font-bold text-pine-text sm:text-base">
                  {weeklyPct}%
                </span>
              </div>
              <div class="h-2 overflow-hidden rounded-full bg-pine-overlay sm:h-2.5">
                <div
                  class={`h-full rounded-full transition-all duration-500 ease-out ${barColor}`}
                  style={{ width: `${Math.min(100, Math.max(0, weeklyPct))}%` }}
                />
              </div>
              <div class="mt-0.5 flex flex-wrap items-center justify-between gap-1 text-xs text-pine-subtle">
                <span class="font-mono font-medium text-pine-text">
                  Resets in {weeklyCountdown}
                </span>
                <span class="font-mono text-xs">{weeklyDateStr}</span>
              </div>
              {velocityLabel && (
                <div class="mt-1 flex items-center justify-between border-t border-pine-highlight/40 pt-1 text-xs text-pine-muted">
                  <span>Pacing Guidance:</span>
                  {velocityLabel}
                </div>
              )}
            </div>

            {/* Quota 2: 5-Hour Limit (Capacity Rate Limiter) */}
            {shortTerm && shortTermPct !== null && shortTermHours !== null ? (
              <div class="flex flex-col gap-1.5 rounded-lg border border-pine-highlight bg-pine-overlay/15 p-3 sm:p-3.5">
                <div class="flex items-center justify-between text-sm sm:text-base">
                  <span class="font-medium text-pine-subtle">5-Hour Rolling Limit</span>
                  <span class="font-mono text-sm font-bold text-pine-text sm:text-base">
                    {shortTermPct}%
                  </span>
                </div>
                <div class="h-1.5 overflow-hidden rounded-full bg-pine-overlay sm:h-2">
                  <div
                    class="h-full rounded-full bg-pine-iris/75 transition-all duration-500 ease-out"
                    style={{ width: `${Math.min(100, Math.max(0, shortTermPct))}%` }}
                  />
                </div>
                <div class="mt-0.5 flex flex-wrap items-center justify-between gap-1 text-xs text-pine-muted">
                  <span>Capacity throttle</span>
                  <span>Refreshes in {getLiveCountdown(shortTerm.resetTime, shortTermHours)}</span>
                </div>
              </div>
            ) : (
              <div class="flex flex-col gap-1.5 rounded-lg border border-pine-highlight bg-pine-overlay/15 p-3 sm:p-3.5">
                <div class="flex items-center justify-between text-sm sm:text-base">
                  <span class="font-medium text-pine-subtle">5-Hour Rolling Limit</span>
                  <span class="text-xs font-medium text-pine-subtle">Unconstrained</span>
                </div>
                <div class="h-1.5 overflow-hidden rounded-full bg-pine-overlay sm:h-2">
                  <div class="size-full rounded-full bg-pine-iris/30" />
                </div>
                <div class="mt-0.5 flex flex-wrap items-center justify-between gap-1 text-xs text-pine-muted">
                  <span>Capacity throttle</span>
                  <span class="text-pine-subtle italic">Tier Unconstrained</span>
                </div>
              </div>
            )}

            {/* Models in Pool - Responsive flex layout */}
            <div class="mt-auto flex items-center justify-between gap-2 border-t border-pine-highlight pt-2.5 text-xs text-pine-subtle">
              <span class="shrink-0 text-pine-muted">Models:</span>
              <span
                class="min-w-0 flex-1 truncate text-right font-medium text-pine-text"
                title={pool.models?.join(', ')}
              >
                {pool.models?.join(', ') || 'N/A'}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
};
