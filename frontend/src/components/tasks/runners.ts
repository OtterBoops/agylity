import type { SwarmRunnerRecord } from '../../types';

/** A runner covers a repo when it is enabled, not offline, and either unpinned or pinned to it. */
export const runnerCoversRepo = (runners: SwarmRunnerRecord[], repositoryId?: string): boolean =>
  runners.some(
    (runner) =>
      runner.enabled &&
      runner.status !== 'offline' &&
      (runner.repositories.length === 0 ||
        (repositoryId !== undefined && runner.repositories.includes(repositoryId)))
  );
