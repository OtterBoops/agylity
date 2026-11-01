import { faPause, faPlay, faTrash } from '@fortawesome/free-solid-svg-icons';
import { useState } from 'preact/hooks';
import type { SwarmWorkerRecord } from '../types';
import { Icon } from './Icon';

interface SwarmRunnersGridProps {
  workers: SwarmWorkerRecord[];
  onToggleEnabled: (worker: SwarmWorkerRecord) => Promise<void>;
  onRevoke: (worker: SwarmWorkerRecord) => Promise<void>;
}

export const SwarmRunnersGrid = ({ workers, onToggleEnabled, onRevoke }: SwarmRunnersGridProps) => {
  const [confirmRevokeId, setConfirmRevokeId] = useState<string | null>(null);
  const [mutatingId, setMutatingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleToggle = async (w: SwarmWorkerRecord) => {
    setMutatingId(w.workerId);
    setError(null);
    try {
      await onToggleEnabled(w);
    } catch (err: any) {
      setError(err?.message || 'Failed to update runner status');
    } finally {
      setMutatingId(null);
    }
  };

  const handleRevoke = async (w: SwarmWorkerRecord) => {
    setMutatingId(w.workerId);
    setError(null);
    try {
      await onRevoke(w);
      setConfirmRevokeId(null);
    } catch (err: any) {
      setError(err?.message || 'Failed to revoke runner');
    } finally {
      setMutatingId(null);
    }
  };

  return (
    <div class="mt-5 border-t border-pine-highlight pt-4">
      <div class="mb-2.5 flex items-center justify-between">
        <h4 class="text-xs font-semibold tracking-wider text-pine-subtle uppercase">
          Registered Swarm Runners ({workers.length})
        </h4>
      </div>

      {error && (
        <div class="mb-3 rounded-lg border border-pine-love/40 bg-pine-love/10 p-2.5 text-xs text-pine-love">
          {error}
        </div>
      )}

      {workers.length === 0 ? (
        <div class="rounded-lg border border-pine-highlight bg-pine-overlay/25 p-4 text-xs text-pine-muted">
          No runners registered yet. Click <strong class="text-pine-text">New Runner</strong> above
          to generate a registration token and connect a Docker or CLI runner.
        </div>
      ) : (
        <div class="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {workers.map((w) => {
            const isMutating = mutatingId === w.workerId;
            const isConfirmingRevoke = confirmRevokeId === w.workerId;

            return (
              <div
                key={w.workerId}
                class="flex flex-col justify-between gap-3 rounded-lg border border-pine-highlight bg-pine-overlay/40 p-3.5 text-xs"
              >
                <div class="flex items-start justify-between gap-2">
                  <div class="min-w-0">
                    <div class="font-mono font-semibold wrap-break-word text-pine-text">
                      {w.name}
                    </div>
                    <div class="mt-0.5 font-mono text-xs text-pine-muted">{w.workerId}</div>
                  </div>

                  <div class="flex items-center gap-1.5">
                    {!w.enabled && (
                      <span class="rounded-sm border border-pine-muted/40 bg-pine-overlay px-2 py-0.5 text-xs font-bold tracking-wider whitespace-nowrap text-pine-muted uppercase">
                        Paused
                      </span>
                    )}
                    <span
                      class={`rounded-sm border px-2 py-0.5 text-xs font-bold tracking-wider whitespace-nowrap uppercase ${
                        w.status === 'busy'
                          ? 'border-pine-gold bg-pine-gold/20 text-pine-gold'
                          : w.status === 'offline'
                            ? 'border-pine-love/40 bg-pine-love/15 text-pine-love'
                            : 'border-pine-pine bg-pine-pine/20 text-pine-foam'
                      }`}
                    >
                      {w.status}
                    </span>
                  </div>
                </div>

                <div class="flex flex-wrap items-center gap-1.5 text-xs text-pine-muted">
                  {w.systemInfo?.platform && (
                    <span class="rounded-sm bg-pine-surface px-2 py-0.5 font-mono whitespace-nowrap text-pine-subtle">
                      {w.systemInfo.platform}/{w.systemInfo.arch || 'x64'}
                    </span>
                  )}
                  {w.activeTaskId && (
                    <a
                      href="#tasks"
                      class="rounded-sm border border-pine-gold/40 bg-pine-gold/20 px-2 py-0.5 font-mono whitespace-nowrap text-pine-gold hover:underline"
                    >
                      task:{w.activeTaskId.slice(-6)}
                    </a>
                  )}
                  {w.labels?.map((lbl) => (
                    <span
                      key={lbl}
                      class="rounded-sm bg-pine-iris/15 px-2 py-0.5 font-mono whitespace-nowrap text-pine-iris"
                    >
                      {lbl}
                    </span>
                  ))}
                </div>

                <div class="flex items-center justify-between border-t border-pine-highlight/60 pt-2.5">
                  <span class="text-xs text-pine-muted">
                    Seen {new Date(w.lastSeenAt).toLocaleTimeString()}
                  </span>

                  <div class="flex items-center gap-1.5">
                    <button
                      type="button"
                      disabled={isMutating}
                      onClick={() => handleToggle(w)}
                      title={w.enabled ? 'Pause runner' : 'Resume runner'}
                      class="flex cursor-pointer items-center gap-1 rounded-sm border border-pine-highlight bg-pine-surface px-2 py-1 text-xs font-medium whitespace-nowrap text-pine-subtle transition-colors hover:text-pine-text disabled:opacity-50"
                    >
                      <Icon icon={w.enabled ? faPause : faPlay} class="size-2.5" />
                      <span>{w.enabled ? 'Pause' : 'Resume'}</span>
                    </button>

                    {isConfirmingRevoke ? (
                      <div class="flex items-center gap-1">
                        <button
                          type="button"
                          disabled={isMutating}
                          onClick={() => handleRevoke(w)}
                          class="cursor-pointer rounded-sm border border-pine-love bg-pine-love px-2 py-1 text-xs font-bold whitespace-nowrap text-white transition-opacity hover:opacity-90 disabled:opacity-50"
                        >
                          Confirm
                        </button>
                        <button
                          type="button"
                          disabled={isMutating}
                          onClick={() => setConfirmRevokeId(null)}
                          class="cursor-pointer rounded-sm border border-pine-highlight bg-pine-surface px-1.5 py-1 text-xs text-pine-subtle hover:text-pine-text"
                        >
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        disabled={isMutating}
                        onClick={() => setConfirmRevokeId(w.workerId)}
                        title="Revoke runner credential and remove"
                        class="flex cursor-pointer items-center gap-1 rounded-sm border border-pine-love/30 bg-pine-love/10 px-2 py-1 text-xs font-medium whitespace-nowrap text-pine-love transition-colors hover:bg-pine-love hover:text-white disabled:opacity-50"
                      >
                        <Icon icon={faTrash} class="size-2.5" />
                        <span>Revoke</span>
                      </button>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
