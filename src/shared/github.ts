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

type ExecFileLike = (
  file: string,
  args: readonly string[],
  options?: Record<string, unknown>
) => Promise<{ stdout: string }>;

export interface RepoSlugCandidate {
  cloneUrl?: string;
  id?: string;
  name?: string;
  path?: string;
}

/**
 * The one resolution of a repository's GitHub `owner/repo` slug: clone URL, then id, then name, then
 * the origin remote of a local checkout. `execFile` is injected because this file stays import-free.
 */
export const resolveGithubRepoSlug = async (
  candidate: RepoSlugCandidate,
  execFile: ExecFileLike
): Promise<string | undefined> => {
  const fromCloneUrl = parseGithubSlugFromUrl(candidate.cloneUrl);
  if (fromCloneUrl) return fromCloneUrl;
  const id = candidate.id?.trim();
  if (id && OWNER_REPO_SLUG_RE.test(id)) return id;
  const name = candidate.name?.trim();
  if (name && OWNER_REPO_SLUG_RE.test(name)) return name;
  if (!candidate.path) return undefined;
  try {
    const { stdout } = await execFile(
      'git',
      ['-C', candidate.path, 'remote', 'get-url', 'origin'],
      { timeout: 5000 }
    );
    return parseGithubSlugFromUrl(stdout);
  } catch {
    return undefined;
  }
};

/** Hosts a GitHub web page (issue, PR) is served from. */
export const GITHUB_WEB_HOSTS: ReadonlySet<string> = new Set(['github.com', 'www.github.com']);
