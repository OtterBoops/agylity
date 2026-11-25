export const OWNER_REPO_SLUG_RE = /^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/;

const GITHUB_HOST_RE =
  /^(?:[a-z][a-z0-9+.-]*:\/\/(?:[^@/\s]+@)?(?:www\.)?github\.com(?::\d+)?(?:[/?#]|$)|[^@/\s]+@(?:www\.)?github\.com:)/i;

const GITHUB_URL_SLUG_RE =
  /^(?:[a-z][a-z0-9+.-]*:\/\/(?:[^@/\s]+@)?(?:www\.)?github\.com(?::\d+)?\/|[^@/\s]+@(?:www\.)?github\.com:)([^/\s]+)\/([^/#?\s]+?)(?:\.git)?\/*$/i;

export const isGithubRemoteUrl = (value: string | undefined): boolean =>
  Boolean(value && GITHUB_HOST_RE.test(value.trim()));

export const parseGithubSlugFromUrl = (value: string | undefined): string | undefined => {
  if (!value) return undefined;
  const match = GITHUB_URL_SLUG_RE.exec(value.trim());
  return match ? `${match[1]}/${match[2]}` : undefined;
};
