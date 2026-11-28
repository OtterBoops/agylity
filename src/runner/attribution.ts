import { promises as fsPromises } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Logger } from '../logs/logger.js';
import type { ExecFileAsyncFn } from '../sentry/discovery.js';

// A squash-merge credits every `Co-authored-by:` trailer and every noreply address on the branch,
// so an agent that improvises an identity inside the container can attribute work to a stranger.
const CO_AUTHOR_TRAILER_RE = /^[ \t]*co-authored-by[ \t]*:/i;
// A NUL cannot appear in a commit message, so it is the one separator a message cannot forge.
const ATTRIBUTION_FIELD = '\u0000';
const ATTRIBUTION_FIELD_COUNT = 10;
const ATTRIBUTION_LOG_FORMAT = '%H%x00%T%x00%P%x00%an%x00%ae%x00%aI%x00%cn%x00%ce%x00%cI%x00%B';

export interface BranchCommit {
  sha: string;
  tree: string;
  parents: string[];
  authorName: string;
  authorEmail: string;
  authorDate: string;
  committerName: string;
  committerEmail: string;
  committerDate: string;
  message: string;
}

export const hasCoAuthorTrailer = (message: string): boolean =>
  message.split(/\r?\n/).some((line) => CO_AUTHOR_TRAILER_RE.test(line));

export const stripCoAuthorTrailers = (message: string): string =>
  `${message
    .split(/\r?\n/)
    .filter((line) => !CO_AUTHOR_TRAILER_RE.test(line))
    .join('\n')
    .replace(/\s+$/, '')}\n`;

/** True for any address the identity holding the lease does not own, noreply or not. */
export const isUnownedIdentity = (email: string, ownedEmail?: string): boolean =>
  email.trim().toLowerCase() !== (ownedEmail ?? '').trim().toLowerCase();

export const parseBranchCommitLog = (stdout: string): BranchCommit[] => {
  const fields = stdout.split(ATTRIBUTION_FIELD);
  if (fields[fields.length - 1] === '') fields.pop();
  const commits: BranchCommit[] = [];
  for (
    let index = 0;
    index + ATTRIBUTION_FIELD_COUNT <= fields.length;
    index += ATTRIBUTION_FIELD_COUNT
  ) {
    // Field order mirrors ATTRIBUTION_LOG_FORMAT; the message is last and keeps its own newlines.
    const field = (offset: number): string => (fields[index + offset] ?? '').trim();
    const sha = field(0);
    if (!sha) continue;
    const parents = field(2);
    commits.push({
      sha,
      tree: field(1),
      parents: parents === '' ? [] : parents.split(' '),
      authorName: field(3),
      authorEmail: field(4),
      authorDate: field(5),
      committerName: field(6),
      committerEmail: field(7),
      committerDate: field(8),
      message: fields[index + 9] ?? '',
    });
  }
  return commits;
};

export interface AttributionDeps {
  execFile: ExecFileAsyncFn;
  log: Logger;
}

/** Replays only offending commits through `commit-tree` so diffs stay identical and clean branches keep their SHAs. */
export const stripUntrustedAttribution = async (
  cwd: string,
  baseBranch: string,
  ownedIdentity: { name: string; email: string },
  deps: AttributionDeps
): Promise<void> => {
  const commits = await readBranchCommits(cwd, baseBranch, deps);
  if (commits.length === 0) return;

  const { stdout: headOut } = await deps.execFile('git', ['rev-parse', 'HEAD'], {
    cwd,
    timeout: 10000,
  });
  const originalHead = headOut.trim() || commits[commits.length - 1]!.sha;

  const safeName = ownedIdentity.name || 'Agylity Runner';
  const safeEmail = ownedIdentity.email || 'noreply@agylity.local';
  const rewritten = new Map<string, string>();
  let flagged = 0;

  for (const commit of commits) {
    const parents = commit.parents.map((parent) => rewritten.get(parent) ?? parent);
    const parentsMoved = parents.some((parent, index) => parent !== commit.parents[index]);
    const authorUnowned = isUnownedIdentity(commit.authorEmail, safeEmail);
    const committerUnowned = isUnownedIdentity(commit.committerEmail, safeEmail);
    const carriesTrailer = hasCoAuthorTrailer(commit.message);

    if (!parentsMoved && !authorUnowned && !committerUnowned && !carriesTrailer) {
      rewritten.set(commit.sha, commit.sha);
      continue;
    }

    const nextSha = await replayCommit(
      cwd,
      {
        ...commit,
        parents,
        authorName: authorUnowned ? safeName : commit.authorName,
        authorEmail: authorUnowned ? safeEmail : commit.authorEmail,
        committerName: committerUnowned ? safeName : commit.committerName,
        committerEmail: committerUnowned ? safeEmail : commit.committerEmail,
        message: carriesTrailer ? stripCoAuthorTrailers(commit.message) : commit.message,
      },
      deps
    );
    rewritten.set(commit.sha, nextSha);
    flagged += 1;
  }

  if (flagged === 0) return;

  const head = rewritten.get(originalHead);
  if (!head) {
    throw new Error(`Rewritten commit map did not contain HEAD (${originalHead})`);
  }

  deps.log.info(
    'Rewrote attribution on %d of %d commit(s) before pushing: co-author trailers and identities the lease does not own never reach GitHub',
    flagged,
    commits.length
  );
  await deps.execFile('git', ['reset', '--hard', head], { cwd, timeout: 15000 });
};

/** The commits this branch adds to `baseBranch`, oldest first in topological order so parents replay before children. */
const readBranchCommits = async (
  cwd: string,
  baseBranch: string,
  deps: AttributionDeps
): Promise<BranchCommit[]> => {
  const { stdout } = await deps.execFile(
    'git',
    [
      'log',
      '-z',
      '--topo-order',
      '--reverse',
      `--format=${ATTRIBUTION_LOG_FORMAT}`,
      `${baseBranch}..HEAD`,
    ],
    { cwd, timeout: 20000 }
  );
  return parseBranchCommitLog(stdout ?? '');
};

/** Rebuilds one commit from its own tree and metadata, returning the new id. */
const replayCommit = async (
  cwd: string,
  commit: BranchCommit,
  deps: AttributionDeps
): Promise<string> => {
  const scratchDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'agylity-commit-'));
  try {
    const messagePath = path.join(scratchDir, 'message');
    await fsPromises.writeFile(messagePath, commit.message, 'utf8');
    const args = ['commit-tree', commit.tree];
    for (const parent of commit.parents) args.push('-p', parent);
    args.push('-F', messagePath);
    const { stdout } = await deps.execFile('git', args, {
      cwd,
      timeout: 30000,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: commit.authorName,
        GIT_AUTHOR_EMAIL: commit.authorEmail,
        GIT_AUTHOR_DATE: commit.authorDate,
        GIT_COMMITTER_NAME: commit.committerName,
        GIT_COMMITTER_EMAIL: commit.committerEmail,
        GIT_COMMITTER_DATE: commit.committerDate,
      },
    });
    const sha = (stdout ?? '').trim();
    if (!sha) throw new Error(`git commit-tree produced no commit id for tree ${commit.tree}`);
    return sha;
  } finally {
    await fsPromises.rm(scratchDir, { recursive: true, force: true });
  }
};
