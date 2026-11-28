import ky from 'ky';
import type { WebServerOptions } from './types.js';
import { defaultExecFileAsync } from '../sentry/discovery.js';

export const describeError = (err: unknown): string => {
  if (err instanceof Error && err.message) return err.message;
  return String(err);
};

export interface GithubIssue {
  number: number;
  title: string;
  body?: string;
  html_url?: string;
  url?: string;
}

export interface GithubIssueListing {
  issues: GithubIssue[];
  truncated: boolean;
}

const GITHUB_ISSUE_PAGES = 5;
const GITHUB_ISSUE_PAGE_SIZE = 100;
const GH_CLI_ISSUE_LIMIT = 500;

export type GithubIssueFetchResult =
  ({ ok: true } & GithubIssueListing) | { ok: false; reason: string };

export const fetchGithubRestIssues = async (
  repoSlug: string,
  label: string,
  ghToken: string
): Promise<GithubIssueListing> => {
  const issues: GithubIssue[] = [];
  let truncated = false;

  for (let page = 1; page <= GITHUB_ISSUE_PAGES; page++) {
    const batch = await ky
      .get(`https://api.github.com/repos/${repoSlug}/issues`, {
        headers: {
          Authorization: `Bearer ${ghToken}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'Agylity-Backlog-Sync',
        },
        searchParams: {
          labels: label,
          state: 'open',
          per_page: GITHUB_ISSUE_PAGE_SIZE,
          page,
        },
        timeout: 15000,
      })
      .json<GithubIssue[]>();

    // The issues endpoint also returns pull requests.
    issues.push(...batch.filter((item: any) => !item.pull_request));
    if (batch.length < GITHUB_ISSUE_PAGE_SIZE) break;
    if (page === GITHUB_ISSUE_PAGES) truncated = true;
  }
  return { issues, truncated };
};

const fetchGhCliIssues = async (
  repoSlug: string,
  label: string,
  execFileAsync: typeof defaultExecFileAsync = defaultExecFileAsync,
  ghToken?: string
): Promise<GithubIssueListing> => {
  const { stdout } = await execFileAsync(
    'gh',
    [
      'issue',
      'list',
      '--repo',
      repoSlug,
      '--label',
      label,
      '--state',
      'open',
      '--limit',
      String(GH_CLI_ISSUE_LIMIT),
      '--json',
      'number,title,body,url',
    ],
    { timeout: 20000, env: { ...process.env, GITHUB_TOKEN: ghToken ?? '' } }
  );
  const issues: GithubIssue[] = stdout && stdout.trim() ? JSON.parse(stdout) : [];
  return { issues, truncated: issues.length >= GH_CLI_ISSUE_LIMIT };
};

export const listOpenIssues = async (
  repoSlug: string,
  label: string,
  ghToken: string | undefined,
  logger?: WebServerOptions['logger'],
  execFileAsync: typeof defaultExecFileAsync = defaultExecFileAsync
): Promise<GithubIssueFetchResult> => {
  let restError: string | undefined;

  if (ghToken) {
    try {
      return { ok: true, ...(await fetchGithubRestIssues(repoSlug, label, ghToken)) };
    } catch (err) {
      restError = describeError(err);
      logger?.warn?.(
        'GitHub REST backlog sync failed for %s, falling back to gh CLI: %s',
        repoSlug,
        restError
      );
    }

    try {
      return { ok: true, ...(await fetchGhCliIssues(repoSlug, label, execFileAsync, ghToken)) };
    } catch (err) {
      const reason = `GitHub REST API failed (${restError}) and the gh CLI failed (${describeError(err)})`;
      logger?.warn?.('GitHub backlog sync failed for %s: %s', repoSlug, reason);
      return { ok: false, reason };
    }
  }

  try {
    return { ok: true, ...(await fetchGhCliIssues(repoSlug, label, execFileAsync, ghToken)) };
  } catch (err) {
    const reason = `no GitHub token is configured on the coordinator and the gh CLI is unavailable (${describeError(err)})`;
    logger?.warn?.('GitHub backlog sync failed for %s: %s', repoSlug, reason);
    return { ok: false, reason };
  }
};
