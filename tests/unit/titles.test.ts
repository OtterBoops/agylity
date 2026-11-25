import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveTaskTitle } from '../../src/shared/titles.js';

// One title feeds the dashboard row, the branch slug, the commit subject and the PR title, so the
// helper is asserted directly instead of only through the surfaces that call it.
describe('Shared: resolveTaskTitle', () => {
  it('prefers an explicit title over the prompt and collapses its whitespace', () => {
    assert.equal(
      resolveTaskTitle('  Fix   the\tparser  ', '## Ignore this heading\n\nbody'),
      'Fix the parser'
    );
    // Newlines inside an explicit title are whitespace too, not a reason to fall back to the prompt.
    assert.equal(
      resolveTaskTitle('Fix the parser\nand the scheduler', 'other'),
      'Fix the parser and the scheduler'
    );
    // A blank explicit title is not a title.
    assert.equal(resolveTaskTitle('   ', '## Fix the parser'), 'Fix the parser');
  });

  it('derives the first meaningful prompt line with its Markdown markers stripped', () => {
    assert.equal(resolveTaskTitle(undefined, '## Fix the parser\n\nbody text'), 'Fix the parser');
    assert.equal(resolveTaskTitle(null, '# Fix the parser'), 'Fix the parser');
    // Bullets, blockquotes and ordered-list numbering are decoration, including when stacked.
    assert.equal(resolveTaskTitle(undefined, '- Fix the parser'), 'Fix the parser');
    assert.equal(resolveTaskTitle(undefined, '* Fix the parser'), 'Fix the parser');
    assert.equal(resolveTaskTitle(undefined, '> Fix the parser'), 'Fix the parser');
    assert.equal(resolveTaskTitle(undefined, '> - Fix the parser'), 'Fix the parser');
    assert.equal(resolveTaskTitle(undefined, '1. Fix the parser'), 'Fix the parser');
    assert.equal(resolveTaskTitle(undefined, '2) Fix the parser'), 'Fix the parser');
  });

  it('never leaves half a surrogate pair where it clipped', () => {
    const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

    for (const prompt of [
      '😀'.repeat(50),
      `${'word '.repeat(14)}😀 and the rest`,
      'a'.repeat(71),
    ]) {
      const title = resolveTaskTitle(undefined, prompt);
      assert.doesNotMatch(title, LONE_SURROGATE, `clipped title was ${JSON.stringify(title)}`);
      assert.ok(title.length <= 72);
    }
  });

  it('skips a fenced code block instead of titling the task from its info string', () => {
    assert.equal(
      resolveTaskTitle(undefined, '```bash\nnpm test\n```\nFix the flaky test'),
      'Fix the flaky test'
    );
    assert.equal(resolveTaskTitle(undefined, '```ts\nconst x = 1;\n```'), 'Untitled task');
    assert.equal(resolveTaskTitle(undefined, '```\nnpm test\n```'), 'Untitled task');
    // An unclosed fence swallows the rest: there is no prose to title from.
    assert.equal(resolveTaskTitle(undefined, '```ts\nconst x = 1;'), 'Untitled task');
  });

  it('keeps characters that only look like Markdown markers', () => {
    assert.equal(
      resolveTaskTitle(undefined, '-1 is returned for empty input'),
      '-1 is returned for empty input'
    );
    assert.equal(resolveTaskTitle(undefined, '3.14 is parsed as 3'), '3.14 is parsed as 3');
    // A marker without whitespace after it is content, not decoration.
    assert.equal(resolveTaskTitle(undefined, '###Fix the parser'), '###Fix the parser');
    // A leading bold span is emphasis around the title, not part of it.
    assert.equal(resolveTaskTitle(undefined, '**Fix** the parser'), 'Fix the parser');
  });

  it('skips blank leading lines before deriving the title', () => {
    assert.equal(resolveTaskTitle(undefined, '\n\n   \n## Fix the parser\nbody'), 'Fix the parser');
    // A prompt that is nothing but decoration has no title to offer.
    assert.equal(resolveTaskTitle(undefined, '##\n\n-   \n'), 'Untitled task');
  });

  it('collapses whitespace in a derived title and drops trailing Markdown emphasis', () => {
    assert.equal(resolveTaskTitle(undefined, '   Fix    the    parser   '), 'Fix the parser');
    assert.equal(resolveTaskTitle(undefined, '**Fix the parser**'), 'Fix the parser');
  });

  it('clips a long title at a word boundary with a single ellipsis', () => {
    const clipped = resolveTaskTitle('Fix the parser and the scheduler', 'ignored', 20);

    assert.equal(clipped, 'Fix the parser and…');
    assert.equal(clipped.endsWith('…'), true);
    assert.equal(clipped.includes('...'), false);
    assert.equal(clipped.length <= 20, true);
  });

  it('never exceeds a custom maxLen, even for one unbroken word', () => {
    assert.equal(resolveTaskTitle('A short title', 'ignored', 8), 'A short…');
    assert.equal(resolveTaskTitle('A short title', 'ignored', 8).length, 8);

    const clippedWord = resolveTaskTitle(undefined, 'x'.repeat(30), 10);
    assert.equal(clippedWord.length, 10);
    assert.equal(clippedWord.endsWith('…'), true);
  });

  it('clips the default 72-character budget at a word boundary', () => {
    const prompt = `${'word '.repeat(20)}tail`;
    const title = resolveTaskTitle(undefined, prompt);

    assert.equal(title.length <= 72, true);
    assert.equal(title.endsWith('…'), true);
    // The clip lands after a whole word, never mid-word.
    assert.equal(/^word(?: word)*…$/.test(title), true, `unexpected clip: ${title}`);
  });

  it('falls back to Untitled task only when neither title nor prompt carries text', () => {
    for (const [title, prompt] of [
      [undefined, undefined],
      [null, null],
      ['', ''],
      ['   ', '   '],
      ['\n\t', '\n\n  \n'],
      [undefined, null],
    ] as const) {
      assert.equal(
        resolveTaskTitle(title, prompt),
        'Untitled task',
        `expected fallback for ${JSON.stringify([title, prompt])}`
      );
    }
  });
});
