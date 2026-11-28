import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { StringDecoder } from 'node:string_decoder';
import type { Logger } from '../logs/logger.js';
import type { ExecFileAsyncFn } from '../sentry/discovery.js';
import { HEARTBEAT_TAIL_BYTES } from '../shared/contracts.js';
import { tailWindow } from '../shared/text.js';
import { AgyStreamFormatter } from './agyStream.js';
import { redactGitSecrets } from './git.js';
export type SpawnFn = (
  file: string,
  args: readonly string[],
  options: SpawnOptions
) => ChildProcess;

export interface ExecDeps {
  spawn: SpawnFn;
  log: Logger;
  killProcessTree: (pid: number) => Promise<void>;
}

export const STREAM_EMIT_INTERVAL_MS = 1000;
export const STREAM_EMIT_BYTES = 4096;
export const KILL_GRACE_MS = 2000;
export const KILL_POLL_MS = 100;

export const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

export const combineOutput = (stdout?: string, stderr?: string): string =>
  [stdout?.trim(), stderr?.trim()].filter(Boolean).join('\n');

export const commandError = (
  message: string,
  detail: { stdout?: string; stderr?: string; code?: number | null; signal?: string | null } = {}
): Error => Object.assign(new Error(message), detail);

// The child is a group leader, so its whole process group dies with it, `sh -c` grandchildren too.
export const defaultKillProcessTree = async (pid: number): Promise<void> => {
  if (process.platform === 'win32') {
    await new Promise<void>((resolve) => {
      try {
        const killer = nodeSpawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
          stdio: 'ignore',
          windowsHide: true,
        });
        killer.once('close', () => resolve());
        killer.once('error', () => resolve());
      } catch {
        resolve();
      }
    });
    return;
  }

  const groupAlive = (): boolean => {
    try {
      process.kill(-pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const signalGroup = (sig: NodeJS.Signals): void => {
    try {
      process.kill(-pid, sig);
    } catch {}
  };

  if (!groupAlive()) return;
  signalGroup('SIGTERM');
  const deadline = Date.now() + KILL_GRACE_MS;
  while (Date.now() < deadline) {
    await delay(KILL_POLL_MS);
    if (!groupAlive()) return;
  }
  signalGroup('SIGKILL');
};

export const spawnFromExecFileFn =
  (execFileFn: ExecFileAsyncFn): SpawnFn =>
  (file, args, options) => {
    const child = new EventEmitter() as unknown as ChildProcess;
    const stdoutStream = new EventEmitter();
    const stderrStream = new EventEmitter();
    Object.assign(child, {
      pid: undefined,
      stdout: stdoutStream,
      stderr: stderrStream,
      kill: () => true,
    });

    const emitChunk = (stream: EventEmitter, chunk: unknown): void => {
      if (typeof chunk === 'string' && chunk !== '') stream.emit('data', chunk);
    };

    void execFileFn(file, [...args], {
      cwd: options.cwd,
      env: options.env,
      timeout: options.timeout,
      windowsHide: options.windowsHide,
    })
      .then(({ stdout, stderr }) => {
        emitChunk(stdoutStream, stdout);
        emitChunk(stderrStream, stderr);
        child.emit('close', 0, null);
      })
      .catch((err: any) => {
        emitChunk(stdoutStream, err?.stdout);
        emitChunk(stderrStream, err?.stderr);
        child.emit('close', typeof err?.code === 'number' ? err.code : 1, null);
      });

    return child;
  };

// Resolves the GitHub token owner's git identity so squash-merges match the repo owner cleanly
// without triggering GitHub's automatic `Co-authored-by:` trailer.
export const killTree = async (child: ChildProcess, deps: ExecDeps): Promise<void> => {
  const pid = child.pid;
  if (!pid) return;
  try {
    await deps.killProcessTree(pid);
  } catch (err: any) {
    deps.log.debug('Failed to kill process tree %s: %s', pid, err?.message ?? err);
  }
};

export const runStreamedCommand = async (
  file: string,
  args: readonly string[],
  options: {
    cwd: string;
    timeoutMs: number;
    env?: NodeJS.ProcessEnv;
    signal?: AbortSignal | undefined;
    onOutput?: ((tail: string) => void) | undefined;
    redactTokens?: readonly (string | undefined)[] | undefined;
    streamFormatter?: AgyStreamFormatter | undefined;
  },
  deps: ExecDeps
): Promise<{ stdout: string; stderr: string }> => {
  const signal = options.signal;
  const redactTokens = options.redactTokens ?? [];
  if (signal?.aborted) {
    throw commandError(`Command aborted before start: ${file}`);
  }

  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  let tail = '';
  let pendingEmit = 0;
  let lastEmitMs = Date.now();

  let child: ChildProcess;
  try {
    child = deps.spawn(file, args, {
      cwd: options.cwd,
      env: {
        ...process.env,
        // No child of the runner may inherit a credential; the lease is passed explicitly.
        GITHUB_TOKEN: '',
        ...options.env,
        // Windows only: agy's update check flashes a console window there.
        ...(process.platform === 'win32' ? { AGY_CLI_DISABLE_AUTO_UPDATE: 'true' } : {}),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      windowsHide: true,
    });
  } catch (err: any) {
    throw commandError(`Failed to start ${file}: ${err?.message ?? err}`);
  }

  return await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    let settled = false;
    let timedOut = false;
    let aborted = false;
    let killPromise: Promise<void> | null = null;

    const ensureKilled = (): Promise<void> => {
      killPromise ??= killTree(child, deps);
      return killPromise;
    };

    const flushOutput = (): void => {
      if (!options.onOutput || pendingEmit <= 0) return;
      pendingEmit = 0;
      try {
        options.onOutput(tail);
      } catch {
        // A dead heartbeat must not fail the run.
      }
    };

    const cleanup = (): void => {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      signal?.removeEventListener('abort', onAbort);
    };

    const stdoutDecoder = new StringDecoder('utf8');
    const stderrDecoder = new StringDecoder('utf8');
    let decodersFlushed = false;

    const flushDecoders = (): void => {
      if (decodersFlushed) return;
      decodersFlushed = true;
      const stdoutTail = stdoutDecoder.end();
      if (stdoutTail) {
        stdoutChunks.push(stdoutTail);
        const display = options.streamFormatter
          ? options.streamFormatter.feed(stdoutTail)
          : stdoutTail;
        if (display) {
          tail = redactGitSecrets(tailWindow(tail + display, HEARTBEAT_TAIL_BYTES), redactTokens);
          pendingEmit += display.length;
        }
      }
      const formatterTail = options.streamFormatter?.flush() ?? '';
      if (formatterTail) {
        tail = redactGitSecrets(
          tailWindow(tail + formatterTail, HEARTBEAT_TAIL_BYTES),
          redactTokens
        );
        pendingEmit += formatterTail.length;
      }
      const stderrTail = stderrDecoder.end();
      if (stderrTail) {
        stderrChunks.push(stderrTail);
        tail = redactGitSecrets(tailWindow(tail + stderrTail, HEARTBEAT_TAIL_BYTES), redactTokens);
        pendingEmit += stderrTail.length;
      }
    };

    const settle = (error: Error | null): void => {
      if (settled) return;
      settled = true;
      cleanup();
      flushDecoders();
      flushOutput();
      const stdout = stdoutChunks.join('');
      const stderr = stderrChunks.join('');
      // A child that exited on its own owns no live tree, so only a forced stop needs the kill.
      if (!error) {
        resolve({ stdout, stderr });
        return;
      }
      void ensureKilled().then(() => reject(error));
    };

    const appendChunk = (chunk: unknown, sink: string[], decoder: StringDecoder): void => {
      const text =
        typeof chunk === 'string' ? chunk : Buffer.isBuffer(chunk) ? decoder.write(chunk) : '';
      if (!text) return;
      sink.push(text);
      const display =
        sink === stdoutChunks && options.streamFormatter
          ? options.streamFormatter.feed(text)
          : text;
      tail = redactGitSecrets(tailWindow(tail + display, HEARTBEAT_TAIL_BYTES), redactTokens);
      pendingEmit += display.length;
      const now = Date.now();
      if (
        options.onOutput &&
        (pendingEmit >= STREAM_EMIT_BYTES || now - lastEmitMs >= STREAM_EMIT_INTERVAL_MS)
      ) {
        lastEmitMs = now;
        flushOutput();
      }
    };

    // A forced stop must reap the tree before the error reaches the caller, so both paths wait on it.
    const killAndSettle = (error: Error): void => {
      void ensureKilled().then(() => settle(error));
    };

    const onAbort = (): void => {
      aborted = true;
      flushDecoders();
      killAndSettle(
        commandError(`Command aborted: ${file} was killed after the abort signal fired`, {
          stdout: stdoutChunks.join(''),
          stderr: stderrChunks.join(''),
          signal: 'SIGKILL',
        })
      );
    };

    // A non-positive budget means no timeout: setTimeout(0) would kill the child on the next tick.
    const requestedTimeoutMs = Number(options.timeoutMs);
    const timeoutMs =
      Number.isFinite(requestedTimeoutMs) && requestedTimeoutMs > 0 ? requestedTimeoutMs : 0;
    const timeoutTimer =
      timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            flushDecoders();
            killAndSettle(
              commandError(`Command timed out after ${timeoutMs}ms: ${file}`, {
                stdout: stdoutChunks.join(''),
                stderr: stderrChunks.join(''),
                code: null,
                signal: 'SIGKILL',
              })
            );
          }, timeoutMs)
        : null;

    child.stdout?.on('data', (chunk: Buffer | string) =>
      appendChunk(chunk, stdoutChunks, stdoutDecoder)
    );
    child.stderr?.on('data', (chunk: Buffer | string) =>
      appendChunk(chunk, stderrChunks, stderrDecoder)
    );

    child.once('error', (err: Error) => {
      settle(commandError(`Failed to run ${file}: ${err?.message ?? err}`));
    });

    child.once('close', (code: number | null, closeSignal: NodeJS.Signals | null) => {
      if (aborted) return;
      if (timedOut) return;
      flushDecoders();
      const stdout = stdoutChunks.join('');
      const stderr = stderrChunks.join('');
      if (code === 0) {
        settle(null);
        return;
      }
      const detail = tailWindow(stderr.trim() || stdout.trim(), 4000);
      settle(
        commandError(
          `Command failed: ${file} (exit ${code ?? closeSignal ?? 'unknown'})${detail ? `\n${detail}` : ''}`,
          { stdout, stderr, code, signal: closeSignal }
        )
      );
    });

    signal?.addEventListener('abort', onAbort, { once: true });
    // An abort that landed between the entry check and this listener would otherwise never be seen.
    if (signal?.aborted) onAbort();
  });
};
