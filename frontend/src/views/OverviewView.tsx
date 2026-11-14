import { useState } from 'preact/hooks';
import { faXmark } from '@fortawesome/free-solid-svg-icons';
import type { EarlyResetNotice, QuotaSnapshot, SentryAlertState } from '../types';
import { QuotaGrid } from '../components/QuotaGrid';
import { Icon } from '../components/Icon';
import { dismissEarlyReset } from '../api';
import { ActivityView } from './ActivityView';

interface OverviewViewProps {
  quota: QuotaSnapshot[];
  alerts: SentryAlertState | null;
  minHeadroomPercent?: number;
  error?: string | null;
  onRetry?: () => void;
  onAlertsChanged?: () => void;
}

const formatPercent = (fraction: number): string => `${Math.round(fraction * 100)}%`;

const formatWindow = (hours: number): string => {
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))}m`;
  if (hours < 24) return `${Math.round(hours)}h`;
  return `${Math.floor(hours / 24)}d ${Math.round(hours % 24)}h`;
};

const hoursBetween = (fromIso: string, toIso: string): number | null => {
  const from = Date.parse(fromIso);
  const to = Date.parse(toIso);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  return Math.max(0, (to - from) / (60 * 60 * 1000));
};

const EarlyResetBanner = ({
  notice,
  onDismissed,
}: {
  notice: EarlyResetNotice;
  onDismissed?: () => void;
}) => {
  const [dismissing, setDismissing] = useState(false);

  const handleDismiss = async () => {
    if (dismissing) return;
    setDismissing(true);
    try {
      await dismissEarlyReset();
      onDismissed?.();
    } catch {
      // The notice stays on screen; the next poll re-reads the server state.
    } finally {
      setDismissing(false);
    }
  };

  return (
    <div
      role="status"
      class="mb-6 rounded-xl border border-pine-iris/40 bg-pine-iris/10 px-4 py-3 shadow-xs"
    >
      <div class="flex items-start justify-between gap-3">
        <div class="min-w-0">
          <div class="flex flex-wrap items-center gap-2">
            <span class="rounded-sm bg-pine-iris/20 px-2 py-0.5 font-mono text-xs font-bold tracking-wider whitespace-nowrap text-pine-iris uppercase">
              [NOTICE]
            </span>
            <span class="text-xs font-semibold text-pine-text">Quota reset ahead of schedule</span>
          </div>
          <ul class="mt-1.5 space-y-1 text-xs text-pine-text">
            {notice.pools.map((pool) => {
              const window = hoursBetween(notice.detectedAt, pool.previousResetTime);
              return (
                <li key={pool.poolId} class="flex flex-wrap items-baseline gap-1">
                  <span class="font-medium">{pool.displayName || pool.poolId}</span>
                  <span>
                    went from {formatPercent(pool.previousRemainingFraction)} to{' '}
                    {formatPercent(pool.remainingFraction)} remaining
                  </span>
                  {window !== null && (
                    <span class="text-pine-muted">
                      with {formatWindow(window)} left on the scheduled cycle
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
        <button
          type="button"
          onClick={handleDismiss}
          disabled={dismissing}
          aria-label="Dismiss early reset notice"
          class="inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-lg border border-pine-highlight text-pine-muted transition-colors hover:bg-pine-highlight/40 hover:text-pine-text disabled:cursor-default disabled:opacity-50"
        >
          <Icon icon={faXmark} class="size-3.5" />
        </button>
      </div>
    </div>
  );
};

export const OverviewView = ({
  quota,
  alerts,
  minHeadroomPercent = 10,
  error = null,
  onRetry,
  onAlertsChanged,
}: OverviewViewProps) => (
  <div>
    {alerts?.earlyResetNotice && alerts.earlyResetNotice.pools.length > 0 && (
      <EarlyResetBanner notice={alerts.earlyResetNotice} onDismissed={onAlertsChanged} />
    )}
    <QuotaGrid
      quota={quota}
      minHeadroomPercent={minHeadroomPercent}
      error={error}
      onRetry={onRetry}
    />
    <ActivityView alerts={alerts} />
  </div>
);
