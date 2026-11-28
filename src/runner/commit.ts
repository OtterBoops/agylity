import type { Logger } from '../logs/logger.js';
import type { ExecFileAsyncFn } from '../sentry/discovery.js';
import { resolveTaskTitle } from '../shared/titles.js';

export interface CommitDeps {
  execFile: ExecFileAsyncFn;
  log: Logger;
}

/** Raw porcelain status, tail-trimmed only: the leading column is meaningful to the next model. */
export const gitStatusPorcelain = async (cwd: string, deps: CommitDeps): Promise<string> => {
  const { stdout } = await deps.execFile('git', ['status', '--porcelain'], {
    cwd,
    timeout: 15000,
  });
  return stdout.replace(/\s+$/, '');
};

/** Untracked files as git spells them: `-uall` expands new directories and `-z` preserves spaces/quotes. */
export const listUntracked = async (cwd: string, deps: CommitDeps): Promise<string[]> => {
  const { stdout } = await deps.execFile('git', ['status', '--porcelain', '-z', '-uall'], {
    cwd,
    timeout: 15000,
  });
  const entries = stdout.split('\u0000');
  const untracked: string[] = [];
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    if (!entry) continue;
    if (entry.startsWith('?? ')) {
      untracked.push(entry.slice(3));
      continue;
    }
    // Renames and copies emit a second NUL-terminated entry carrying the source path.
    const x = entry[0];
    const y = entry[1];
    if (x === 'R' || x === 'C' || y === 'R' || y === 'C') {
      i += 1;
    }
  }
  return untracked;
};

/** Commits on HEAD that `baseBranch` does not have. */
export const countCommitsAhead = async (
  cwd: string,
  baseBranch: string,
  deps: CommitDeps
): Promise<number> => {
  const { stdout } = await deps.execFile('git', ['rev-list', '--count', `${baseBranch}..HEAD`], {
    cwd,
    timeout: 10000,
  });
  return parseInt(stdout.trim(), 10) || 0;
};

/** Stages untracked paths in batches, falling back per-file if one vanished or is ignored. */
const stageUntrackedPaths = async (
  cwd: string,
  untrackedPaths: readonly string[],
  deps: CommitDeps
): Promise<void> => {
  for (let index = 0; index < untrackedPaths.length; index += 50) {
    const batch = untrackedPaths.slice(index, index + 50);
    try {
      await deps.execFile('git', ['add', '--', ...batch], { cwd, timeout: 15000 });
    } catch {
      for (const filePath of batch) {
        try {
          await deps.execFile('git', ['add', '--', filePath], { cwd, timeout: 15000 });
        } catch (addErr: any) {
          deps.log.warn(
            'Skipped an untracked path that could not be staged (%s): %s',
            filePath,
            addErr?.message
          );
        }
      }
    }
  }
};

/** Returns true when the index has staged changes (`git diff --cached --quiet` exits 1). */
const hasStagedChanges = async (cwd: string, deps: CommitDeps): Promise<boolean> => {
  try {
    await deps.execFile('git', ['diff', '--cached', '--quiet'], { cwd, timeout: 15000 });
    return false;
  } catch {
    return true;
  }
};

/** The newest subject among commits the agent wrote, or undefined when the branch is still clean. */
const authoredCommitSubject = async (
  cwd: string,
  baseBranch: string,
  deps: CommitDeps
): Promise<string | undefined> => {
  try {
    if ((await countCommitsAhead(cwd, baseBranch, deps)) <= 0) return undefined;

    const { stdout: subject } = await deps.execFile(
      'git',
      ['log', '-1', '--format=%s', `${baseBranch}..HEAD`],
      { cwd, timeout: 10000 }
    );
    return subject.trim() || undefined;
  } catch {
    return undefined;
  }
};

/**
 * Commits whatever the agent left in the working tree, and reports whether the branch carries work at
 * all. A commit failure is returned rather than thrown: the caller decides whether to publish the
 * tree as an issue deliverable instead of a PR.
 */
export const commitWorkingTree = async (
  input: {
    repositoryPath: string;
    title?: string;
    prompt: string;
    branchName: string;
    baseBranch: string;
    gitIdentityEnv: Record<string, string>;
    untrackedPaths: readonly string[];
  },
  deps: CommitDeps
): Promise<{ commitsProduced: boolean; deliverableTitle?: string; commitError?: string }> => {
  const cwd = input.repositoryPath;
  const deliverableTitle = await authoredCommitSubject(cwd, input.baseBranch, deps);
  let committed = false;
  let commitError: string | undefined;

  try {
    const statusOut = await gitStatusPorcelain(cwd, deps);
    if (statusOut !== '') {
      await deps.execFile('git', ['add', '-u'], { cwd, timeout: 15000 });
      await stageUntrackedPaths(cwd, input.untrackedPaths, deps);
      if (await hasStagedChanges(cwd, deps)) {
        await deps.execFile('git', ['commit', '-m', resolveTaskTitle(input.title, input.prompt)], {
          cwd,
          timeout: 30000,
          env: {
            ...process.env,
            ...input.gitIdentityEnv,
          },
        });
        committed = true;
        deps.log.info('Committed the working tree on %s', input.branchName);
      }
    }
  } catch (commitErr: any) {
    commitError = commitErr?.stderr?.trim() || commitErr?.message || String(commitErr);
    deps.log.error(
      'Failed to commit working tree changes on %s: %s',
      input.branchName,
      commitError
    );
  }

  if (commitError) return { commitsProduced: false, deliverableTitle, commitError };
  if (committed) return { commitsProduced: true, deliverableTitle };

  try {
    return {
      commitsProduced: (await countCommitsAhead(cwd, input.baseBranch, deps)) > 0,
      deliverableTitle,
    };
  } catch {
    return { commitsProduced: false, deliverableTitle };
  }
};
