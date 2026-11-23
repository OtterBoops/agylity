// Zero imports and erasable syntax only: the frontend bundles this file directly, and both sides
// must agree on how a build channel is validated and labelled.

export type BuildChannel = 'release' | 'main' | 'dev';

export const BUILD_CHANNELS: readonly BuildChannel[] = ['release', 'main', 'dev'];

export const DEFAULT_BUILD_CHANNEL: BuildChannel = 'dev';

// Anything unrecognised fails open to `dev`: a stale or misspelled build arg must never be
// mistaken for a release build and hide the update indicator.
export const resolveBuildChannel = (raw?: string | null): BuildChannel => {
  const value = (raw ?? '').trim().toLowerCase();
  return (BUILD_CHANNELS as readonly string[]).includes(value)
    ? (value as BuildChannel)
    : DEFAULT_BUILD_CHANNEL;
};

const COMMIT_PATTERN = /^[0-9a-f]{7,40}$/;

export const normalizeBuildCommit = (raw?: string | null): string | null => {
  const value = (raw ?? '').trim().toLowerCase();
  return COMMIT_PATTERN.test(value) ? value.slice(0, 7) : null;
};

export const formatBuildLabel = (
  channel: BuildChannel,
  version: string,
  commit: string | null
): string => (channel === 'main' && commit ? `main · ${commit}` : `v${version}`);

// Main moves per commit, so there is no ordering to compare — a different short SHA is the signal.
export const isNewerMainCommit = (current?: string | null, latest?: string | null): boolean => {
  const currentSha = normalizeBuildCommit(current);
  const latestSha = normalizeBuildCommit(latest);
  return currentSha !== null && latestSha !== null && currentSha !== latestSha;
};
