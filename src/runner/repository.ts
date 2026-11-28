import { createHash } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { promises as fsPromises } from 'node:fs';
import path from 'node:path';
import type { Logger } from '../logs/logger.js';
import type { ExecFileAsyncFn } from '../sentry/discovery.js';
import { buildGitAuthArgs, redactGitSecrets } from './git.js';

export interface RepositoryDeps {
  execFile: ExecFileAsyncFn;
  log: Logger;
  dirExists(path: string): boolean;
  mirrorCacheDir: string;
  useMirrorCache: boolean;
}

export const resolveMirrorPath = (rawCloneUrl: string, deps: RepositoryDeps): string | null => {
  if (!deps.useMirrorCache) return null;
  const digest = createHash('sha256').update(rawCloneUrl).digest('hex');
  return path.join(deps.mirrorCacheDir, `${digest}.git`);
};

export const cloneRepository = async (
  rawCloneUrl: string,
  targetPath: string,
  githubToken: string | undefined,
  deps: RepositoryDeps
): Promise<void> => {
  const authArgs = buildGitAuthArgs(rawCloneUrl, githubToken);
  const mirrorPath = resolveMirrorPath(rawCloneUrl, deps);

  if (mirrorPath) {
    try {
      await syncMirror(rawCloneUrl, mirrorPath, authArgs, deps);
      await deps.execFile(
        'git',
        [
          ...authArgs,
          'clone',
          '--reference-if-able',
          mirrorPath,
          '--dissociate',
          '--',
          rawCloneUrl,
          targetPath,
        ],
        { timeout: 120000 }
      );
      return;
    } catch (mirrorErr: any) {
      deps.log.debug(
        'Mirror reference clone failed for %s; falling back to plain clone: %s',
        rawCloneUrl,
        mirrorErr?.message ?? mirrorErr
      );
      await removeCloneTarget(targetPath, deps);
    }
  }

  await deps.execFile('git', [...authArgs, 'clone', '--', rawCloneUrl, targetPath], {
    timeout: 120000,
  });
};

export const syncMirror = async (
  rawCloneUrl: string,
  mirrorPath: string,
  authArgs: string[],
  deps: RepositoryDeps
): Promise<void> => {
  if (existsSync(path.join(mirrorPath, 'HEAD'))) {
    try {
      // The mirror is a private remote too, so its refresh carries the same credentials as the clone.
      await deps.execFile('git', [...authArgs, 'fetch', '--prune'], {
        cwd: mirrorPath,
        timeout: 120000,
      });
    } catch (fetchErr: any) {
      deps.log.debug(
        'Mirror fetch failed for %s; using the existing mirror: %s',
        rawCloneUrl,
        fetchErr?.message ?? fetchErr
      );
    }
    return;
  }

  mkdirSync(path.dirname(mirrorPath), { recursive: true });
  try {
    await deps.execFile('git', [...authArgs, 'clone', '--bare', '--', rawCloneUrl, mirrorPath], {
      timeout: 180000,
    });
  } catch (bareErr) {
    await removeCloneTarget(mirrorPath, deps);
    throw bareErr;
  }
};

export const removeCloneTarget = async (
  targetPath: string,
  deps: RepositoryDeps
): Promise<void> => {
  try {
    await fsPromises.rm(targetPath, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 150,
    });
  } catch (rmErr: any) {
    deps.log.debug('Failed to remove partial clone at %s: %s', targetPath, rmErr?.message ?? rmErr);
  }
};

export const ensureRepository = async (
  input: {
    repositoryPath: string;
    cloneUrl?: string;
    githubToken?: string;
    onCloning?: (cloneUrl: string) => void | Promise<void>;
  },
  deps: RepositoryDeps
): Promise<{ error?: string }> => {
  if (deps.dirExists(input.repositoryPath)) return {};

  const cloneUrl = input.cloneUrl?.trim() ?? '';
  if (!cloneUrl) {
    const error = `Target repository directory does not exist: ${input.repositoryPath} (and no cloneUrl configured)`;
    deps.log.error(error);
    return { error };
  }

  try {
    await input.onCloning?.(cloneUrl);
    mkdirSync(path.dirname(input.repositoryPath), { recursive: true });
    await cloneRepository(cloneUrl, input.repositoryPath, input.githubToken, deps);
    return {};
  } catch (cloneErr: any) {
    // A half-written clone must not survive: the next run would see the directory and skip cloning.
    await removeCloneTarget(input.repositoryPath, deps);
    const error = `Failed to clone repository from ${cloneUrl}: ${redactGitSecrets(
      cloneErr?.message || String(cloneErr),
      [input.githubToken]
    )}`;
    deps.log.error(error);
    return { error };
  }
};
