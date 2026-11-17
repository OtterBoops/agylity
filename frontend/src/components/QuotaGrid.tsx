import { useEffect, useState } from 'preact/hooks';
import type { QuotaBurnProjection, QuotaSnapshot } from '../types';
import { useModelCatalog } from '../state/modelCatalogStore';

interface QuotaGridProps {
  quota: QuotaSnapshot[];
  minHeadroomPercent?: number;
  error?: string | null;
  onRetry?: () => void;
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

// `burnRatePerHour` is a fraction of the pool per hour, so every render scales it to percent.
const burnPercentPerHour = (projection: QuotaBurnProjection): number =>
  projection.burnRatePerHour * 100;

// Mirrors the server's toPercentFloor: rounding up would show a pool clearing a floor the gate blocks.
const percentFloor = (fraction: number): number =>
  Math.floor(Number((fraction * 100).toPrecision(12)));

const formatResetDate = (isoStr?: string): string => {
  if (!isoStr) return 'N/A';
  try {
    const d = new Date(isoStr);
    if (Number.isNaN(d.getTime())) return 'N/A';
    return d.toLocaleDateString(undefined, {
      weekday: 'short',
      hour: 'numeric',
      minute: 'numeric',
    });
  } catch {
    return 'N/A';
  }
};

export const QuotaGrid = ({
  quota,
  minHeadroomPercent = 10,
  error = null,
  onRetry,
}: QuotaGridProps) => {
  const [now, setNow] = useState(Date.now());
  const catalog = useModelCatalog();

  const catalogLabelsByFamily = new Map<string, string[]>();
  for (const entry of catalog.models) {
    const labels = catalogLabelsByFamily.get(entry.family) ?? [];
    labels.push(entry.label);
    catalogLabelsByFamily.set(entry.family, labels);
  }

  useEffect(() => {
    const tick = () => {
      if (document.hidden) return;
      setNow(Date.now());
    };
    const timer = setInterval(tick, 1000);
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
    if (error) {
      return (
        <div id="quotaGrid" class="grid grid-cols-1">
          <div
            role="alert"
            class="flex flex-col gap-3 rounded-xl border border-pine-love/40 bg-pine-love/10 p-5 text-pine-love sm:p-6"
          >
            <div class="flex items-center justify-between">
              <span class="text-sm font-semibold">[Error] Sentry Telemetry Offline</span>
              {onRetry && (
                <button
                  type="button"
                  onClick={onRetry}
                  class="cursor-pointer rounded-lg border border-pine-love/40 bg-pine-love/20 px-3 py-1 text-xs font-semibold hover:bg-pine-love hover:text-pine-base focus-visible:ring-2 focus-visible:ring-pine-love focus-visible:outline-hidden"
                >
                  Retry Connection
                </button>
              )}
            </div>
            <p class="text-xs text-pine-subtle">{error}</p>
          </div>
        </div>
      );
    }
    return (
      <div id="quotaGrid" class="grid grid-cols-1 gap-4 sm:gap-6 md:grid-cols-2 xl:grid-cols-3">
        <div class="flex flex-col gap-4 rounded-xl border border-pine-highlight bg-pine-surface p-5 sm:p-6">
          <p class="text-sm text-pine-subtle">Probing Antigravity Language Server models...</p>
        </div>
      </div>
    );
  }

  return (
    <div
      id="quotaGrid"
      class="grid grid-cols-1 gap-px overflow-hidden rounded-xl border border-pine-highlight bg-pine-highlight/70 md:grid-cols-2 xl:grid-cols-3"
    >
      {quota.map((pool) => {
        const poolDisplayName = pool.displayName || pool.family || pool.poolId;
        const weeklyFraction = pool.weekly?.remainingFraction ?? pool.remainingFraction;
        const weeklyHours = pool.weekly?.hoursUntilReset ?? pool.hoursUntilReset;
        const weeklyResetTime = pool.weekly?.resetTime ?? pool.resetTime;
        const weeklyPct = percentFloor(weeklyFraction);
        const shortTerm = pool.shortTerm;
        const shortTermPct = shortTerm ? percentFloor(shortTerm.remainingFraction) : null;
        const hasShortTermBar =
          shortTerm !== undefined && shortTerm.disabled !== true && shortTermPct !== null;

        const catalogModels = catalogLabelsByFamily.get(pool.family);
        const poolModels =
          catalogModels && catalogModels.length > 0 ? catalogModels : (pool.models ?? []);
        const poolModelsLabel = poolModels.join(', ') || 'N/A';

        const effectivePct = shortTermPct !== null ? Math.min(weeklyPct, shortTermPct) : weeklyPct;
        let statusTone = 'text-pine-iris';
        let barColor = 'bg-pine-iris';
        let statusText = 'Ready to burn';

        if (
          shortTermPct !== null &&
          shortTermPct <= minHeadroomPercent &&
          weeklyPct > minHeadroomPercent
        ) {
          statusTone = 'text-pine-gold';
          barColor = 'bg-pine-gold';
          statusText = '5h Burst Cooldown';
        } else if (weeklyPct === 0) {
          statusTone = 'text-pine-foam';
          barColor = 'bg-pine-pine';
          statusText = 'Tapped out';
        } else if (effectivePct <= minHeadroomPercent) {
          statusTone = 'text-pine-foam';
          barColor = 'bg-pine-foam';
          statusText = minHeadroomPercent > 0 ? 'Safety floor' : 'Well spent';
        } else if (effectivePct <= 25) {
          statusTone = 'text-pine-foam';
          barColor = 'bg-pine-foam';
          statusText = 'Well spent';
        } else if (weeklyHours <= 3) {
          statusTone = 'text-pine-love';
          barColor = 'bg-pine-love';
          statusText = 'Use it or lose it';
        } else if (weeklyHours <= 12) {
          statusTone = 'text-pine-gold';
          barColor = 'bg-pine-gold';
          statusText = 'Expiring soon';
        }

        const weeklyCountdown = getLiveCountdown(weeklyResetTime, weeklyHours);
        const weeklyDateStr = formatResetDate(weeklyResetTime);

        // Burn projection rides in the reset footer: no extra row, no chip that can clip.
        const projection = pool.burnProjection;
        const projectionText = projection
          ? projection.hoursUntilFloor === null
            ? `~${projection.projectedRemainingAtResetPercent}% at reset`
            : `floor in ~${Math.round(projection.hoursUntilFloor)}h`
          : null;

        let paceLabel = null;
        if (weeklyPct <= minHeadroomPercent) {
          paceLabel = (
            <span class="font-mono text-xs font-semibold whitespace-nowrap text-pine-foam">
              Floor engaged
            </span>
          );
        } else if (weeklyHours > 0) {
          const burnRate = ((weeklyFraction * 100) / weeklyHours).toFixed(1);
          paceLabel = (
            <span
              class="font-mono text-xs font-semibold whitespace-nowrap text-pine-iris"
              title="Target consumption pace to fully utilize pool before reset"
            >
              ~{burnRate}%/hr pace
            </span>
          );
        }

        return (
          <div
            key={pool.poolId}
            class="flex h-full flex-col justify-start gap-4 bg-pine-surface p-4 sm:p-5"
          >
            {/* Fixed header height keeps the Weekly Limit bars on one line across cards. */}
            <div class="flex h-17 items-start justify-between gap-3">
              <div class="min-w-0 flex-1">
                <h2
                  class="line-clamp-2 text-base/snug font-semibold text-pine-text"
                  title={poolDisplayName}
                >
                  {poolDisplayName}
                </h2>
                <p class="mt-0.5 truncate text-xs text-pine-subtle" title={poolModelsLabel}>
                  {poolModelsLabel}
                </p>
              </div>
              <span class={`flex shrink-0 items-center gap-1.5 ${statusTone}`}>
                <span class="size-[6px] rounded-full bg-current" aria-hidden="true" />
                <span class="font-mono text-xs tracking-wider whitespace-nowrap uppercase">
                  {statusText}
                </span>
              </span>
            </div>

            <div class="flex flex-col gap-2 border-t border-pine-highlight/40 pt-2">
              <div class="flex items-center justify-between gap-3">
                <span class="text-xs tracking-wider text-pine-subtle uppercase">Weekly Limit</span>
                <span class="text-right text-2xl font-semibold tracking-tight text-pine-text tabular-nums">
                  {weeklyPct}%
                </span>
              </div>
              <div
                role="progressbar"
                aria-valuenow={Math.min(100, Math.max(0, weeklyPct))}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label={`${pool.displayName || pool.poolId} weekly quota remaining`}
                class="relative h-1 bg-pine-sunken"
              >
                <div
                  class={`h-full transition-all duration-500 ease-out ${barColor}`}
                  style={{ width: `${Math.min(100, Math.max(0, weeklyPct))}%` }}
                />
                {projection && projection.projectedRemainingAtResetPercent < weeklyPct && (
                  <div
                    class="absolute inset-y-0"
                    style={{
                      left: `${Math.min(100, Math.max(0, projection.projectedRemainingAtResetPercent))}%`,
                      width: `${Math.min(100, weeklyPct) - Math.max(0, projection.projectedRemainingAtResetPercent)}%`,
                      backgroundImage:
                        'repeating-linear-gradient(45deg, var(--accent-amber) 0 1px, transparent 1px 5px)',
                      opacity: 0.55,
                    }}
                    aria-hidden="true"
                  />
                )}
                <div
                  class="absolute inset-y-0 w-px bg-pine-text/70"
                  style={{ left: `${Math.min(100, Math.max(0, minHeadroomPercent))}%` }}
                  title={`Dispatching stops below ${minHeadroomPercent}%`}
                  aria-hidden="true"
                />
              </div>
              <div class="mt-0.5 flex flex-col gap-0.5 text-xs text-pine-subtle">
                <div class="flex items-center justify-between gap-2">
                  <span class="font-mono text-pine-text">Resets in {weeklyCountdown}</span>
                  <span class="font-mono whitespace-nowrap">{weeklyDateStr}</span>
                </div>
                {(paceLabel || projectionText) && (
                  <div class="flex flex-wrap items-center justify-between gap-x-2 gap-y-0.5">
                    <span class="flex flex-wrap items-center gap-1.5">
                      {paceLabel && <span>{paceLabel}</span>}
                      {paceLabel && projectionText && (
                        <span aria-hidden="true" class="text-pine-muted">
                          ·
                        </span>
                      )}
                      {projectionText && (
                        <span
                          class="whitespace-nowrap"
                          title={
                            projection
                              ? `Projected from a burn rate of ${burnPercentPerHour(projection).toFixed(1)}%/hour`
                              : undefined
                          }
                        >
                          {projectionText}
                        </span>
                      )}
                    </span>
                  </div>
                )}
              </div>
            </div>

            {hasShortTermBar && shortTerm && shortTermPct !== null ? (
              <div class="mt-auto flex flex-col gap-1.5 border-t border-pine-highlight/30 pt-2">
                <div class="flex items-center justify-between gap-3">
                  <span class="text-xs tracking-wider text-pine-subtle uppercase">
                    5-Hour Rolling Limit
                  </span>
                  <span class="text-right text-lg font-semibold text-pine-text tabular-nums">
                    {shortTermPct}%
                  </span>
                </div>
                <div
                  role="progressbar"
                  aria-valuenow={Math.min(100, Math.max(0, shortTermPct))}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-label={`${pool.displayName || pool.poolId} 5-hour rolling limit remaining`}
                  class="h-1 overflow-hidden bg-pine-sunken"
                >
                  <div
                    class="h-full bg-pine-iris/75 transition-all duration-500 ease-out"
                    style={{ width: `${Math.min(100, Math.max(0, shortTermPct))}%` }}
                  />
                </div>
                <div class="mt-0.5 flex flex-wrap items-center justify-between gap-1 text-xs text-pine-subtle">
                  <span>Rolling window</span>
                  <span>
                    Refreshes in {getLiveCountdown(shortTerm.resetTime, shortTerm.hoursUntilReset)}
                  </span>
                </div>
              </div>
            ) : (
              <div class="mt-auto flex items-center justify-between border-t border-pine-highlight/30 pt-2.5 text-xs text-pine-subtle">
                <span>5-Hour Rolling Limit</span>
                <span class="font-mono whitespace-nowrap text-pine-text">
                  {shortTerm?.disabled ? 'Disabled upstream' : 'Uncapped'}
                </span>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
};
