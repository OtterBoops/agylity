export const OWNER_REPO_SLUG_RE = /^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/;

const GITHUB_URL_SLUG_RE = /github\.com[/:]([^/\s]+)\/([^/#?\s]+?)(?:\.git)?\/?$/i;

export const parseGithubSlugFromUrl = (value: string | undefined): string | undefined => {
  if (!value) return undefined;
  const match = GITHUB_URL_SLUG_RE.exec(value.trim());
  return match ? `${match[1]}/${match[2]}` : undefined;
};
