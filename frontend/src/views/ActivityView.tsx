import { useEffect, useState } from 'preact/hooks';
import type { DispatchRecord, SentryAlertState } from '../types';
import { AlertsTable } from '../components/AlertsTable';
import { getDispatches } from '../api';

interface ActivityViewProps {
  alerts: SentryAlertState | null;
}

const formatDuration = (ms: number): string => {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
};

export const ActivityView = ({ alerts }: ActivityViewProps) => {
  const [dispatches, setDispatches] = useState<DispatchRecord[]>([]);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      getDispatches(50)
        .then((records) => {
          if (!cancelled) setDispatches(records);
        })
        .catch(() => {
          // retry on next tick
        });
    };
    load();
    const timer = setInterval(load, 10000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  return (
    <div class="flex flex-col gap-2">
      <div class="mb-8">
        <h2 class="mb-4 text-xl font-semibold text-pine-text">Dispatch History</h2>
        <div class="overflow-hidden rounded-xl border border-pine-highlight bg-pine-surface shadow-sm">
          <div class="overflow-x-auto">
            <table class="w-full border-collapse text-left text-sm">
              <thead>
                <tr class="border-b border-pine-highlight bg-pine-overlay text-pine-subtle">
                  <th class="px-4 py-3 font-semibold">When</th>
                  <th class="px-4 py-3 font-semibold">Repository</th>
                  <th class="px-4 py-3 font-semibold">Prompt</th>
                  <th class="px-4 py-3 font-semibold">By</th>
                  <th class="px-4 py-3 font-semibold">Result</th>
                  <th class="px-4 py-3 font-semibold">Took</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-pine-highlight/40">
                {dispatches.length === 0 ? (
                  <tr>
                    <td colSpan={6} class="px-4 py-6 text-center text-sm text-pine-muted">
                      No tasks dispatched yet
                    </td>
                  </tr>
                ) : (
                  dispatches.map((d) => (
                    <tr key={d.id} class="align-top transition-colors hover:bg-white/[0.02]">
                      <td class="px-4 py-3 text-xs whitespace-nowrap text-pine-subtle">
                        {new Date(d.createdAt).toLocaleString()}
                      </td>
                      <td class="px-4 py-3 font-mono text-xs text-pine-iris">{d.repository}</td>
                      <td class="max-w-sm truncate px-4 py-3 text-pine-text" title={d.prompt}>
                        {d.prompt}
                      </td>
                      <td class="px-4 py-3 text-xs text-pine-subtle">{d.requestedBy}</td>
                      <td class="px-4 py-3">
                        <span
                          class={`rounded border px-2 py-0.5 text-[11px] font-bold tracking-wider uppercase ${
                            d.success
                              ? 'border-pine-pine bg-pine-pine/20 text-pine-foam'
                              : 'border-pine-love bg-pine-love/20 text-pine-love'
                          }`}
                          title={d.error || d.branch || ''}
                        >
                          {d.success ? 'Done' : 'Failed'}
                        </span>
                        {d.branch && (
                          <div class="mt-1 font-mono text-[11px] text-pine-muted">{d.branch}</div>
                        )}
                        {d.error && (
                          <div class="mt-1 max-w-xs text-[11px] text-pine-love">{d.error}</div>
                        )}
                      </td>
                      <td class="px-4 py-3 text-xs whitespace-nowrap text-pine-subtle">
                        {formatDuration(d.durationMs)}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <AlertsTable alerts={alerts} />
    </div>
  );
};
