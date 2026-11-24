import { useEffect, useRef, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import type { DispatchEligibility, ModelCatalogEntry } from '../types';
import { getDispatchEligibility } from '../api';
import { useModelCatalog } from '../state/modelCatalogStore';
import { readUiCache, VERDICT_CACHE_KEY, writeUiCache } from '../state/quotaStore';
import { CANONICAL_AGY_MODELS } from '../../../src/shared/models.ts';
import { dialogBackdropClickHandler, useDialogScrollLock } from '../utils/dialog';
import { formatDateTime, formatWindow, useTimeFormat } from '../utils/time';

const VERDICT_POLL_MS = 15_000;

type Tone = 'go' | 'hold' | 'blocked' | 'off';

const toneOf = (verdict: DispatchEligibility): Tone => {
  if (!verdict.accepts) {
    if (verdict.telemetry.authRequired) return 'blocked';
    return verdict.code === 'COORDINATOR_DISABLED' ? 'off' : 'blocked';
  }
  // Queueable but unrunnable is a hold: a green dot would promise a runner that is not there.
  if (!verdict.willRunNow || verdict.autonomy.quenched) return 'hold';
  return 'go';
};

const TONE_DOT: Record<Tone, string> = {
  go: 'bg-pine-foam',
  hold: 'bg-pine-gold',
  blocked: 'bg-pine-love',
  off: 'bg-pine-muted',
};

const modelLabel = (id: string, models: ModelCatalogEntry[]): string =>
  models.find((entry) => entry.id === id)?.label ??
  CANONICAL_AGY_MODELS.find((entry) => entry.id === id)?.label ??
  id;

const runnerCount = (online: number): string => `${online} runner${online === 1 ? '' : 's'}`;

const describe = (verdict: DispatchEligibility, label: string): string => {
  if (verdict.telemetry.authRequired) {
    return (
      verdict.telemetry.authErrorMessage ||
      'Quota probe paused: the IDE session needs re-authentication.'
    );
  }
  if (!verdict.accepts) return verdict.reason ?? `Dispatch blocked (${verdict.code ?? 'unknown'}).`;
  const subject = `Default (${label})`;
  if (!verdict.willRunNow) {
    return `${subject} queueable · ${runnerCount(verdict.runners.online)} online`;
  }
  if (verdict.autonomy.quenched) {
    const minutes = Math.ceil(verdict.autonomy.remainingMs / 60_000);
    return `${subject} · autonomous tiers holding ${minutes}m after manual run`;
  }
  return `${subject} ready to run`;
};

const formatProbeAge = (iso: string | null): string => {
  if (!iso) return 'never probed';
  const elapsed = Date.now() - Date.parse(iso);
  if (!Number.isFinite(elapsed) || elapsed < 0) return 'unknown';
  const seconds = Math.round(elapsed / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.round(minutes / 60)}h ago`;
};

const DetailRow = ({
  label,
  stack = false,
  children,
}: {
  label: string;
  stack?: boolean;
  children: ComponentChildren;
}) => (
  <div
    class={
      stack
        ? 'flex flex-col gap-1 px-3 py-2'
        : 'flex flex-col gap-0.5 px-3 py-2 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4'
    }
  >
    <dt class="shrink-0 text-xs tracking-wider text-pine-subtle uppercase">{label}</dt>
    <dd
      class={`min-w-0 font-mono text-xs wrap-break-word text-pine-text ${
        stack ? '' : 'sm:text-right'
      }`}
    >
      {children}
    </dd>
  </div>
);

/** Renders the server's verdict verbatim; re-deriving eligibility would disagree with the gate. */
export const VerdictBar = ({ syncKey = null }: { syncKey?: number | null }) => {
  const [verdict, setVerdict] = useState<DispatchEligibility | null>(() =>
    readUiCache<DispatchEligibility>(VERDICT_CACHE_KEY)
  );
  const [failed, setFailed] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [detailOpen, setDetailOpen] = useState(false);
  const [timeFormat] = useTimeFormat();
  const catalog = useModelCatalog();
  const dialogRef = useRef<HTMLDialogElement>(null);

  useDialogScrollLock(detailOpen);

  // syncKey is the quota store's lastUpdated, so a quota change re-probes at once instead of letting
  // the two bars drift on independent 15s/60s timers. Restarting the interval anchors it to that edge.
  useEffect(() => {
    let cancelled = false;
    const load = () => {
      getDispatchEligibility()
        .then((next) => {
          if (cancelled) return;
          setVerdict(next);
          writeUiCache(VERDICT_CACHE_KEY, next);
          setFailed(false);
        })
        .catch(() => {
          if (!cancelled) setFailed(true);
        });
    };
    load();
    const timer = setInterval(() => {
      if (!document.hidden) load();
    }, VERDICT_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [syncKey]);

  const openDetail = () => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) {
      dialog.showModal();
      setDetailOpen(true);
    }
  };

  const closeDetail = () => dialogRef.current?.close();

  const refresh = async () => {
    setRefreshing(true);
    try {
      const next = await getDispatchEligibility();
      setVerdict(next);
      writeUiCache(VERDICT_CACHE_KEY, next);
      setFailed(false);
    } catch {
      setFailed(true);
    } finally {
      setRefreshing(false);
    }
  };

  const tone = verdict ? toneOf(verdict) : null;
  const label = verdict ? modelLabel(verdict.model, catalog.models) : '';
  const sentence = verdict
    ? describe(verdict, label)
    : failed
      ? 'Dispatch verdict unavailable'
      : 'Checking dispatch eligibility...';

  const pool = verdict?.pool ?? null;
  const showRunners = verdict?.willRunNow === true;

  return (
    <>
      <button
        type="button"
        onClick={openDetail}
        aria-label={`Dispatch verdict: ${tone ?? 'checking'}`}
        class="flex h-9 w-full cursor-pointer items-center gap-2 rounded-xl border border-pine-highlight bg-pine-surface px-4 text-left text-xs transition-colors hover:border-pine-iris/50 hover:bg-pine-overlay/40 focus-visible:ring-2 focus-visible:ring-pine-iris focus-visible:outline-hidden"
      >
        <span
          class={`size-[6px] shrink-0 rounded-full ${tone ? TONE_DOT[tone] : 'bg-pine-muted'}`}
          aria-hidden="true"
        />
        <span class="min-w-0 flex-1 truncate text-pine-text">{sentence}</span>
        <span class="hidden shrink-0 items-center gap-2 font-mono text-xs text-pine-subtle sm:flex">
          {pool && verdict && (
            <>
              <span title={`effective ${pool.effectivePercent}%`}>
                {pool.limitingWindow === 'short_term' ? '5h' : 'wk'} {pool.effectivePercent}%
              </span>
              <span aria-hidden="true" class="text-pine-muted">
                ·
              </span>
              <span>floor {verdict.floorPercent}%</span>
            </>
          )}
          {verdict && showRunners && (
            <>
              <span aria-hidden="true" class="text-pine-muted">
                ·
              </span>
              <span>{runnerCount(verdict.runners.online)}</span>
            </>
          )}
        </span>
        {verdict && showRunners && (
          <span class="shrink-0 text-xs text-pine-subtle sm:hidden">
            {runnerCount(verdict.runners.online)}
          </span>
        )}
      </button>

      <dialog
        ref={dialogRef}
        aria-labelledby="dispatch-verdict-title"
        onClose={() => setDetailOpen(false)}
        onClick={dialogBackdropClickHandler(dialogRef, closeDetail)}
        class="fixed inset-0 m-auto max-h-[85vh] w-[calc(100%-2rem)] max-w-xl overflow-y-auto overscroll-contain rounded-xl border border-pine-highlight bg-pine-surface p-4 text-pine-text backdrop:bg-black/60 backdrop:backdrop-blur-xs sm:p-6"
      >
        <div class="flex items-baseline justify-between gap-3">
          <h2 id="dispatch-verdict-title" class="text-base font-semibold text-pine-text">
            Dispatch eligibility
          </h2>
          <span class="font-mono text-xs whitespace-nowrap text-pine-subtle">
            {verdict ? formatDateTime(verdict.evaluatedAt, { timeFormat }) : 'pending'}
          </span>
        </div>

        {verdict ? (
          <dl class="mt-4 flex flex-col divide-y divide-pine-highlight/40 overflow-hidden rounded-xl border border-pine-highlight bg-pine-overlay/20">
            <DetailRow label="Verdict" stack>
              {sentence}
            </DetailRow>
            <DetailRow label="Model">
              <span title={verdict.model}>{label}</span>
            </DetailRow>
            <DetailRow label="Pool group">{verdict.poolGroup ?? 'N/A'}</DetailRow>
            <DetailRow label="Pool">{pool?.displayName ?? 'N/A'}</DetailRow>
            <DetailRow label="Limiting window">
              {pool ? (pool.limitingWindow === 'short_term' ? '5-hour' : 'weekly') : 'N/A'}
            </DetailRow>
            <DetailRow label="Weekly remaining">
              {pool?.weeklyPercent === null || pool?.weeklyPercent === undefined
                ? 'N/A'
                : `${pool.weeklyPercent}%`}
            </DetailRow>
            <DetailRow label="5-hour remaining">
              {pool?.shortTermPercent === null || pool?.shortTermPercent === undefined
                ? 'N/A'
                : `${pool.shortTermPercent}%`}
            </DetailRow>
            <DetailRow label="Effective">{pool ? `${pool.effectivePercent}%` : 'N/A'}</DetailRow>
            <DetailRow label="Safety floor">{verdict.floorPercent}%</DetailRow>
            <DetailRow label="Reset in">
              {pool
                ? `${formatWindow(pool.hoursUntilReset)}${
                    pool.resetTime ? ` · ${formatDateTime(pool.resetTime, { timeFormat })}` : ''
                  }`
                : 'N/A'}
            </DetailRow>
            <DetailRow label="Overage allowed">{verdict.allowOverage ? 'Yes' : 'No'}</DetailRow>
            <DetailRow label="Autonomy quench">
              {verdict.autonomy.quenched
                ? `holding ${Math.ceil(verdict.autonomy.remainingMs / 60_000)}m`
                : 'clear'}
            </DetailRow>
            <DetailRow label="Runners online">{verdict.runners.online}</DetailRow>
            <DetailRow label="Probe source">{verdict.telemetry.probeSource || 'unknown'}</DetailRow>
            <DetailRow label="Probe age">{formatProbeAge(verdict.telemetry.lastProbeAt)}</DetailRow>
            <DetailRow label="Probe auth">
              {verdict.telemetry.authRequired
                ? (verdict.telemetry.authErrorMessage ?? 're-authentication required')
                : 'authorized'}
            </DetailRow>
            <DetailRow label="Warnings" stack={verdict.warnings.length > 0}>
              {verdict.warnings.length === 0 ? (
                <span class="text-pine-subtle">None</span>
              ) : (
                <ul class="flex flex-col gap-0.5 text-pine-gold">
                  {verdict.warnings.map((warning) => (
                    <li key={warning}>{warning}</li>
                  ))}
                </ul>
              )}
            </DetailRow>
          </dl>
        ) : (
          <p class="mt-4 text-xs text-pine-subtle">
            {failed
              ? 'The coordinator did not answer the eligibility probe.'
              : 'Waiting for the first eligibility probe.'}
          </p>
        )}

        <div class="mt-4 flex items-center justify-between gap-3">
          <button
            type="button"
            onClick={refresh}
            disabled={refreshing}
            class="inline-flex cursor-pointer items-center rounded-lg border border-pine-highlight bg-pine-overlay px-3 py-1.5 text-xs font-medium text-pine-text transition-colors hover:border-pine-iris disabled:cursor-not-allowed disabled:opacity-50"
          >
            {refreshing ? 'Refreshing...' : 'Refresh'}
          </button>
          <button
            type="button"
            onClick={closeDetail}
            class="inline-flex cursor-pointer items-center rounded-lg px-3 py-1.5 text-xs font-medium text-pine-subtle transition-colors hover:text-pine-text"
          >
            Close
          </button>
        </div>
      </dialog>
    </>
  );
};
