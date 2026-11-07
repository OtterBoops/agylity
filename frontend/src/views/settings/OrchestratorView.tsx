import { useState, useEffect, useCallback } from 'preact/hooks';
import { faMinus, faNetworkWired, faPlus } from '@fortawesome/free-solid-svg-icons';
import type { ConfigData, SwarmWorkerRecord } from '../../types';
import { getWorkers, revokeWorker, setWorkerEnabled, updateConfig } from '../../api';
import { Icon } from '../../components/Icon';
import { RunnerRegistrationPanel } from '../../components/RunnerRegistrationPanel';
import { SwarmRunnersGrid } from '../../components/SwarmRunnersGrid';
import { PoolPoliciesCard } from '../../components/PoolPoliciesCard';
import { StandingTasksCard } from '../../components/StandingTasksCard';
import { SettingsForm } from '../../components/SettingsForm';
import { ORCHESTRATOR_FIELDS } from '../../config/fields';

interface OrchestratorViewProps {
  config: ConfigData;
  onChanged: () => void;
}

export const OrchestratorView = ({ config, onChanged }: OrchestratorViewProps) => {
  const [isTogglingOrchestrator, setIsTogglingOrchestrator] = useState(false);
  const [workers, setWorkers] = useState<SwarmWorkerRecord[]>([]);
  const [showRegisterPanel, setShowRegisterPanel] = useState(false);

  const isOrchestratorEnabled = Boolean(config.resolved?.orchestratorEnabled);

  const refreshWorkers = useCallback(() => {
    getWorkers().then((list) => setWorkers(list));
  }, []);

  useEffect(() => {
    if (!isOrchestratorEnabled) return;
    refreshWorkers();
    const timer = setInterval(refreshWorkers, 8000);
    return () => clearInterval(timer);
  }, [isOrchestratorEnabled, refreshWorkers]);

  const handleToggleOrchestrator = async () => {
    setIsTogglingOrchestrator(true);
    try {
      await updateConfig({ orchestratorEnabled: !isOrchestratorEnabled });
      onChanged();
    } finally {
      setIsTogglingOrchestrator(false);
    }
  };

  const handleToggleWorkerEnabled = async (worker: SwarmWorkerRecord) => {
    await setWorkerEnabled(worker.workerId, !worker.enabled);
    refreshWorkers();
  };

  const handleRevokeWorker = async (worker: SwarmWorkerRecord) => {
    await revokeWorker(worker.workerId);
    refreshWorkers();
  };

  const coordinatorOrigin =
    typeof window !== 'undefined' && window.location?.origin
      ? window.location.origin
      : 'http://agylity:8484';

  return (
    <div class="flex flex-col gap-6">
      <div class="rounded-xl border border-pine-highlight bg-pine-surface p-6 shadow-sm">
        <div class="flex flex-wrap items-center justify-between gap-4">
          <div>
            <div class="mb-1 flex flex-wrap items-center gap-2">
              <Icon icon={faNetworkWired} class="size-5 text-pine-iris" />
              <h3 class="text-lg font-semibold text-pine-text">
                Task Orchestrator &amp; Swarm Runners
              </h3>
              <span
                class={`rounded-full border px-2.5 py-0.5 text-xs font-bold tracking-wider whitespace-nowrap uppercase ${
                  isOrchestratorEnabled
                    ? 'border-pine-pine bg-pine-pine/20 text-pine-foam'
                    : 'border-pine-highlight bg-pine-overlay text-pine-subtle'
                }`}
              >
                {isOrchestratorEnabled ? 'Enabled' : 'Disabled'}
              </span>
            </div>
            <p class="text-xs text-pine-subtle">
              Pure runner control plane: queue tasks into SQLite and execute isolated continuation
              branches across registered Docker or host CLI runners.
            </p>
          </div>

          <div class="flex flex-wrap items-center gap-2.5">
            {isOrchestratorEnabled && (
              <button
                type="button"
                onClick={() => setShowRegisterPanel(!showRegisterPanel)}
                class="flex cursor-pointer items-center gap-1.5 rounded-lg border border-pine-iris/40 bg-pine-iris/15 px-3.5 py-2 text-xs font-semibold whitespace-nowrap text-pine-iris transition-colors hover:bg-pine-iris hover:text-pine-base sm:text-sm"
              >
                <Icon icon={showRegisterPanel ? faMinus : faPlus} class="size-3" />
                <span>{showRegisterPanel ? 'Hide Form' : 'New Runner'}</span>
              </button>
            )}

            <button
              type="button"
              disabled={isTogglingOrchestrator}
              onClick={handleToggleOrchestrator}
              class={`cursor-pointer rounded-lg px-4 py-2 text-xs font-semibold whitespace-nowrap transition-colors sm:text-sm ${
                isOrchestratorEnabled
                  ? 'border border-pine-love/40 bg-pine-love/15 text-pine-love hover:bg-pine-love hover:text-white'
                  : 'bg-pine-iris text-pine-base hover:opacity-90'
              }`}
            >
              {isTogglingOrchestrator
                ? 'Updating...'
                : isOrchestratorEnabled
                  ? 'Disable Orchestrator'
                  : 'Enable Orchestrator'}
            </button>
          </div>
        </div>

        {isOrchestratorEnabled && showRegisterPanel && (
          <div class="mt-5">
            <RunnerRegistrationPanel coordinatorOrigin={coordinatorOrigin} />
          </div>
        )}

        {isOrchestratorEnabled && (
          <SwarmRunnersGrid
            workers={workers}
            onToggleEnabled={handleToggleWorkerEnabled}
            onRevoke={handleRevokeWorker}
          />
        )}
      </div>

      {isOrchestratorEnabled && <PoolPoliciesCard config={config} onSaved={onChanged} />}

      {isOrchestratorEnabled && <StandingTasksCard config={config} />}

      {isOrchestratorEnabled && (
        <SettingsForm
          title="Model Selection &amp; Swarm Queue Parameters"
          description="Configure the explicit default dispatch model, fallback runner secret, and P2 opportunistic quota-burn thresholds."
          fields={ORCHESTRATOR_FIELDS}
          config={config}
          onSaved={onChanged}
        />
      )}
    </div>
  );
};
