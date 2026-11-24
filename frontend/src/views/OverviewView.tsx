import { useEffect, useState } from 'preact/hooks';
import { faXmark } from '@fortawesome/free-solid-svg-icons';
import type {
  EarlyResetNotice,
  QuotaSnapshot,
  SentryAlertState,
  SwarmRunnerRecord,
} from '../types';
import { QuotaGrid } from '../components/QuotaGrid';
import { Icon } from '../components/Icon';
import { VerdictBar } from '../components/VerdictBar';
import { SwarmRunnersStrip } from '../components/SwarmRunnersStrip';
import { dismissEarlyReset, getRunners } from '../api';
import { readUiCache, RUNNERS_CACHE_KEY, writeUiCache } from '../state/quotaStore';
import { formatWindow } from '../utils/time';

interface OverviewViewProps {
  quota: QuotaSnapshot[];
  quotaUpdatedAt?: number | null;
  alerts: SentryAlertState | null;
  minHeadroomPercent?: number;
  error?: string | null;
  onRetry?: () => void;
  onAlertsChanged?: () => void;
  coordinatorEnabled?: boolean;
}

const formatPercent = (fraction: number): string => `${Math.round(fraction * 100)}%`;

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
    } finally {
      setDismissing(false);
    }
  };

  return (
    <div role="status" class="rounded-xl border border-pine-iris/40 bg-pine-iris/10 px-4 py-3">
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
  quotaUpdatedAt = null,
  alerts,
  minHeadroomPercent = 10,
  error = null,
  onRetry,
  onAlertsChanged,
  coordinatorEnabled = false,
}: OverviewViewProps) => {
  const [runners, setRunners] = useState<SwarmRunnerRecord[]>(
    () => readUiCache<SwarmRunnerRecord[]>(RUNNERS_CACHE_KEY) ?? []
  );
  // Optimistic until the first poll answers: a transient failure must not accuse the config.
  const [credentialsAvailable, setCredentialsAvailable] = useState(true);
  const [runnersError, setRunnersError] = useState<string | null>(null);

  useEffect(() => {
    if (!coordinatorEnabled) return;
    let cancelled = false;
    const load = () => {
      getRunners()
        .then((next) => {
          if (cancelled) return;
          setRunners(next.runners);
          setCredentialsAvailable(next.credentialsAvailable);
          writeUiCache(RUNNERS_CACHE_KEY, next.runners);
          setRunnersError(null);
        })
        .catch((err: any) => {
          if (!cancelled) setRunnersError(err?.message || 'runner poll failed');
        });
    };
    load();
    const timer = setInterval(() => {
      if (!document.hidden) load();
    }, 10_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [coordinatorEnabled]);

  return (
    <div class="flex flex-col gap-4">
      <VerdictBar syncKey={quotaUpdatedAt} />
      {alerts?.earlyResetNotice && alerts.earlyResetNotice.pools.length > 0 && (
        <EarlyResetBanner notice={alerts.earlyResetNotice} onDismissed={onAlertsChanged} />
      )}
      <QuotaGrid
        quota={quota}
        minHeadroomPercent={minHeadroomPercent}
        error={error}
        onRetry={onRetry}
      />
      <SwarmRunnersStrip
        runners={runners}
        credentialsAvailable={credentialsAvailable}
        coordinatorEnabled={coordinatorEnabled}
        runnersError={runnersError}
      />
      <a
        href="/alerts"
        class="flex items-center justify-between gap-3 rounded-xl border border-pine-highlight bg-pine-surface px-3 py-2 text-xs text-pine-subtle transition-colors hover:border-pine-iris/50 hover:text-pine-text"
      >
        <span>Alert history and sentry state</span>
        <span class="text-pine-iris">View alerts -&gt;</span>
      </a>
    </div>
  );
};
