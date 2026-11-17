import type { SwarmRunnerRecord } from '../../types';

export const runnerCoversRepo = (runners: SwarmRunnerRecord[], repositoryId?: string): boolean =>
  runners.some(
    (runner) =>
      runner.enabled &&
      runner.status !== 'offline' &&
      (runner.repositories.length === 0 ||
        (repositoryId !== undefined && runner.repositories.includes(repositoryId)))
  );
