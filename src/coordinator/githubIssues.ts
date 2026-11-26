import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import ky from 'ky';

const execFileAsync = promisify(execFile);

export interface RemoveIssueLabelParams {
  repoSlug: string;
  issueNumber: number;
  label: string;
  token?: string;
  execFileFn?: typeof execFileAsync;
}

export type RemoveIssueLabelResult = 'rest' | 'cli' | 'failed';

export const removeIssueLabel = async (
  params: RemoveIssueLabelParams
): Promise<RemoveIssueLabelResult> => {
  const { repoSlug, issueNumber, label } = params;
  const token = params.token?.trim();
  const run = params.execFileFn ?? execFileAsync;

  if (token) {
    try {
      const response = await ky.delete(
        `https://api.github.com/repos/${repoSlug}/issues/${issueNumber}/labels/${encodeURIComponent(label)}`,
        {
          headers: {
            authorization: `Bearer ${token}`,
            accept: 'application/vnd.github+json',
            'user-agent': 'agylity',
          },
          throwHttpErrors: false,
          timeout: 10000,
          retry: 0,
        }
      );
      if (response.ok || response.status === 404) return 'rest';
    } catch {
      // A dead REST call is not a reason to give up.
    }
  }

  try {
    await run(
      'gh',
      ['issue', 'edit', String(issueNumber), '--repo', repoSlug, '--remove-label', label],
      {
        timeout: 20000,
        env: { ...process.env, ...(token ? { GITHUB_TOKEN: token } : {}) },
      }
    );
    return 'cli';
  } catch {
    return 'failed';
  }
};
