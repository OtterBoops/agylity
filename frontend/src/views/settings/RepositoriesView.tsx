import { faArrowRight, faCodeBranch } from '@fortawesome/free-solid-svg-icons';
import { Link } from 'preact-router/match';
import type { ConfigData } from '../../types';
import { Icon } from '../../components/Icon';
import { RepoEditor } from '../../components/RepoEditor';
import { SettingsLayout } from '../../components/SettingsLayout';

interface RepositoriesViewProps {
  config: ConfigData;
  onChanged: () => void;
}

export const RepositoriesView = ({ config, onChanged }: RepositoriesViewProps) => {
  const isCoordinatorEnabled = Boolean(config.resolved?.coordinatorEnabled);

  return (
    <SettingsLayout>
      {!isCoordinatorEnabled ? (
        <div class="rounded-xl border border-pine-highlight bg-pine-surface p-6 shadow-sm">
          <div class="mb-1 flex flex-wrap items-center gap-2">
            <Icon icon={faCodeBranch} class="size-5 text-pine-subtle" />
            <h2 class="text-lg font-semibold text-pine-text">Repositories</h2>
            <span class="rounded-full border border-pine-highlight bg-pine-overlay px-2.5 py-0.5 text-xs font-bold tracking-wider whitespace-nowrap text-pine-subtle uppercase">
              Coordinator Off
            </span>
          </div>
          <p class="mt-1 text-sm text-pine-subtle">
            Enable the Task Coordinator first to register and manage local git repositories for
            swarm runners.
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
            to manage repositories.
          </p>
        </div>
      ) : (
        <RepoEditor config={config} onSaved={onChanged} />
      )}
    </SettingsLayout>
  );
};
