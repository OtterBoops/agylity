import { useState, useEffect, useCallback } from 'preact/hooks';
import { faArrowRight, faMinus, faNetworkWired, faPlus } from '@fortawesome/free-solid-svg-icons';
import { Link } from 'preact-router/match';
import type { ConfigData, SwarmRunnerRecord } from '../../types';
import { getRunners, revokeRunner, setRunnerEnabled } from '../../api';
import { Icon } from '../../components/Icon';
import { RunnerRegistrationPanel } from '../../components/RunnerRegistrationPanel';
import { SwarmRunnersGrid } from '../../components/SwarmRunnersGrid';
import { PoolGroupPoliciesCard } from '../../components/PoolGroupPoliciesCard';
import { RepositoriesView } from './RepositoriesView';
import { SettingsForm } from '../../components/SettingsForm';
import { SettingsLayout } from '../../components/SettingsLayout';
import { COORDINATOR_FIELDS } from '../../config/fields';
import { toModelOptions, useModelCatalog } from '../../state/modelCatalogStore';
import { pushErrorToast } from '../../state/toastStore';

interface CoordinatorViewProps {
  config: ConfigData;
  onChanged: () => void;
  searchQuery?: string;
}

export const CoordinatorView = ({ config, onChanged, searchQuery }: CoordinatorViewProps) => {
  const [runners, setRunners] = useState<SwarmRunnerRecord[]>([]);
  // Optimistic until the first poll answers: a transient failure must not accuse the config.
  const [credentialsAvailable, setCredentialsAvailable] = useState(true);
  const [showRegisterPanel, setShowRegisterPanel] = useState(false);
  const catalog = useModelCatalog();

  const isCoordinatorEnabled = Boolean(config.resolved?.coordinatorEnabled);

  const refreshRunners = useCallback(() => {
    getRunners().then((next) => {
      setRunners(next.runners);
      setCredentialsAvailable(next.credentialsAvailable);
    });
  }, []);

  useEffect(() => {
    if (!isCoordinatorEnabled) return;
    refreshRunners();
    // A hidden tab has nothing to look at; it refreshes once when it comes back instead.
    const timer = setInterval(() => {
      if (document.hidden) return;
      refreshRunners();
    }, 8000);
    const onVisibilityChange = () => {
      if (!document.hidden) refreshRunners();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [isCoordinatorEnabled, refreshRunners]);

  // A refused write must say so: the grid would otherwise keep showing the old state as success.
  const handleToggleRunnerEnabled = async (runner: SwarmRunnerRecord) => {
    try {
      await setRunnerEnabled(runner.runnerId, !runner.enabled);
    } catch (err) {
      pushErrorToast(
        runner.enabled ? 'Could not disable runner' : 'Could not enable runner',
        err instanceof Error ? err.message : 'The control plane refused the request.'
      );
      return;
    }
    refreshRunners();
  };

  const handleRevokeRunner = async (runner: SwarmRunnerRecord) => {
    try {
      await revokeRunner(runner.runnerId);
    } catch (err) {
      pushErrorToast(
        'Could not revoke runner',
        err instanceof Error ? err.message : 'The control plane refused the request.'
      );
      return;
    }
    refreshRunners();
  };

  const coordinatorOrigin =
    typeof window !== 'undefined' && window.location?.origin
      ? window.location.origin
      : 'http://agylity:8484';

  if (!isCoordinatorEnabled) {
    return (
      <SettingsLayout>
        <div class="rounded-xl border border-pine-highlight bg-pine-surface p-6">
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
      <div class="rounded-xl border border-pine-highlight bg-pine-surface p-6">
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
          credentialsAvailable={credentialsAvailable}
          onToggleEnabled={handleToggleRunnerEnabled}
          onRevoke={handleRevokeRunner}
        />
      </div>

      <PoolGroupPoliciesCard config={config} onSaved={onChanged} />

      <SettingsForm
        title="Model Selection &amp; Dispatch Thresholds"
        description="Configure the default dispatch model, routine automation and its pre-reset triggers, the GitHub backlog label, and the dispatch safety floor that blocks overage."
        fields={COORDINATOR_FIELDS}
        config={config}
        onSaved={onChanged}
        modelOptions={toModelOptions(catalog.models)}
        searchQuery={searchQuery}
      />

      <RepositoriesView config={config} onChanged={onChanged} />
    </SettingsLayout>
  );
};
