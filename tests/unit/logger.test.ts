import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createLogger,
  createMemorySink,
  createBufferSink,
  DefaultLogger,
  type LogRecord,
} from '../../src/logs/logger.js';
import { LogBuffer } from '../../src/logs/buffer.js';

describe('Universal Logger', () => {
  it('formats messages with timestamps, levels, and argument interpolation', () => {
    const memory = createMemorySink();
    const log = createLogger({ minLevel: 'debug', sinks: [memory.sink] });

    log.info('System online: %s, port %d', 'agylity', 3000);
    assert.equal(memory.records.length, 1);
    const rec = memory.records[0]!;
    assert.equal(rec.level, 'info');
    assert.equal(rec.formatted, 'System online: agylity, port 3000');
    assert.ok(rec.timestamp.includes('T'));
  });

  it('filters messages below configured minLevel', () => {
    const memory = createMemorySink();
    const log = createLogger({ minLevel: 'warn', sinks: [memory.sink] });

    log.debug('hidden debug');
    log.info('hidden info');
    log.warn('visible warning');
    log.error('visible error');

    assert.equal(memory.records.length, 2);
    assert.equal(memory.records[0]!.level, 'warn');
    assert.equal(memory.records[1]!.level, 'error');

    // Dynamic level adjustment
    log.setLevel('debug');
    log.debug('now visible debug');
    assert.equal(memory.records.length, 3);
    assert.equal(memory.records[2]!.level, 'debug');
  });

  it('prefixes child logger namespaces cleanly and avoids double-tagging', () => {
    const memory = createMemorySink();
    const root = createLogger({ minLevel: 'debug', sinks: [memory.sink] });
    const sentry = root.child('sentry');
    const rpc = sentry.child('rpc');

    root.info('root message');
    sentry.info('probing endpoint');
    sentry.info('[sentry] already tagged');
    rpc.warn('fallback port triggered');

    assert.equal(memory.records.length, 4);
    assert.equal(memory.records[0]!.formatted, 'root message');
    assert.equal(memory.records[1]!.formatted, '[sentry] probing endpoint');
    assert.equal(memory.records[2]!.formatted, '[sentry] already tagged');
    assert.equal(memory.records[3]!.formatted, '[sentry:rpc] fallback port triggered');
  });

  it('safely handles Error objects and stack formatting', () => {
    const memory = createMemorySink();
    const log = createLogger({ sinks: [memory.sink] });

    const err = new Error('Connection timeout');
    log.error('Failed to reach server:', err);

    assert.equal(memory.records.length, 1);
    assert.ok(
      memory.records[0]!.formatted.includes('Failed to reach server: Error: Connection timeout')
    );
  });

  it('allows adding, removing, and clearing sinks dynamically', () => {
    const mem1 = createMemorySink();
    const mem2 = createMemorySink();
    const log = createLogger({ sinks: [mem1.sink] });

    log.info('msg 1');
    assert.equal(mem1.records.length, 1);
    assert.equal(mem2.records.length, 0);

    const unsubscribe = log.addSink(mem2.sink);
    log.info('msg 2');
    assert.equal(mem1.records.length, 2);
    assert.equal(mem2.records.length, 1);

    unsubscribe();
    log.info('msg 3');
    assert.equal(mem1.records.length, 3);
    assert.equal(mem2.records.length, 1);

    log.clearSinks();
    log.info('msg 4');
    assert.equal(mem1.records.length, 3);
    assert.equal(mem2.records.length, 1);
  });

  it('isolates faulty sinks so one throwing sink never crashes execution or drops others', () => {
    const healthyMem = createMemorySink();
    const faultySink = () => {
      throw new Error('Disk full');
    };

    const log = createLogger({ sinks: [faultySink, healthyMem.sink] });

    assert.doesNotThrow(() => {
      log.info('resilient log entry');
    });

    assert.equal(healthyMem.records.length, 1);
    assert.equal(healthyMem.records[0]!.formatted, 'resilient log entry');
  });

  it('plugs directly into LogBuffer via createBufferSink and redacts secrets', () => {
    const buffer = new LogBuffer(10, () => ['supersecret123']);
    const log = createLogger({
      namespace: 'auth',
      sinks: [createBufferSink(buffer)],
    });

    log.warn('Attempt with password supersecret123');
    const entries = buffer.since(0);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!.level, 'warn');
    assert.ok(entries[0]!.message.includes('[auth]'));
    assert.ok(entries[0]!.message.includes('[redacted]'));
    assert.ok(!entries[0]!.message.includes('supersecret123'));
  });
});
