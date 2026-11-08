import { useState, useEffect, useCallback } from 'preact/hooks';
import {
  faArrowRight,
  faMinus,
  faNetworkWired,
  faPlus,
  faRotate,
} from '@fortawesome/free-solid-svg-icons';
import type { ConfigData, SwarmRunnerRecord } from '../../types';
import { getRunners, revokeRunner, setRunnerEnabled, updateConfig } from '../../api';
import { Icon } from '../../components/Icon';
import { RunnerRegistrationPanel } from '../../components/RunnerRegistrationPanel';
import { SwarmRunnersGrid } from '../../components/SwarmRunnersGrid';
import { PoolPoliciesCard } from '../../components/PoolPoliciesCard';
import { SettingsForm } from '../../components/SettingsForm';
import { SettingsLayout } from '../../components/SettingsLayout';
import { COORDINATOR_FIELDS } from '../../config/fields';

interface CoordinatorViewProps {
  config: ConfigData;
  onChanged: () => void;
}

export const CoordinatorView = ({ config, onChanged }: CoordinatorViewProps) => {
  const [isTogglingCoordinator, setIsTogglingCoordinator] = useState(false);
  const [runners, setRunners] = useState<SwarmRunnerRecord[]>([]);
  const [showRegisterPanel, setShowRegisterPanel] = useState(false);

  const isCoordinatorEnabled = Boolean(config.resolved?.coordinatorEnabled);

  const refreshRunners = useCallback(() => {
    getRunners().then((list) => setRunners(list));
  }, []);

  useEffect(() => {
    if (!isCoordinatorEnabled) return;
    refreshRunners();
    const timer = setInterval(refreshRunners, 8000);
    return () => clearInterval(timer);
  }, [isCoordinatorEnabled, refreshRunners]);

  const handleToggleCoordinator = async () => {
    setIsTogglingCoordinator(true);
    try {
      await updateConfig({ coordinatorEnabled: !isCoordinatorEnabled });
      onChanged();
    } finally {
      setIsTogglingCoordinator(false);
    }
  };

  const handleToggleRunnerEnabled = async (runner: SwarmRunnerRecord) => {
    await setRunnerEnabled(runner.runnerId, !runner.enabled);
    refreshRunners();
  };

  const handleRevokeRunner = async (runner: SwarmRunnerRecord) => {
    await revokeRunner(runner.runnerId);
    refreshRunners();
  };

  const coordinatorOrigin =
    typeof window !== 'undefined' && window.location?.origin
      ? window.location.origin
      : 'http://agylity:8484';

  return (
    <SettingsLayout activeTab="coordinator" coordinatorEnabled={isCoordinatorEnabled}>
      <div class="rounded-xl border border-pine-highlight bg-pine-surface p-6 shadow-sm">
        <div class="flex flex-wrap items-center justify-between gap-4">
          <div>
            <div class="mb-1 flex flex-wrap items-center gap-2">
              <Icon icon={faNetworkWired} class="size-5 text-pine-iris" />
              <h2 class="text-lg font-semibold text-pine-text">
                Task Coordinator &amp; Swarm Runners
              </h2>
              <span
                class={`rounded-full border px-2.5 py-0.5 text-xs font-bold tracking-wider whitespace-nowrap uppercase ${
                  isCoordinatorEnabled
                    ? 'border-pine-pine bg-pine-pine/20 text-pine-foam'
                    : 'border-pine-highlight bg-pine-overlay text-pine-subtle'
                }`}
              >
                {isCoordinatorEnabled ? 'Enabled' : 'Disabled'}
              </span>
            </div>
            <p class="text-xs text-pine-subtle">
              Pure runner control plane: queue tasks into SQLite and execute isolated continuation
              branches across registered Docker or host CLI runners.
            </p>
          </div>

          <div class="flex flex-wrap items-center gap-2.5">
            {isCoordinatorEnabled && (
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
              disabled={isTogglingCoordinator}
              onClick={handleToggleCoordinator}
              class={`cursor-pointer rounded-lg px-4 py-2 text-xs font-semibold whitespace-nowrap transition-colors sm:text-sm ${
                isCoordinatorEnabled
                  ? 'border border-pine-love/40 bg-pine-love/15 text-pine-love hover:bg-pine-love hover:text-pine-base'
                  : 'bg-pine-iris text-pine-base hover:opacity-90'
              }`}
            >
              {isTogglingCoordinator
                ? 'Updating...'
                : isCoordinatorEnabled
                  ? 'Disable Coordinator'
                  : 'Enable Coordinator'}
            </button>
          </div>
        </div>

        {isCoordinatorEnabled && showRegisterPanel && (
          <div class="mt-5">
            <RunnerRegistrationPanel coordinatorOrigin={coordinatorOrigin} />
          </div>
        )}

        {isCoordinatorEnabled && (
          <SwarmRunnersGrid
            runners={runners}
            onToggleEnabled={handleToggleRunnerEnabled}
            onRevoke={handleRevokeRunner}
          />
        )}
      </div>

      {isCoordinatorEnabled && <PoolPoliciesCard config={config} onSaved={onChanged} />}

      {isCoordinatorEnabled && (
        <div class="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-pine-highlight/60 bg-pine-overlay/30 p-4">
          <div class="flex items-center gap-3">
            <div class="flex size-8 shrink-0 items-center justify-center rounded-lg bg-pine-overlay text-pine-iris">
              <Icon icon={faRotate} class="size-4" />
            </div>
            <div>
              <div class="text-xs font-semibold text-pine-text">Tier 3: Maintenance Routines</div>
              <p class="text-[12.1px] text-pine-subtle">
                Routines automatically execute prompt templates before quota pool resets. Managed
                under the Tasks tab.
              </p>
            </div>
          </div>
          <a
            href="/tasks?tab=routines"
            class="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-pine-highlight bg-pine-overlay px-3 py-1.5 text-xs font-semibold text-pine-text transition-colors hover:border-pine-iris hover:text-pine-iris"
          >
            <span>View Routines</span>
            <Icon icon={faArrowRight} class="size-3" />
          </a>
        </div>
      )}

      {isCoordinatorEnabled && (
        <SettingsForm
          title="Model Selection &amp; Swarm Queue Parameters"
          description="Configure the explicit default dispatch model, fallback runner secret, and routine pre-reset trigger thresholds."
          fields={COORDINATOR_FIELDS}
          config={config}
          onSaved={onChanged}
        />
      )}
    </SettingsLayout>
  );
};
