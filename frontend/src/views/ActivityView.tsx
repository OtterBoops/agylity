import { useEffect, useState } from 'preact/hooks';
import { faCheck, faCopy, faTimes } from '@fortawesome/free-solid-svg-icons';
import type { DispatchRecord, SentryAlertState } from '../types';
import { AlertsTable } from '../components/AlertsTable';
import { getDispatches } from '../api';
import { Icon } from '../components/Icon';

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
  const [selectedDispatch, setSelectedDispatch] = useState<DispatchRecord | null>(null);
  const [copiedPrompt, setCopiedPrompt] = useState(false);

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

  const handleCopyPrompt = async () => {
    if (!selectedDispatch) return;
    try {
      await navigator.clipboard.writeText(selectedDispatch.prompt);
      setCopiedPrompt(true);
      setTimeout(() => setCopiedPrompt(false), 2000);
    } catch {
      // fallback
    }
  };

  return (
    <div class="flex flex-col gap-2">
      <div class="mb-8">
        <div class="mb-4 flex items-center justify-between">
          <h2 class="text-xl font-semibold text-pine-text sm:text-2xl">Dispatch History</h2>
          <span class="text-xs text-pine-muted sm:text-sm">
            Click any row to inspect task prompt &amp; telemetry
          </span>
        </div>
        <div class="overflow-hidden rounded-xl border border-pine-highlight bg-pine-surface shadow-sm">
          <div class="overflow-x-auto">
            <table class="w-full border-collapse text-left text-sm">
              <thead>
                <tr class="border-b border-pine-highlight bg-pine-overlay text-xs font-semibold text-pine-subtle sm:text-sm">
                  <th class="px-4 py-3">When</th>
                  <th class="px-4 py-3">Repository</th>
                  <th class="px-4 py-3">Prompt</th>
                  <th class="px-4 py-3">By</th>
                  <th class="px-4 py-3">Result</th>
                  <th class="px-4 py-3">Took</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-pine-highlight">
                {dispatches.length === 0 ? (
                  <tr>
                    <td
                      colSpan={6}
                      class="px-4 py-8 text-center text-xs text-pine-muted sm:text-sm"
                    >
                      No tasks dispatched yet
                    </td>
                  </tr>
                ) : (
                  dispatches.map((d) => (
                    <tr
                      key={d.id}
                      onClick={() => setSelectedDispatch(d)}
                      class="cursor-pointer align-top transition-colors hover:bg-white/[0.04]"
                      title="Click to inspect task details"
                    >
                      <td class="px-4 py-3 text-xs whitespace-nowrap text-pine-subtle sm:text-sm">
                        {new Date(d.createdAt).toLocaleString()}
                      </td>
                      <td class="px-4 py-3 font-mono text-xs text-pine-iris sm:text-sm">
                        {d.repository}
                      </td>
                      <td class="max-w-sm truncate px-4 py-3 text-pine-text" title={d.prompt}>
                        {d.prompt}
                      </td>
                      <td class="px-4 py-3 text-xs text-pine-subtle sm:text-sm">{d.requestedBy}</td>
                      <td class="px-4 py-3">
                        <span
                          class={`rounded border px-2 py-0.5 text-xs font-bold tracking-wider uppercase ${
                            d.success
                              ? 'border-pine-pine bg-pine-pine/20 text-pine-foam'
                              : 'border-pine-love bg-pine-love/20 text-pine-love'
                          }`}
                        >
                          {d.success ? 'Done' : 'Failed'}
                        </span>
                        {d.branch && (
                          <div class="mt-1 font-mono text-xs text-pine-muted">{d.branch}</div>
                        )}
                      </td>
                      <td class="px-4 py-3 text-xs whitespace-nowrap text-pine-subtle sm:text-sm">
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

      {/* Dispatch Detail Modal Inspector */}
      {selectedDispatch && (
        <div
          class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-xs"
          onClick={() => setSelectedDispatch(null)}
        >
          <div
            class="flex max-h-[85vh] w-full max-w-2xl flex-col rounded-xl border border-pine-highlight bg-pine-surface p-6 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Modal Header */}
            <div class="flex items-center justify-between border-b border-pine-highlight pb-4">
              <div class="flex items-center gap-3">
                <h3 class="text-lg font-bold text-pine-text">Task #{selectedDispatch.id}</h3>
                <span
                  class={`rounded border px-2 py-0.5 text-xs font-bold tracking-wider uppercase ${
                    selectedDispatch.success
                      ? 'border-pine-pine bg-pine-pine/20 text-pine-foam'
                      : 'border-pine-love bg-pine-love/20 text-pine-love'
                  }`}
                >
                  {selectedDispatch.success ? 'Done' : 'Failed'}
                </span>
              </div>
              <button
                type="button"
                onClick={() => setSelectedDispatch(null)}
                class="cursor-pointer rounded-lg p-1.5 text-pine-muted transition-colors hover:bg-pine-overlay hover:text-pine-text"
              >
                <Icon icon={faTimes} class="size-4" />
              </button>
            </div>

            {/* Modal Content */}
            <div class="mt-4 flex flex-1 flex-col gap-4 overflow-y-auto pr-1">
              {/* Telemetry metadata */}
              <div class="grid grid-cols-2 gap-3 rounded-lg border border-pine-highlight bg-pine-overlay/30 p-3 text-xs sm:grid-cols-4">
                <div>
                  <span class="text-pine-muted">Repository</span>
                  <div class="mt-0.5 font-mono font-medium text-pine-iris">
                    {selectedDispatch.repository}
                  </div>
                </div>
                <div>
                  <span class="text-pine-muted">Initiated By</span>
                  <div class="mt-0.5 font-medium text-pine-text">
                    {selectedDispatch.requestedBy}
                  </div>
                </div>
                <div>
                  <span class="text-pine-muted">Duration</span>
                  <div class="mt-0.5 font-medium text-pine-text">
                    {formatDuration(selectedDispatch.durationMs)}
                  </div>
                </div>
                <div>
                  <span class="text-pine-muted">Timestamp</span>
                  <div class="mt-0.5 font-mono text-[11px] text-pine-text">
                    {new Date(selectedDispatch.createdAt).toLocaleTimeString()}
                  </div>
                </div>
              </div>

              {selectedDispatch.branch && (
                <div class="flex items-center gap-2 text-xs">
                  <span class="text-pine-muted">Target Branch:</span>
                  <span class="rounded border border-pine-highlight bg-pine-overlay px-2 py-0.5 font-mono text-pine-foam">
                    {selectedDispatch.branch}
                  </span>
                </div>
              )}

              {/* Prompt Block */}
              <div class="flex flex-col gap-1.5">
                <div class="flex items-center justify-between">
                  <span class="text-xs font-semibold tracking-wider text-pine-subtle uppercase">
                    Task Prompt
                  </span>
                  <button
                    type="button"
                    onClick={handleCopyPrompt}
                    class="inline-flex cursor-pointer items-center gap-1 text-xs text-pine-iris hover:underline"
                  >
                    <Icon icon={copiedPrompt ? faCheck : faCopy} class="size-3" />
                    <span>{copiedPrompt ? 'Copied' : 'Copy Prompt'}</span>
                  </button>
                </div>
                <div class="max-h-60 overflow-y-auto rounded-lg border border-pine-highlight bg-pine-overlay/60 p-3.5 font-mono text-xs/relaxed whitespace-pre-wrap text-pine-text">
                  {selectedDispatch.prompt}
                </div>
              </div>

              {/* Error Block if any */}
              {selectedDispatch.error && (
                <div class="flex flex-col gap-1.5">
                  <span class="text-xs font-semibold tracking-wider text-pine-love uppercase">
                    Failure Diagnostic
                  </span>
                  <div class="rounded-lg border border-pine-love/40 bg-pine-love/10 p-3 font-mono text-xs whitespace-pre-wrap text-pine-love">
                    {selectedDispatch.error}
                  </div>
                </div>
              )}
            </div>

            {/* Modal Footer */}
            <div class="mt-5 flex items-center justify-end border-t border-pine-highlight pt-4">
              <button
                type="button"
                onClick={() => setSelectedDispatch(null)}
                class="cursor-pointer rounded-lg border border-pine-highlight bg-pine-overlay px-4 py-2 text-xs font-medium text-pine-text transition-colors hover:bg-pine-highlight/50"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
