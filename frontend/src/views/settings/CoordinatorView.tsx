import { useState, useEffect, useCallback } from 'preact/hooks';
import { faArrowRight, faMinus, faNetworkWired, faPlus } from '@fortawesome/free-solid-svg-icons';
import { Link } from 'preact-router/match';
import type { ConfigData, SwarmRunnerRecord } from '../../types';
import { getRunners, revokeRunner, setRunnerEnabled } from '../../api';
import { Icon } from '../../components/Icon';
import { RunnerRegistrationPanel } from '../../components/RunnerRegistrationPanel';
import { SwarmRunnersGrid } from '../../components/SwarmRunnersGrid';
import { PoolPoliciesCard } from '../../components/PoolPoliciesCard';
import { SettingsForm } from '../../components/SettingsForm';
import { SettingsLayout } from '../../components/SettingsLayout';
import { COORDINATOR_FIELDS } from '../../config/fields';
import { toModelOptions, useModelCatalog } from '../../state/modelCatalogStore';

interface CoordinatorViewProps {
  config: ConfigData;
  onChanged: () => void;
}

export const CoordinatorView = ({ config, onChanged }: CoordinatorViewProps) => {
  const [runners, setRunners] = useState<SwarmRunnerRecord[]>([]);
  const [showRegisterPanel, setShowRegisterPanel] = useState(false);
  const catalog = useModelCatalog();

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

  if (!isCoordinatorEnabled) {
    return (
      <SettingsLayout>
        <div class="rounded-xl border border-pine-highlight bg-pine-surface p-6 shadow-sm">
          <div class="mb-1 flex flex-wrap items-center gap-2">
            <Icon icon={faNetworkWired} class="size-5 text-pine-subtle" />
            <h2 class="text-lg font-semibold text-pine-text">Task Coordinator</h2>
            <span class="rounded-full border border-pine-highlight bg-pine-overlay px-2.5 py-0.5 text-xs font-bold tracking-wider whitespace-nowrap text-pine-subtle uppercase">
              Disabled
            </span>
          </div>
          <p class="mt-1 text-sm text-pine-subtle">
            The Task Coordinator is currently disabled. Agylity is operating in pure Quota Sentry
            mode: it monitors both quota windows and fires milestone alerts, but does not dispatch
            autonomous tasks or accept swarm pull runners.
          </p>
          <p class="mt-2 text-sm text-pine-subtle">
            Enable it from{' '}
            <Link
              href="/settings/general"
              class="inline-flex items-center gap-1 font-semibold text-pine-iris transition-colors hover:text-pine-foam"
            >
              <span>General Settings</span>
              <Icon icon={faArrowRight} class="size-3" />
            </Link>{' '}
            to queue tasks and register runners.
          </p>
        </div>
      </SettingsLayout>
    );
  }

  return (
    <SettingsLayout>
      <div class="rounded-xl border border-pine-highlight bg-pine-surface p-6 shadow-sm">
        <div class="flex flex-wrap items-center justify-between gap-4">
          <div>
            <div class="mb-1 flex flex-wrap items-center gap-2">
              <Icon icon={faNetworkWired} class="size-5 text-pine-iris" />
              <h2 class="text-lg font-semibold text-pine-text">
                Task Coordinator &amp; Swarm Runners
              </h2>
              <span class="rounded-full border border-pine-pine bg-pine-pine/20 px-2.5 py-0.5 text-xs font-bold tracking-wider whitespace-nowrap text-pine-foam uppercase">
                Enabled
              </span>
            </div>
            <p class="text-xs text-pine-subtle">
              Pure runner control plane: queue tasks into SQLite and execute isolated continuation
              branches across registered Docker or host CLI runners.
            </p>
          </div>

          <div class="flex flex-wrap items-center gap-2.5">
            <button
              type="button"
              onClick={() => setShowRegisterPanel(!showRegisterPanel)}
              class="flex cursor-pointer items-center gap-1.5 rounded-lg border border-pine-iris/40 bg-pine-iris/15 px-3.5 py-2 text-xs font-semibold whitespace-nowrap text-pine-iris transition-colors hover:bg-pine-iris hover:text-pine-base sm:text-sm"
            >
              <Icon icon={showRegisterPanel ? faMinus : faPlus} class="size-3" />
              <span>{showRegisterPanel ? 'Hide Form' : 'New Runner'}</span>
            </button>
          </div>
        </div>

        {showRegisterPanel && (
          <div class="mt-5">
            <RunnerRegistrationPanel coordinatorOrigin={coordinatorOrigin} />
          </div>
        )}

        <SwarmRunnersGrid
          runners={runners}
          onToggleEnabled={handleToggleRunnerEnabled}
          onRevoke={handleRevokeRunner}
        />
      </div>

      <PoolPoliciesCard config={config} onSaved={onChanged} />

      <SettingsForm
        title="Model Selection &amp; Swarm Queue Parameters"
        description="Configure the explicit default dispatch model, fallback runner secret, and routine pre-reset trigger thresholds."
        fields={COORDINATOR_FIELDS}
        config={config}
        onSaved={onChanged}
        modelOptions={toModelOptions(catalog.models)}
      />
    </SettingsLayout>
  );
};
