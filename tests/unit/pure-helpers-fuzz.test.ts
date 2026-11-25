import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resetTimeMs, normalizeResetTime } from '../../src/shared/resetTime.js';
import { resolveTaskTitle } from '../../src/shared/titles.js';
import { buildContinuationBranchName } from '../../src/runner/policy.js';
import { toPercentFloor } from '../../src/shared/percent.js';

// Seeded so the corpus is identical on every run: a failure is reproducible, not a flaky red build.
const makeRandom = (seed: number): (() => number) => {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
};

const ALPHABET = [
  'a',
  'Z',
  '0',
  '-',
  '.',
  ' ',
  '\n',
  '\t',
  'é',
  '漢',
  '🚀',
  '"',
  '`',
  '/',
  ':',
  '#',
  '[',
  ']',
  '(',
  ')',
  '%',
  '+',
  '@',
  '{',
  '}',
  '\\',
  '\u0000',
  '\u007f',
];

const makeString = (random: () => number, length: number): string =>
  Array.from({ length }, () => ALPHABET[Math.floor(random() * ALPHABET.length)]!).join('');

describe('Pure helpers: adversarial input invariants', () => {
  it('never throws, never returns an unusable value, for 4 000 random inputs', () => {
    const random = makeRandom(12345);

    for (let i = 0; i < 4000; i += 1) {
      const raw = random() < 0.15 ? null : makeString(random, Math.floor(random() * 40));
      const shown = JSON.stringify(raw);

      const normalized = normalizeResetTime(raw);
      assert.equal(typeof normalized, 'string', shown);
      assert.equal(normalizeResetTime(normalized), normalized, `not idempotent: ${shown}`);
      assert.doesNotMatch(normalized, /\s/, `left whitespace: ${shown}`);

      const deadline = resetTimeMs(raw);
      assert.ok(deadline === null || deadline > 0, `non-positive deadline: ${shown}`);

      const title = resolveTaskTitle(raw, raw);
      assert.ok(title.length > 0, `empty title: ${shown}`);
      assert.ok(title.length <= 72, `title over budget (${title.length}): ${shown}`);
      assert.equal(title, title.trim(), `untrimmed title: ${shown}`);

      const branch = buildContinuationBranchName('task-1-ab12', title);
      assert.match(branch, /^agy\/[a-z0-9-]+$/, `bad ref ${branch} from ${shown}`);
      assert.ok(!branch.includes('..') && !branch.endsWith('-'), `unusable ref ${branch}`);
      assert.ok(branch.length <= 50, `overlong ref ${branch}`);

      const fraction = random() * 1.2 - 0.1;
      assert.ok(Number.isFinite(toPercentFloor(fraction)), `non-finite percent for ${fraction}`);
    }
  });
});
