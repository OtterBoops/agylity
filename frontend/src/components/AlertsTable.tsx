import type { SentryAlertState } from '../types';

interface AlertsTableProps {
  alerts: SentryAlertState | null;
}

export const AlertsTable = ({ alerts }: AlertsTableProps) => {
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
        <h3 class="text-base font-semibold text-pine-text">Alert Event Log</h3>
        <p class="mt-0.5 text-xs text-pine-subtle">
          Milestone warnings dispatched when quota thresholds are reached
        </p>
      </div>

      <div class="overflow-hidden rounded-xl border border-pine-highlight bg-pine-surface shadow-sm">
        <div class="overflow-x-auto">
          <table class="w-full border-collapse text-left text-sm">
            <thead>
              <tr class="border-b border-pine-highlight bg-pine-overlay text-xs font-medium text-pine-subtle">
                <th class="px-4 py-3">Time</th>
                <th class="px-4 py-3">Model Pool</th>
                <th class="px-4 py-3">Milestone</th>
                <th class="px-4 py-3 text-right">Headroom at Alert</th>
              </tr>
            </thead>
            <tbody id="alertsTableBody" class="divide-y divide-pine-highlight/40">
              {firedEvents.length === 0 ? (
                <tr>
                  <td colSpan={4} class="px-4 py-8 text-center text-xs text-pine-muted">
                    No milestone alerts have fired in the current cycle.
                  </td>
                </tr>
              ) : (
                firedEvents.map((ev) => (
                  <tr key={ev.poolId} class="transition-colors hover:bg-white/[0.02]">
                    <td class="px-4 py-3 text-xs text-pine-subtle">
                      {ev.lastAlertSentAt
                        ? new Date(ev.lastAlertSentAt).toLocaleTimeString([], {
                            hour: '2-digit',
                            minute: '2-digit',
                          })
                        : 'N/A'}
                    </td>
                    <td class="px-4 py-3 font-mono text-xs text-pine-iris">{ev.poolId}</td>
                    <td class="px-4 py-3">
                      <span class="font-mono text-xs text-pine-gold">
                        {ev.firedMilestones.join(', ')}
                      </span>
                    </td>
                    <td class="px-4 py-3 text-right text-xs font-medium text-pine-text">
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
