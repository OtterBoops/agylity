import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { capOutput, tailWindow } from '../../src/coordinator/queue.js';

describe('Coordinator Queue: capOutput & tailWindow', () => {
  it('returns text unchanged when within cap', () => {
    assert.equal(capOutput('hello', 5), 'hello');
    assert.equal(capOutput('hello', 10), 'hello');
  });

  it('truncates ASCII output to the tail and reports dropped character count', () => {
    assert.equal(capOutput('abcdefghij', 4), '[truncated 6 characters]\nghij');
  });

  it('nudges off a surrogate pair when truncation lands on a low surrogate', () => {
    // '🚀' is 2 UTF-16 code units (\uD83D\uDE80), so indices 5 and 6 hold the pair.
    const text = 'aaaaa🚀bbbb';
    assert.equal(text.length, 11);

    // cap = 5 puts the raw cut at index 6 (the low surrogate); tailWindow steps back to index 5.
    const kept = tailWindow(text, 5);
    assert.equal(kept, '🚀bbbb');
    assert.equal(Buffer.from(kept, 'utf8').toString('utf8'), kept);

    const capped = capOutput(text, 5);
    assert.equal(capped, '[truncated 5 characters]\n🚀bbbb');
    assert.equal(Buffer.from(capped, 'utf8').toString('utf8'), capped);
  });

  it('keeps the full surrogate pair when the cut lands on the high surrogate', () => {
    const text = 'aaaaa🚀bbbb';
    assert.equal(tailWindow(text, 6), '🚀bbbb');
    assert.equal(capOutput(text, 6), '[truncated 5 characters]\n🚀bbbb');
  });
});
