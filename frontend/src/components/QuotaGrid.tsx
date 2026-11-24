import { useEffect, useState } from 'preact/hooks';
import type { QuotaBurnProjection, QuotaSnapshot } from '../types';
import { useModelCatalog } from '../state/modelCatalogStore';
import {
  CANONICAL_AGY_MODELS,
  POOL_GROUP_SHORT_LABELS,
  POOL_GROUPS,
  isOrchestratorModelId,
  type PoolGroup,
} from '../../../src/shared/models.ts';
import { QUOTA_GRID_COLUMNS, quotaGridPlaceholders } from '../../../src/shared/layout.ts';

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
  const [barsRevealed, setBarsRevealed] = useState(false);
  const catalog = useModelCatalog();

  const catalogLabelsByPoolGroup = new Map<string, { models: string[]; routes: string[] }>();
  for (const entry of catalog.models) {
    const bucket = catalogLabelsByPoolGroup.get(entry.poolGroup) ?? { models: [], routes: [] };
    // Orchestration routes are dispatch targets, not models, so they are listed apart.
    (isOrchestratorModelId(entry.id) ? bucket.routes : bucket.models).push(entry.label);
    catalogLabelsByPoolGroup.set(entry.poolGroup, bucket);
  }

  const absentModelsByPoolGroup = new Map<PoolGroup, string>(
    POOL_GROUPS.map((poolGroup) => [
      poolGroup,
      CANONICAL_AGY_MODELS.filter((model) => model.poolGroup === poolGroup)
        .map((model) => model.label)
        .join(', '),
    ])
  );

  // The grid shows one cell per pool group, so a pool this plan does not include still appears.
  const presentPoolGroups = new Set<PoolGroup>(quota.map((pool) => pool.poolGroup as PoolGroup));
  const poolsPerGroup = new Map<PoolGroup, number>();
  for (const pool of quota) {
    const group = pool.poolGroup as PoolGroup;
    poolsPerGroup.set(group, (poolsPerGroup.get(group) ?? 0) + 1);
  }
  const absentPoolGroups =
    quota.length > 0 ? POOL_GROUPS.filter((poolGroup) => !presentPoolGroups.has(poolGroup)) : [];
  const cellCount = quota.length + absentPoolGroups.length;

  useEffect(() => {
    const id = requestAnimationFrame(() => setBarsRevealed(true));
    return () => cancelAnimationFrame(id);
  }, []);

  useEffect(() => {
    const tick = () => {
      if (document.hidden) return;
      setNow(Date.now());
    };
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, []);

  const getLiveCountdown = (isoStr?: string, fallbackHours?: number | null): string => {
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
      <div id="quotaGrid" class="grid grid-cols-1 gap-4 sm:gap-6">
        <div class="flex flex-col gap-4 rounded-xl border border-pine-highlight bg-pine-surface p-5 sm:p-6">
          <p class="text-sm text-pine-subtle">Probing Antigravity Language Server models...</p>
        </div>
      </div>
    );
  }

  return (
    <div
      id="quotaGrid"
      class={`grid gap-px overflow-hidden rounded-xl border border-pine-highlight ${QUOTA_GRID_COLUMNS}`}
    >
      {quota.map((pool) => {
        const poolDisplayName = pool.displayName || pool.poolGroup || pool.poolId;
        // The card is one bucket: a group holding several pools is named by the bucket, a single
        // pool by its codename alone.
        const poolGroupKey = pool.poolGroup as PoolGroup;
        const poolCardTitle =
          (poolsPerGroup.get(poolGroupKey) ?? 1) > 1
            ? `${poolDisplayName} pool`
            : `${POOL_GROUP_SHORT_LABELS[poolGroupKey]} pool`;
        const weeklyFraction = pool.weekly?.remainingFraction ?? pool.remainingFraction;
        const weeklyHours = pool.weekly?.hoursUntilReset ?? pool.hoursUntilReset;
        const weeklyResetTime = pool.weekly?.resetTime ?? pool.resetTime;
        const weeklyPct = percentFloor(weeklyFraction);
        const shortTerm = pool.shortTerm;
        const shortTermPct = shortTerm ? percentFloor(shortTerm.remainingFraction) : null;
        const hasShortTermBar =
          shortTerm !== undefined && shortTerm.disabled !== true && shortTermPct !== null;

        const catalogModels = catalogLabelsByPoolGroup.get(pool.poolGroup);
        const hasCatalogModels =
          catalogModels !== undefined &&
          catalogModels.models.length + catalogModels.routes.length > 0;
        const poolModelLabels = hasCatalogModels ? catalogModels.models : (pool.models ?? []);
        const poolRouteLabels = hasCatalogModels ? catalogModels.routes : [];
        const poolModelsLabel = [...poolModelLabels, ...poolRouteLabels].join(', ') || 'N/A';
        const poolHeaderLines = [
          ...(poolModelLabels.length > 0 ? [poolModelLabels.join(', ')] : []),
          ...(poolRouteLabels.length > 0 ? [poolRouteLabels.join(', ')] : []),
        ];

        const effectivePct = shortTermPct !== null ? Math.min(weeklyPct, shortTermPct) : weeklyPct;
        let statusTone = 'text-pine-iris';
        let barColor = 'bg-pine-iris';
        let statusText = 'Ready to burn';

        // The safety floor is settable up to 100, so it can sit above the 25% notice band.
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
        } else if (effectivePct <= Math.max(25, minHeadroomPercent)) {
          statusTone = 'text-pine-foam';
          barColor = 'bg-pine-foam';
          statusText = effectivePct <= minHeadroomPercent ? 'Safety floor' : 'Well spent';
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
            class="flex h-full flex-col justify-start gap-4 bg-pine-surface p-4 ring-1 ring-pine-highlight/70 sm:p-5"
          >
            {/* Minimum header height keeps the Weekly Limit bars aligned while allowing 2-line titles + routes to expand. */}
            <div class="flex min-h-17 flex-col">
              <div class="flex items-start justify-between gap-3">
                <h2
                  class="line-clamp-2 min-w-0 flex-1 text-base/snug font-semibold text-pine-text"
                  title={poolCardTitle}
                >
                  {poolCardTitle}
                </h2>
                <span class={`flex shrink-0 items-center gap-1.5 ${statusTone}`}>
                  <span class="size-[6px] rounded-full bg-current" aria-hidden="true" />
                  <span class="font-mono text-xs tracking-wider whitespace-nowrap uppercase">
                    {statusText}
                  </span>
                </span>
              </div>
              {/* Full width: beside the status chip the member list lost half its space to truncation. */}
              {(poolHeaderLines.length > 0 ? poolHeaderLines : ['N/A']).map((line) => (
                <p
                  key={line}
                  class="mt-0.5 truncate text-xs text-pine-subtle"
                  title={poolModelsLabel}
                >
                  {line}
                </p>
              ))}
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
                  class={`h-full transition-[width,background-color] duration-700 ease-out ${barColor}`}
                  style={{
                    width: `${barsRevealed ? Math.min(100, Math.max(0, weeklyPct)) : 0}%`,
                  }}
                />
                {minHeadroomPercent > 0 && (
                  <div
                    class="absolute inset-y-0 left-0 bg-pine-love/70 transition-[width] duration-700 ease-out"
                    style={{
                      width: `${barsRevealed ? Math.min(weeklyPct, Math.max(0, minHeadroomPercent)) : 0}%`,
                    }}
                    title={`Dispatching stops below ${minHeadroomPercent}%`}
                    aria-hidden="true"
                  />
                )}
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
                    class="h-full bg-pine-iris/75 transition-[width] duration-700 ease-out"
                    style={{
                      width: `${barsRevealed ? Math.min(100, Math.max(0, shortTermPct)) : 0}%`,
                    }}
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
      {absentPoolGroups.map((poolGroup) => (
        <div
          key={`absent-${poolGroup}`}
          class="flex h-full flex-col justify-start gap-4 bg-pine-surface p-4 ring-1 ring-pine-highlight/70 sm:p-5"
        >
          <div class="flex min-h-17 flex-col">
            <div class="flex items-start justify-between gap-3">
              <h2 class="line-clamp-2 min-w-0 flex-1 text-base/snug font-semibold text-pine-subtle">
                {POOL_GROUP_SHORT_LABELS[poolGroup]} pool
              </h2>
              <span class="flex shrink-0 items-center gap-1.5 text-pine-subtle">
                <span class="size-[6px] rounded-full bg-current" aria-hidden="true" />
                <span class="font-mono text-xs tracking-wider whitespace-nowrap uppercase">
                  Not on plan
                </span>
              </span>
            </div>
            <p
              class="mt-0.5 truncate text-xs text-pine-subtle"
              title={absentModelsByPoolGroup.get(poolGroup)}
            >
              {absentModelsByPoolGroup.get(poolGroup) || 'No models catalogued'}
            </p>
          </div>
          <div class="flex flex-1 flex-col justify-center gap-1 border-t border-pine-highlight/40 pt-2">
            <p class="text-xs text-pine-subtle">No quota pool on this plan.</p>
            <p class="text-xs text-pine-muted">
              Its weekly and 5-hour limits appear when the plan includes it.
            </p>
          </div>
        </div>
      ))}
      {/* A short last row keeps the bordered container from framing bare space. */}
      {quotaGridPlaceholders(cellCount).map((slot) => (
        <div
          key={slot.key}
          aria-hidden="true"
          class={`${slot.className} items-center justify-center p-4 font-mono text-xs tracking-wider text-pine-subtle uppercase ring-1 ring-pine-highlight/70 sm:p-5`}
        >
          No pool
        </div>
      ))}
    </div>
  );
};
