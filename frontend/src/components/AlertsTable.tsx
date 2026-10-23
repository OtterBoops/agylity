import type { SentryAlertState } from '../types';

interface AlertsTableProps {
  alerts: SentryAlertState | null;
}

export const AlertsTable = ({ alerts }: AlertsTableProps) => {
  const pools = alerts?.pools || {};
  const poolKeys = Object.keys(pools);

  return (
    <div class="mb-8">
      <div class="mb-4 flex items-center justify-between">
        <h2 class="text-xl font-semibold text-pine-text">
          Sentry Alert History &amp; Milestone State
        </h2>
        <span class="text-xs text-pine-muted">
          Probe Engine:{' '}
          <span class="rounded bg-pine-overlay px-1.5 py-0.5 font-mono text-xs text-pine-iris">
            {alerts?.lastProbeSource || 'connect_rpc'}
          </span>
        </span>
      </div>

      <div class="overflow-hidden rounded-xl border border-pine-highlight bg-pine-surface shadow-sm">
        <div class="overflow-x-auto">
          <table class="w-full border-collapse text-left text-sm">
            <thead>
              <tr class="border-b border-pine-highlight bg-pine-overlay text-pine-subtle">
                <th class="px-4 py-3 font-semibold">Model Pool</th>
                <th class="px-4 py-3 font-semibold">Headroom</th>
                <th class="px-4 py-3 font-semibold">Reset Time</th>
                <th class="px-4 py-3 font-semibold">Fired Milestones</th>
                <th class="px-4 py-3 font-semibold">Last Alert Sent</th>
              </tr>
            </thead>
            <tbody id="alertsTableBody" class="divide-y divide-pine-highlight/40">
              {poolKeys.length === 0 ? (
                <tr>
                  <td colSpan={5} class="px-4 py-6 text-center text-sm text-pine-muted">
                    No alert milestones fired yet in current cycle
                  </td>
                </tr>
              ) : (
                poolKeys.map((k) => {
                  const pool = pools[k]!;
                  const pct = Math.round(pool.remainingFraction * 100);
                  const fired = pool.firedMilestones?.join(', ') || 'None';
                  const lastSent = pool.lastAlertSentAt
                    ? new Date(pool.lastAlertSentAt).toLocaleString()
                    : 'Never';

                  return (
                    <tr key={k} class="transition-colors hover:bg-white/[0.02]">
                      <td class="px-4 py-3 font-mono text-xs text-pine-iris">
                        <span class="rounded bg-pine-overlay px-1.5 py-0.5">{k}</span>
                      </td>
                      <td class="px-4 py-3 font-medium text-pine-text">{pct}%</td>
                      <td class="px-4 py-3 text-pine-subtle">
                        {pool.resetTime ? new Date(pool.resetTime).toLocaleTimeString() : 'N/A'}
                      </td>
                      <td class="px-4 py-3">
                        <span class="rounded border border-pine-gold bg-pine-gold/20 px-2 py-0.5 text-[11px] font-bold tracking-wider text-pine-gold uppercase">
                          {fired}
                        </span>
                      </td>
                      <td class="px-4 py-3 text-xs text-pine-subtle">{lastSent}</td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
