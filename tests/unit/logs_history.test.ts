import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import ky from 'ky';
import { LogBuffer, redact, installConsoleTee } from '../../src/logs/buffer.js';
import { AppDatabase } from '../../src/storage/db.js';
import { ConfigStore } from '../../src/config/store.js';
import { BUILTIN_DEFAULTS } from '../../src/config/schema.js';
import { startWebServer, closeWebServer } from '../../src/web/server.js';
import { makeTempDir } from '../e2e/harness/index.js';

describe('Log buffer', () => {
  it('redacts explicit secrets, Discord-shaped tokens and key=value credentials', () => {
    // Construct dummy test pattern dynamically to avoid static secret-scanner heuristics
    const discord = [
      'MTAxMjM0NTY3ODkwMTIzNDU2Nw',
      'XyZaBc',
      '0123456789abcdefghijklmnopqrstuvwxyz_012',
    ].join('.');
    const out = redact(
      `login ${discord} csrf_token=869346f8-31f8 secret=mysecretvalue custom-xyz-9999`,
      ['custom-xyz-9999']
    );
    assert.ok(!out.includes(discord));
    assert.ok(!out.includes('869346f8-31f8'));
    assert.ok(!out.includes('mysecretvalue'));
    assert.ok(!out.includes('custom-xyz-9999'));
    assert.ok(out.includes('[redacted]'));
  });

  it('keeps at most `capacity` entries, assigns monotonic ids, filters by since and level', () => {
    const buf = new LogBuffer(3);
    buf.push('info', 'a');
    buf.push('warn', 'b');
    buf.push('error', 'c');
    buf.push('info', 'd');
    assert.equal(buf.size, 3);
    const all = buf.since(0);
    assert.deepEqual(
      all.map((e) => e.message),
      ['b', 'c', 'd']
    );
    assert.deepEqual(
      buf.since(all[1]!.id).map((e) => e.message),
      ['d']
    );
    assert.deepEqual(
      buf.since(0, 'warn').map((e) => e.message),
      ['b', 'c']
    );
  });

  it('console tee captures output, redacts via provider, and uninstalls cleanly', () => {
    const buf = new LogBuffer(10, () => ['hunter2hunter2']);
    const originalLog = console.log;
    const printed: string[] = [];
    console.log = (...a: unknown[]) => void printed.push(a.join(' '));
    const uninstall = installConsoleTee(buf);
    try {
      console.log('password is hunter2hunter2');
      console.error('boom');
    } finally {
      uninstall();
      console.log = originalLog;
    }
    const got = buf.since(0);
    assert.equal(got.length, 2);
    assert.ok(!got[0]!.message.includes('hunter2hunter2'));
    assert.equal(got[1]!.level, 'error');
    assert.equal(printed.length, 1);
  });
});

describe('Dispatch history', () => {
  it('persists and lists dispatches newest-first', () => {
    const db = new AppDatabase(':memory:');
    db.recordDispatch({
      repository: 'a',
      prompt: 'p1',
      requestedBy: 'u',
      success: true,
      branch: 'b1',
      durationMs: 10,
    });
    db.recordDispatch({
      repository: 'b',
      prompt: 'p2',
      requestedBy: 'u',
      success: false,
      error: 'offline',
      durationMs: 5,
    });
    const rows = db.listDispatches();
    assert.equal(rows.length, 2);
    assert.equal(rows[0]!.repository, 'b');
    assert.equal(rows[0]!.success, false);
    assert.equal(rows[0]!.error, 'offline');
    assert.equal(rows[1]!.branch, 'b1');
    assert.equal(db.listDispatches(1).length, 1);
    db.close();
  });
});

describe('Web: /api/logs and /api/dispatches', () => {
  it('serves buffered logs with since/level filtering and reports disabled without a buffer', async () => {
    const { dir, cleanup } = makeTempDir('web_logs_');
    const store = new ConfigStore(path.join(dir, 't.db'), {});
    const logBuffer = new LogBuffer(10);
    logBuffer.push('info', 'hello');
    logBuffer.push('error', 'bad');
    const withBuf = await startWebServer({
      configStore: store,
      logBuffer,
      host: '127.0.0.1',
      port: 0,
    });
    const without = await startWebServer({ configStore: store, host: '127.0.0.1', port: 0 });
    try {
      const all = await ky.get(`http://127.0.0.1:${withBuf.port}/api/logs`).json<any>();
      assert.equal(all.enabled, true);
      assert.equal(all.entries.length, 2);
      const errs = await ky
        .get(`http://127.0.0.1:${withBuf.port}/api/logs?level=error`)
        .json<any>();
      assert.deepEqual(
        errs.entries.map((e: any) => e.message),
        ['bad']
      );
      const none = await ky.get(`http://127.0.0.1:${without.port}/api/logs`).json<any>();
      assert.equal(none.enabled, false);
      assert.deepEqual(none.entries, []);
    } finally {
      await closeWebServer(withBuf.server);
      await closeWebServer(without.server);
      store.close();
      cleanup();
    }
  });

  it('lists persisted dispatches', async () => {
    const { dir, cleanup } = makeTempDir('web_dispatches_');
    const store = new ConfigStore(path.join(dir, 't.db'), {});
    store.getDatabase().recordDispatch({
      repository: 'agylity',
      prompt: 'p',
      requestedBy: 'web-ui',
      success: true,
      durationMs: 1,
    });
    const { server, port } = await startWebServer({
      configStore: store,
      host: '127.0.0.1',
      port: 0,
    });
    try {
      const rows = await ky.get(`http://127.0.0.1:${port}/api/dispatches`).json<any[]>();
      assert.equal(rows.length, 1);
      assert.equal(rows[0].repository, 'agylity');
    } finally {
      await closeWebServer(server);
      store.close();
      cleanup();
    }
  });
});
