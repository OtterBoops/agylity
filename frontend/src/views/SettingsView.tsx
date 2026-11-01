import {
  faChevronDown,
  faChevronUp,
  faCodeBranch,
  faNetworkWired,
  faPlus,
} from '@fortawesome/free-solid-svg-icons';
import { useCallback, useEffect, useState } from 'preact/hooks';
import type { ConfigData, SwarmWorkerRecord } from '../types';
import type { Route } from '../router';
import { getWorkers, revokeWorker, setWorkerEnabled, updateConfig } from '../api';
import { SettingsForm } from '../components/SettingsForm';
import { ConfigTable } from '../components/ConfigTable';
import { RepoEditor } from '../components/RepoEditor';
import { Icon } from '../components/Icon';
import { NotificationsView } from './NotificationsView';
import { RunnerRegistrationPanel } from '../components/RunnerRegistrationPanel';
import { SwarmRunnersGrid } from '../components/SwarmRunnersGrid';
import { ORCHESTRATOR_FIELDS, SENTRY_FIELDS } from '../config/fields';

interface SettingsViewProps {
  route: Route;
  config: ConfigData;
  onChanged: () => void;
}

export const SettingsView = ({ route, config, onChanged }: SettingsViewProps) => {
  const [showRawTable, setShowRawTable] = useState(false);
  const [isTogglingOrchestrator, setIsTogglingOrchestrator] = useState(false);
  const [workers, setWorkers] = useState<SwarmWorkerRecord[]>([]);
  const [showRegisterPanel, setShowRegisterPanel] = useState(false);

  const isOrchestratorEnabled = Boolean(config.resolved?.orchestratorEnabled);

  const refreshWorkers = useCallback(() => {
    getWorkers().then((list) => setWorkers(list));
  }, []);

  useEffect(() => {
    if (route !== 'settings/remote' || !isOrchestratorEnabled) return;
    refreshWorkers();
    const timer = setInterval(refreshWorkers, 8000);
    return () => clearInterval(timer);
  }, [route, isOrchestratorEnabled, refreshWorkers]);

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

  switch (route) {
    case 'settings/notifications':
      return <NotificationsView config={config} onSaved={onChanged} />;

    case 'settings/remote':
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
                  Pure runner control plane: queue tasks into SQLite and execute isolated
                  continuation branches across registered Docker or host CLI runners.
                </p>
              </div>

              <div class="flex flex-wrap items-center gap-2.5">
                {isOrchestratorEnabled && (
                  <button
                    type="button"
                    onClick={() => setShowRegisterPanel(!showRegisterPanel)}
                    class="flex cursor-pointer items-center gap-1.5 rounded-lg border border-pine-iris/40 bg-pine-iris/15 px-3.5 py-2 text-xs font-semibold whitespace-nowrap text-pine-iris transition-colors hover:bg-pine-iris hover:text-pine-base sm:text-sm"
                  >
                    <Icon icon={faPlus} class="size-3" />
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
              <div class="mt-5 border-t border-pine-highlight pt-4">
                <div class="mb-2.5 flex items-center justify-between">
                  <h4 class="text-xs font-semibold tracking-wider text-pine-subtle uppercase">
                    Registered Swarm Runners ({workers.length})
                  </h4>
                </div>

                <SwarmRunnersGrid
                  workers={workers}
                  onToggleEnabled={handleToggleWorkerEnabled}
                  onRevoke={handleRevokeWorker}
                />
              </div>
            )}
          </div>

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

    case 'settings/repositories':
      if (!isOrchestratorEnabled) {
        return (
          <div class="rounded-xl border border-pine-highlight bg-pine-surface p-6 shadow-sm">
            <div class="flex flex-wrap items-center justify-between gap-4">
              <div>
                <div class="mb-1 flex items-center gap-2">
                  <Icon icon={faCodeBranch} class="size-5 text-pine-subtle" />
                  <h3 class="text-lg font-semibold text-pine-text">Repositories</h3>
                  <span class="rounded-full border border-pine-highlight bg-pine-overlay px-2.5 py-0.5 text-xs font-bold tracking-wider whitespace-nowrap text-pine-subtle uppercase">
                    Orchestrator Off
                  </span>
                </div>
                <p class="text-xs text-pine-subtle">
                  Enable the Task Orchestrator first to register and manage local git repositories
                  for swarm runners.
                </p>
              </div>
              <button
                type="button"
                disabled={isTogglingOrchestrator}
                onClick={handleToggleOrchestrator}
                class="cursor-pointer rounded-lg bg-pine-iris px-4 py-2 text-xs font-semibold whitespace-nowrap text-pine-base transition-opacity hover:opacity-90 disabled:opacity-50 sm:text-sm"
              >
                {isTogglingOrchestrator ? 'Enabling...' : 'Enable Orchestrator'}
              </button>
            </div>
          </div>
        );
      }
      return <RepoEditor config={config} onSaved={onChanged} />;

    case 'settings/advanced':
      return (
        <div class="flex flex-col gap-6">
          <SettingsForm
            title="Sentry &amp; Quota Safeguards"
            description="Fine-tune quota polling frequency, milestone warnings, Language Server Connect-RPC, and overcharge safety floor."
            fields={SENTRY_FIELDS}
            config={config}
            onSaved={onChanged}
          />

          <div class="rounded-xl border border-pine-highlight bg-pine-surface shadow-sm">
            <button
              type="button"
              onClick={() => setShowRawTable(!showRawTable)}
              class="group flex w-full cursor-pointer items-center justify-between p-4 text-left transition-colors"
            >
              <div>
                <h3 class="text-sm font-semibold text-pine-text">Configuration Overrides</h3>
                <p class="mt-0.5 text-xs text-pine-subtle">
                  Inspect and edit low-level key-value settings
                </p>
              </div>
              <span class="flex items-center gap-1.5 text-xs text-pine-subtle transition-colors group-hover:text-pine-text">
                <span>{showRawTable ? 'Hide' : 'View all keys'}</span>
                <Icon icon={showRawTable ? faChevronUp : faChevronDown} class="size-2.5" />
              </span>
            </button>

            {showRawTable && (
              <div class="border-t border-pine-highlight p-4">
                <ConfigTable config={config} onUpdated={onChanged} />
              </div>
            )}
          </div>
        </div>
      );

    default:
      return null;
  }
};
