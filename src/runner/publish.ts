import { modelSupportsEffort } from '../shared/models.js';
import type { CascadeHop, TaskTier } from '../shared/contracts.js';
import type { PrPolicy } from '../shared/contracts.js';
import type { Logger } from '../logs/logger.js';
import type { ExecFileAsyncFn } from '../sentry/discovery.js';
import { buildGitAuthArgs, redactGitSecrets } from './git.js';
import { isDocumentationFile } from './policy.js';
import { AGYLITY_FOOTER_TAIL_RE, agylityFooter, buildPullRequestBody } from './prompt.js';

export interface PublishDeps {
  execFile: ExecFileAsyncFn;
  log: Logger;
}

export const discardBranch = async (
  cwd: string,
  baseBranch: string,
  branchName: string,
  deps: PublishDeps
): Promise<void> => {
  try {
    await deps.execFile('git', ['checkout', baseBranch], { cwd, timeout: 15000 });
    await deps.execFile('git', ['branch', '-D', branchName], { cwd, timeout: 15000 });
  } catch {}
};

export const pushTaskBranch = async (
  input: {
    repositoryPath: string;
    cloneUrl?: string;
    branchName: string;
    githubToken?: string;
  },
  deps: PublishDeps
): Promise<string | null> => {
  try {
    await deps.execFile(
      'git',
      [
        ...buildGitAuthArgs(input.cloneUrl, input.githubToken),
        'push',
        '-u',
        'origin',
        input.branchName,
      ],
      { cwd: input.repositoryPath, timeout: 60000 }
    );
    deps.log.info('Pushed %s to origin', input.branchName);
    return null;
  } catch (gitPushErr: any) {
    const pushErrMsg = redactGitSecrets(gitPushErr?.message ?? String(gitPushErr), [
      input.githubToken,
    ]);
    deps.log.error('Git push failed on %s: %s', input.branchName, pushErrMsg);
    return input.githubToken
      ? `Git push to origin/${input.branchName} failed: ${pushErrMsg}`
      : `Git push to origin/${input.branchName} failed: ${pushErrMsg} (the coordinator leased no GitHub token for this task)`;
  }
};

export const openPullRequest = async (
  input: {
    repositoryPath: string;
    branchName: string;
    baseBranch: string;
    hop: CascadeHop;
    githubToken?: string;
    title: string;
    capturedOutput: string;
    tier: TaskTier;
    issueNumber?: number;
    prompt: string;
  },
  deps: PublishDeps
): Promise<string | undefined> => {
  try {
    // A failover hop is the model that actually wrote the branch, so the footer names that one.
    const effortNote = modelSupportsEffort(input.hop.model)
      ? ` (${input.hop.effort} reasoning)`
      : '';
    // First, so the footer check still sees the prompt's own tail.
    const closes = input.issueNumber ? `Closes #${input.issueNumber}\n\n` : '';
    const rawBody = `${closes}${buildPullRequestBody(
      { tier: input.tier, prompt: input.prompt },
      input.title,
      input.capturedOutput
    )}`;
    // Avoid stacking a second Agylity footer when the source prompt/output already ends with one.
    const prBody = AGYLITY_FOOTER_TAIL_RE.test(rawBody)
      ? rawBody
      : [rawBody, '', '---', agylityFooter(input.tier, input.hop.model, effortNote)].join('\n');

    const { stdout: prOut } = await deps.execFile(
      'gh',
      [
        'pr',
        'create',
        '--base',
        input.baseBranch,
        '--head',
        input.branchName,
        '--title',
        input.title,
        '--body',
        prBody,
      ],
      {
        cwd: input.repositoryPath,
        timeout: 30000,
        env: { ...process.env, GITHUB_TOKEN: input.githubToken ?? '' },
      }
    );
    const match = prOut.match(/https:\/\/github\.com\/[^\s]+/);
    if (!match) return undefined;
    deps.log.info('Created pull request for %s: %s', input.branchName, match[0]);
    return match[0].trim();
  } catch (prErr: any) {
    deps.log.warn(
      'Auto PR creation failed for %s: %s',
      input.branchName,
      redactGitSecrets(prErr?.message ?? String(prErr), [input.githubToken])
    );
    return undefined;
  }
};

/**
 * Applies the PR policy to a finished branch: returns the suppression detail when the policy keeps
 * the branch off the remote, or null when it may be pushed. Every tier is policed — a human dispatch
 * is a request for this work, not permission to bypass the configured policy.
 */
export const applyPrPolicy = async (
  input: {
    repositoryPath: string;
    branchName: string;
    baseBranch: string;
    prPolicy: PrPolicy;
    githubToken?: string;
    taskId: string;
  },
  deps: PublishDeps
): Promise<{ detail: string } | null> => {
  const suppress = async (detail: string): Promise<{ detail: string }> => {
    await discardBranch(input.repositoryPath, input.baseBranch, input.branchName, deps);
    return { detail };
  };

  if (input.prPolicy === 'none' || input.prPolicy === 'issues_only') {
    const detail =
      input.prPolicy === 'issues_only'
        ? "[Policy Guard] Autonomous PR suppressed: PR policy is 'issues_only' (no code changes or PRs allowed; report findings as GitHub Issues)."
        : "[Policy Guard] Autonomous PR suppressed: PR policy is 'none'.";
    deps.log.info(
      'Autonomous PR policy is "%s": suppressing branch push and PR creation for task %s on %s',
      input.prPolicy,
      input.taskId,
      input.branchName
    );
    return suppress(detail);
  }

  if (input.prPolicy !== 'docs_only') return null;

  let nonDocFiles: string[] = [];
  try {
    const { stdout: diffOut } = await deps.execFile(
      'git',
      ['diff', '--name-only', '-z', `${input.baseBranch}..HEAD`],
      { cwd: input.repositoryPath, timeout: 15000 }
    );
    nonDocFiles = diffOut
      .split(/[\0\r\n]+/)
      .map((file) => file.trim())
      .filter(Boolean)
      .filter((file) => !isDocumentationFile(file));
  } catch (diffErr: any) {
    deps.log.warn(
      'Failed to inspect commit diff for bot policy check on %s: %s',
      input.branchName,
      diffErr?.message ?? diffErr
    );
    // An uninspectable diff cannot prove the branch is docs-only, so the gate stays shut.
    return suppress(
      `[Policy Guard] Autonomous PR suppressed: PR policy is 'docs_only' and the commit diff could not be inspected (${redactGitSecrets(
        diffErr?.message ?? String(diffErr),
        [input.githubToken]
      )}).`
    );
  }

  if (nonDocFiles.length === 0) return null;

  deps.log.info(
    'Autonomous PR policy "docs_only" blocked PR for task %s on %s (non-doc files modified: %s)',
    input.taskId,
    input.branchName,
    nonDocFiles.join(', ')
  );
  return suppress(
    `[Policy Guard] Autonomous PR suppressed: PR policy is 'docs_only', so only documentation changes ship. Code modifications must be submitted as GitHub Issues.\nNon-doc files modified: ${nonDocFiles.join(', ')}`
  );
};
