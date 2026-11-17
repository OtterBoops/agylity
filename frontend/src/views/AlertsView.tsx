import { useEffect, useState } from 'preact/hooks';
import type { AlertEvent, SentryAlertState } from '../types';
import { getAlertEvents } from '../api';
import { formatTime, useTimeFormat } from '../utils/time';
import { TableHeadRow, TableRow, TableShell, TH } from '../components/TableShell';

interface AlertsViewProps {
  alerts: SentryAlertState | null;
}

const KIND_LABEL: Record<string, string> = {
  milestone: 'Milestone',
  early_reset: 'Early reset',
};

const channelSummary = (channels: AlertEvent['channels']): string => {
  const names = Object.keys(channels);
  if (names.length === 0) return 'no channel configured';
  const failed = names.filter((name) => channels[name] && channels[name]!.success === false);
  return failed.length === 0 ? names.join(', ') : `${failed.join(', ')} failed`;
};

export const AlertsView = ({ alerts }: AlertsViewProps) => {
  const [timeFormat] = useTimeFormat();
  const [events, setEvents] = useState<AlertEvent[]>([]);
  const [nextBefore, setNextBefore] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = async (before?: string) => {
    setLoading(true);
    try {
      const page = await getAlertEvents({ limit: 50, before });
      setEvents((prev) => (before ? [...prev, ...page.events] : page.events));
      setNextBefore(page.nextBefore);
      setError(null);
    } catch (err: any) {
      setError(err?.message || 'Could not load alert history');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const pools = alerts?.pools ? Object.entries(alerts.pools) : [];

  return (
    <div class="mx-auto w-full max-w-5xl">
      <h2 class="mb-1 text-lg font-semibold text-pine-text">Sentry state</h2>
      <p class="mb-4 text-sm text-pine-subtle">
        What is armed for the current reset cycle, per pool.
      </p>

      <TableShell class="mb-8">
        <table class="w-full min-w-[560px] table-fixed text-left">
          <colgroup>
            <col class="w-[28%]" />
            <col class="w-[18%]" />
            <col class="w-[32%]" />
            <col class="w-[22%]" />
          </colgroup>
          <thead>
            <TableHeadRow>
              <TH class="px-3.5">Pool</TH>
              <TH class="px-3.5">Remaining</TH>
              <TH class="px-3.5">Milestones fired</TH>
              <TH class="px-3.5">Last alert</TH>
            </TableHeadRow>
          </thead>
          <tbody>
            {pools.length === 0 ? (
              <tr>
                <td colspan={4} class="px-3.5 py-4 text-center text-xs text-pine-subtle">
                  No sentry state yet: the first probe has not completed.
                </td>
              </tr>
            ) : (
              pools.map(([poolId, pool]) => (
                <TableRow key={poolId}>
                  <td class="truncate px-3.5 font-mono text-xs text-pine-iris">{poolId}</td>
                  <td class="px-3.5 font-mono text-xs text-pine-text">
                    {Math.round((pool.remainingFraction ?? 0) * 100)}%
                  </td>
                  <td class="truncate px-3.5 font-mono text-xs text-pine-gold">
                    {(pool.firedMilestones ?? []).join(', ') || '-'}
                  </td>
                  <td class="truncate px-3.5 font-mono text-xs text-pine-subtle">
                    {pool.lastAlertSentAt ? formatTime(pool.lastAlertSentAt, { timeFormat }) : '-'}
                  </td>
                </TableRow>
              ))
            )}
          </tbody>
        </table>
      </TableShell>

      <h2 class="mb-1 text-lg font-semibold text-pine-text">Delivery history</h2>
      <p class="mb-4 text-sm text-pine-subtle">
        Every alert that reached the notifier, newest first.
      </p>

      {error && (
        <p
          role="alert"
          class="mb-3 rounded-lg border border-pine-love/40 bg-pine-love/10 px-3 py-2 text-xs text-pine-love"
        >
          {error}
        </p>
      )}

      <TableShell>
        <table class="w-full min-w-[620px] table-fixed text-left">
          <colgroup>
            <col class="w-[20%]" />
            <col class="w-[18%]" />
            <col class="w-[20%]" />
            <col class="w-[14%]" />
            <col class="w-[28%]" />
          </colgroup>
          <thead>
            <TableHeadRow>
              <TH class="px-3.5">Fired</TH>
              <TH class="px-3.5">Pool</TH>
              <TH class="px-3.5">Kind</TH>
              <TH class="px-3.5">Headroom</TH>
              <TH class="px-3.5">Channel</TH>
            </TableHeadRow>
          </thead>
          <tbody>
            {events.length === 0 ? (
              <tr>
                <td colspan={5} class="px-3.5 py-4 text-center text-xs text-pine-subtle">
                  {loading ? 'Loading history...' : 'No alerts delivered yet.'}
                </td>
              </tr>
            ) : (
              events.map((event) => (
                <TableRow key={event.id}>
                  <td class="truncate px-3.5 font-mono text-xs text-pine-subtle">
                    {formatTime(event.firedAt, { timeFormat })}
                  </td>
                  <td class="truncate px-3.5 font-mono text-xs text-pine-iris">{event.poolId}</td>
                  <td class="truncate px-3.5 text-xs text-pine-gold">
                    {KIND_LABEL[event.kind] ?? event.kind}
                    {event.kind === 'milestone' && event.milestoneHours !== null
                      ? ` ${event.milestoneHours}h`
                      : ''}
                  </td>
                  <td class="px-3.5 font-mono text-xs text-pine-text">
                    {event.headroomPercent === null ? '-' : `${Math.round(event.headroomPercent)}%`}
                  </td>
                  <td class="truncate px-3.5 text-xs text-pine-subtle">
                    {channelSummary(event.channels)}
                  </td>
                </TableRow>
              ))
            )}
          </tbody>
        </table>
      </TableShell>

      {nextBefore && (
        <button
          type="button"
          onClick={() => void load(nextBefore)}
          disabled={loading}
          class="mt-4 min-h-11 cursor-pointer rounded-lg border border-pine-highlight bg-pine-overlay px-3 py-2 text-sm text-pine-text enabled:hover:bg-pine-highlight disabled:opacity-50"
        >
          {loading ? 'Loading...' : 'Load older alerts'}
        </button>
      )}
    </div>
  );
};
