import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createLogger, type Logger } from '../../src/logs/logger.js';
import { createMemorySink } from '../e2e/harness/index.js';
import {
  AGY_UPDATE_TIMEOUT_MS,
  AGY_VERSION_CACHE_TTL_MS,
  AgyUpdater,
  parseAgyVersion,
} from '../../src/agy/updater.js';

const quietLogger = (): Logger => createLogger({ minLevel: 'error', sinks: [() => {}] });

const recordingLogger = () => {
  const sink = createMemorySink();
  const logger = createLogger({ minLevel: 'debug', sinks: [sink.sink] });
  return { logger, sink };
};

const alwaysFails = async (): Promise<{ stdout: string; stderr: string }> => {
  throw new Error('spawn agy ENOENT');
};

describe('Antigravity CLI: agy --version helper', () => {
  describe('parseAgyVersion', () => {
    it('extracts the version token from decorated output', () => {
      assert.equal(parseAgyVersion('0.4.2\n'), '0.4.2');
      assert.equal(parseAgyVersion('agy 0.4.2 (build 9182)\n'), '0.4.2');
      assert.equal(parseAgyVersion('v1.0.0-rc.1'), '1.0.0-rc.1');
    });

    it('keeps unversioned output verbatim and reports nothing for empty output', () => {
      assert.equal(parseAgyVersion('development build'), 'development build');
      assert.equal(parseAgyVersion('   \n'), null);
    });
  });

  it('spawns a forced read instead of inheriting a probe already in flight', async () => {
    let reported = '1.0.0';
    let versionCalls = 0;
    const gate: Array<() => void> = [];

    const updater = new AgyUpdater({
      execFileFn: async () => {
        versionCalls += 1;
        const answer = reported;
        await new Promise<void>((resolve) => gate.push(resolve));
        return { stdout: `${answer}\n`, stderr: '' };
      },
      logger: quietLogger(),
    });

    const inherited = updater.getVersion();
    reported = '2.0.0';
    const forced = updater.getVersion({ force: true });

    assert.equal(versionCalls, 2, 'a forced read must not reuse an older spawn');
    gate.forEach((release) => release());
    assert.equal(await inherited, '1.0.0');
    assert.equal(await forced, '2.0.0');
    assert.equal(updater.getCachedVersion(), '2.0.0');
  });

  it('does not let an older in-flight probe overwrite the cache after a forced probe resolves first', async () => {
    let reported = '1.0.0';
    const gate: Array<() => void> = [];

    const updater = new AgyUpdater({
      execFileFn: async () => {
        const answer = reported;
        await new Promise<void>((resolve) => gate.push(resolve));
        return { stdout: `${answer}\n`, stderr: '' };
      },
      logger: quietLogger(),
    });

    const older = updater.getVersion();
    reported = '2.0.0';
    const forced = updater.getVersion({ force: true });

    // Resolve the forced probe FIRST, then the older probe SECOND.
    gate[1]?.();
    assert.equal(await forced, '2.0.0');
    assert.equal(updater.getCachedVersion(), '2.0.0');

    gate[0]?.();
    assert.equal(await older, '1.0.0');
    assert.equal(
      updater.getCachedVersion(),
      '2.0.0',
      'an older probe resolving later must not clobber the forced probe cache'
    );
  });

  it('drops the answer of a probe that an invalidate overtook', async () => {
    let versionCalls = 0;
    let release: (() => void) | undefined;

    const updater = new AgyUpdater({
      execFileFn: async () => {
        versionCalls += 1;
        await new Promise<void>((resolve) => (release = resolve));
        return { stdout: '9.9.9\n', stderr: '' };
      },
      logger: quietLogger(),
    });

    const inFlight = updater.getVersion();
    updater.invalidate();
    release?.();
    await inFlight;

    assert.equal(versionCalls, 1);
    assert.equal(updater.getCachedVersion(), null, 'a superseded probe must not refill the cache');
  });

  it('caches the version for the TTL and re-probes once it expires', async () => {
    let nowMs = 1_000;
    let reported = '0.1.0';
    let versionCalls = 0;

    const updater = new AgyUpdater({
      execFileFn: async (_file, args) => {
        versionCalls++;
        assert.deepEqual([...args], ['--version']);
        return { stdout: `${reported}\n`, stderr: '' };
      },
      now: () => nowMs,
      logger: quietLogger(),
    });

    assert.equal(await updater.getVersion(), '0.1.0');
    assert.equal(await updater.getVersion(), '0.1.0');
    assert.equal(versionCalls, 1, 'a warm cache must not spawn the binary twice');

    reported = '0.2.0';
    nowMs += AGY_VERSION_CACHE_TTL_MS;
    assert.equal(await updater.getVersion(), '0.2.0');
    assert.equal(versionCalls, 2, 'an expired cache must pick up a background boot update');
    assert.equal(updater.getCachedVersion(), '0.2.0');
  });

  it('collapses concurrent probes into a single spawn', async () => {
    let attempts = 0;
    const updater = new AgyUpdater({
      execFileFn: async () => {
        attempts++;
        return { stdout: '0.3.0\n', stderr: '' };
      },
      logger: quietLogger(),
    });

    const [first, second] = await Promise.all([
      updater.getVersion({ force: true }),
      updater.getVersion({ force: true }),
    ]);
    assert.equal(first, '0.3.0');
    assert.equal(second, '0.3.0');
    assert.equal(attempts, 1);
  });

  it('degrades to an unknown version instead of throwing when the probe fails', async () => {
    let attempts = 0;
    const updater = new AgyUpdater({
      execFileFn: async () => {
        attempts++;
        throw new Error('spawn agy ENOENT');
      },
      logger: quietLogger(),
    });

    assert.equal(await updater.getVersion(), null);
    assert.equal(updater.getCachedVersion(), null);
    assert.equal(await updater.getVersion(), null);
    assert.equal(attempts, 1, 'a failed probe is cached for the TTL like a successful one');
  });
});

describe('Antigravity CLI: agy update', () => {
  it('reports the version transition and refreshes the cache', async () => {
    let reported = '0.1.0';
    const { logger } = recordingLogger();

    const updater = new AgyUpdater({
      execFileFn: async (_file, args) => {
        if (args[0] === 'update') {
          reported = '0.2.0';
          return { stdout: 'agy updated\n', stderr: '' };
        }
        return { stdout: `${reported}\n`, stderr: '' };
      },
      logger,
    });

    const result = await updater.update();
    assert.deepEqual(result, { before: '0.1.0', after: '0.2.0', updated: true });
    assert.equal(updater.getCachedVersion(), '0.2.0');
  });

  it('reports an unchanged version without claiming an update', async () => {
    const { logger } = recordingLogger();
    const updater = new AgyUpdater({
      execFileFn: async () => ({ stdout: '0.1.0\n', stderr: '' }),
      logger,
    });

    const result = await updater.update();
    assert.equal(result.updated, false);
    assert.deepEqual([result.before, result.after], ['0.1.0', '0.1.0']);
  });

  it('warns on failure, invalidates the cache, and never throws', async () => {
    const { logger, sink } = recordingLogger();
    const updater = new AgyUpdater({
      execFileFn: async (_file, args) => {
        if (args[0] === 'update') {
          throw new Error('directory /usr/local/bin is not fully accessible');
        }
        return { stdout: '0.1.0\n', stderr: '' };
      },
      logger,
    });

    const result = await updater.update();
    assert.equal(result.updated, false);
    assert.equal(result.after, null);
    assert.match(result.error ?? '', /not fully accessible/);
    assert.ok(
      sink.records.some(
        (record) => record.level === 'warn' && record.formatted.includes('agy update failed')
      )
    );
    assert.equal(
      updater.getCachedVersion(),
      null,
      'a half-written install must not be reported from cache'
    );
  });

  it('gives the update command its own long timeout', async () => {
    let seenTimeout: unknown;
    const updater = new AgyUpdater({
      execFileFn: async (_file, args, options) => {
        if (args[0] === 'update') {
          seenTimeout = options?.timeout;
          return { stdout: '', stderr: '' };
        }
        return { stdout: '0.1.0\n', stderr: '' };
      },
      logger: quietLogger(),
    });

    await updater.update();
    assert.equal(seenTimeout, AGY_UPDATE_TIMEOUT_MS);
  });
});

describe('Antigravity CLI: unusable binary', () => {
  it('returns a null version from update() when the binary cannot be spawned at all', async () => {
    const updater = new AgyUpdater({ execFileFn: alwaysFails, logger: quietLogger() });
    const result = await updater.update();
    assert.deepEqual([result.before, result.after, result.updated], [null, null, false]);
    assert.match(result.error ?? '', /ENOENT/);
  });
});
