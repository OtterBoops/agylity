import type { SentryAlertState } from '../types';
import { formatTime, useTimeFormat } from '../utils/time';

interface AlertsTableProps {
  alerts: SentryAlertState | null;
}

export const AlertsTable = ({ alerts }: AlertsTableProps) => {
  const [timeFormat] = useTimeFormat();
  const pools = alerts?.pools || {};
  const firedEvents = Object.keys(pools)
    .filter(
      (k) => (pools[k]?.firedMilestones?.length ?? 0) > 0 || Boolean(pools[k]?.lastAlertSentAt)
    )
    .map((k) => ({
      poolId: k,
      ...pools[k]!,
    }));

  return (
    <div class="mb-8">
      <div class="mb-3">
        <h3 class="text-base font-semibold text-pine-text sm:text-lg">Alert Event Log</h3>
        <p class="mt-0.5 text-xs text-pine-subtle sm:text-sm">
          Milestone warnings dispatched when quota thresholds are reached
        </p>
      </div>

      <div class="overflow-hidden rounded-xl border border-pine-highlight bg-pine-surface shadow-sm">
        <div class="overflow-x-auto">
          <table class="w-full min-w-[540px] border-collapse text-left text-sm">
            <thead>
              <tr class="border-b border-pine-highlight bg-pine-overlay/40 font-mono text-xs tracking-wider text-pine-subtle uppercase sm:text-[13px]">
                <th class="px-4 py-3 whitespace-nowrap">Time</th>
                <th class="px-4 py-3 whitespace-nowrap">Model Pool</th>
                <th class="px-4 py-3 whitespace-nowrap">Milestone</th>
                <th class="px-4 py-3 text-right whitespace-nowrap">Headroom at Alert</th>
              </tr>
            </thead>
            <tbody id="alertsTableBody" class="divide-y divide-pine-highlight/40">
              {firedEvents.length === 0 ? (
                <tr>
                  <td colSpan={4} class="px-4 py-8 text-center text-xs text-pine-muted sm:text-sm">
                    No milestone alerts have fired in the current cycle.
                  </td>
                </tr>
              ) : (
                firedEvents.map((ev) => (
                  <tr key={ev.poolId} class="transition-colors hover:bg-white/2">
                    <td class="px-4 py-3 text-xs whitespace-nowrap text-pine-subtle sm:text-sm">
                      {ev.lastAlertSentAt ? formatTime(ev.lastAlertSentAt, { timeFormat }) : 'N/A'}
                    </td>
                    <td class="px-4 py-3 font-mono text-xs whitespace-nowrap text-pine-iris sm:text-sm">
                      {ev.poolId}
                    </td>
                    <td class="px-4 py-3 whitespace-nowrap">
                      <span class="font-mono text-xs text-pine-gold sm:text-sm">
                        {(ev.firedMilestones ?? []).join(', ') || 'N/A'}
                      </span>
                    </td>
                    <td class="px-4 py-3 text-right text-xs font-semibold whitespace-nowrap text-pine-text sm:text-sm">
                      {Math.round(ev.remainingFraction * 100)}%
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
