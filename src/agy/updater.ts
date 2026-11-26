import { defaultExecFileAsync, type ExecFileAsyncFn } from '../sentry/discovery.js';
import { logger, type Logger } from '../logs/logger.js';

// agy refreshes itself at boot, so a longer cache would keep reporting the version the container
// shipped with; a stale number is worse than one extra local spawn per window.
export const AGY_VERSION_CACHE_TTL_MS = 60_000;
const AGY_VERSION_TIMEOUT_MS = 10_000;
export const AGY_UPDATE_TIMEOUT_MS = 300_000;

interface AgyUpdateResult {
  before: string | null;
  after: string | null;
  updated: boolean;
  error?: string;
}

export interface AgyUpdaterLike {
  getVersion(options?: { force?: boolean }): Promise<string | null>;
  getCachedVersion(): string | null;
  invalidate(): void;
  update(): Promise<AgyUpdateResult>;
}

interface AgyUpdaterOptions {
  agyBinPath?: string;
  execFileFn?: ExecFileAsyncFn;
  logger?: Logger;
  versionTtlMs?: number;
  updateTimeoutMs?: number;
  now?: () => number;
}

/**
 * `agy --version` prints a bare version on some builds and a decorated line on others, so the
 * semver token wins and anything else is kept verbatim rather than dropped.
 */
export const parseAgyVersion = (stdout: string): string | null => {
  const text = stdout.trim();
  if (!text) return null;
  const semver = /\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/.exec(text);
  if (semver) return semver[0];
  const firstLine = text.split(/\r?\n/)[0]?.trim() ?? '';
  return firstLine ? firstLine.slice(0, 80) : null;
};

const describeFailure = (err: unknown): string => {
  const failure = err as { message?: string } | undefined;
  return failure?.message ?? String(err);
};

/** Fail-soft wrapper around the `agy` binary: every failure degrades to "unknown version". */
export class AgyUpdater implements AgyUpdaterLike {
  private readonly agyBinPath: string;
  private readonly execFileFn: ExecFileAsyncFn;
  private readonly log: Logger;
  private readonly versionTtlMs: number;
  private readonly updateTimeoutMs: number;
  private readonly now: () => number;

  private cachedVersion: string | null = null;
  private cachedAtMs = 0;
  private probed = false;
  private pending: Promise<string | null> | null = null;
  private pendingForced = false;
  private generation = 0;

  constructor(options: AgyUpdaterOptions = {}) {
    this.agyBinPath = options.agyBinPath?.trim() || 'agy';
    this.execFileFn = options.execFileFn ?? defaultExecFileAsync;
    this.log = options.logger ?? logger.child('agy');
    this.versionTtlMs = options.versionTtlMs ?? AGY_VERSION_CACHE_TTL_MS;
    this.updateTimeoutMs = options.updateTimeoutMs ?? AGY_UPDATE_TIMEOUT_MS;
    this.now = options.now ?? Date.now;
  }

  /** Cached read only: safe on a request path that must answer while the binary is mid-update. */
  public getCachedVersion(): string | null {
    return this.cachedVersion;
  }

  public invalidate(): void {
    this.generation += 1;
    this.cachedVersion = null;
    this.probed = false;
    this.cachedAtMs = 0;
    this.pending = null;
    this.pendingForced = false;
  }

  public async getVersion(options: { force?: boolean } = {}): Promise<string | null> {
    if (!options.force && this.isFresh()) return this.cachedVersion;
    // Two callers in the same window would otherwise spawn the binary twice for one answer, but a
    // forced read exists because the cache is suspect: it may not inherit a probe started before it.
    if (this.pending && (this.pendingForced || !options.force)) return this.pending;
    // Bump generation so an older in-flight probe cannot overwrite the cache if it resolves later.
    if (options.force) this.generation += 1;
    const probe = this.probe().finally(() => {
      if (this.pending === probe) {
        this.pending = null;
        this.pendingForced = false;
      }
    });
    this.pending = probe;
    this.pendingForced = options.force === true;
    return probe;
  }

  public async update(): Promise<AgyUpdateResult> {
    const before = await this.getVersion();
    try {
      await this.execFileFn(this.agyBinPath, ['update'], {
        timeout: this.updateTimeoutMs,
        windowsHide: true,
      });
      const after = await this.getVersion({ force: true });
      const updated = before !== null && after !== null && before !== after;
      if (updated) {
        this.log.info('agy updated: %s -> %s', before, after);
      } else {
        this.log.info('agy update complete; version unchanged at %s', after ?? before ?? 'unknown');
      }
      return { before, after, updated };
    } catch (err) {
      const message = describeFailure(err);
      this.log.warn('agy update failed: %s', message);
      // A failed update can leave the install directory half-written, so the next read re-probes.
      this.invalidate();
      return { before, after: null, updated: false, error: message };
    }
  }

  private isFresh(): boolean {
    return this.probed && this.now() - this.cachedAtMs < this.versionTtlMs;
  }

  private async probe(): Promise<string | null> {
    const generation = this.generation;
    let version: string | null = null;
    try {
      const { stdout } = await this.execFileFn(this.agyBinPath, ['--version'], {
        timeout: AGY_VERSION_TIMEOUT_MS,
        windowsHide: true,
      });
      version = parseAgyVersion(stdout);
      if (generation === this.generation) this.cachedVersion = version;
      if (!version) {
        this.log.debug('agy --version printed no recognisable version');
      }
    } catch (err) {
      if (generation === this.generation) this.cachedVersion = null;
      this.log.debug('agy --version probe failed: %s', describeFailure(err));
    }
    if (generation === this.generation) {
      this.probed = true;
      this.cachedAtMs = this.now();
    }
    return version;
  }
}

export const sharedAgyUpdater: AgyUpdater = new AgyUpdater();
