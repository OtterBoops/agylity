import { useState } from 'preact/hooks';
import { faCodeBranch } from '@fortawesome/free-solid-svg-icons';
import type { ConfigData } from '../../types';
import { updateConfig } from '../../api';
import { Icon } from '../../components/Icon';
import { RepoEditor } from '../../components/RepoEditor';
import { SettingsLayout } from '../../components/SettingsLayout';

interface RepositoriesViewProps {
  config: ConfigData;
  onChanged: () => void;
}

export const RepositoriesView = ({ config, onChanged }: RepositoriesViewProps) => {
  const [isTogglingCoordinator, setIsTogglingCoordinator] = useState(false);
  const isCoordinatorEnabled = Boolean(config.resolved?.coordinatorEnabled);

  const handleToggleCoordinator = async () => {
    setIsTogglingCoordinator(true);
    try {
      await updateConfig({ coordinatorEnabled: true });
      onChanged();
    } finally {
      setIsTogglingCoordinator(false);
    }
  };

  return (
    <SettingsLayout>
      {!isCoordinatorEnabled ? (
        <div class="rounded-xl border border-pine-highlight bg-pine-surface p-6 shadow-sm">
          <div class="flex flex-wrap items-center justify-between gap-4">
            <div>
              <div class="mb-1 flex items-center gap-2">
                <Icon icon={faCodeBranch} class="size-5 text-pine-subtle" />
                <h2 class="text-lg font-semibold text-pine-text">Repositories</h2>
                <span class="rounded-full border border-pine-highlight bg-pine-overlay px-2.5 py-0.5 text-xs font-bold tracking-wider whitespace-nowrap text-pine-subtle uppercase">
                  Coordinator Off
                </span>
              </div>
              <p class="text-xs text-pine-subtle">
                Enable the Task Coordinator first to register and manage local git repositories for
                swarm runners.
              </p>
            </div>
            <button
              type="button"
              disabled={isTogglingCoordinator}
              onClick={handleToggleCoordinator}
              class="cursor-pointer rounded-lg bg-pine-iris px-4 py-2 text-xs font-semibold whitespace-nowrap text-pine-base transition-opacity hover:opacity-90 disabled:opacity-50 sm:text-sm"
            >
              {isTogglingCoordinator ? 'Enabling...' : 'Enable Coordinator'}
            </button>
          </div>
        </div>
      ) : (
        <RepoEditor config={config} onSaved={onChanged} />
      )}
    </SettingsLayout>
  );
};
