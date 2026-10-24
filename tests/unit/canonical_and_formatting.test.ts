import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import prettier from 'prettier';
import { checkCanonicalClasses } from '../../scripts/check-canonical-classes.mjs';

describe('Tailwind CSS Canonicalization & Prettier Class Sorting Invariants', () => {
  it('enforces that all utility classes across frontend components are strictly canonical', async () => {
    const result = await checkCanonicalClasses(path.resolve('.'));
    if (!result.passed) {
      const details = result.diffs
        .map((d) => `  [${d.file}]\n    Current:   ${d.original}\n    Canonical: ${d.canonical}`)
        .join('\n');
      assert.fail(`Found non-canonical Tailwind utility classes:\n${details}`);
    }
    assert.equal(result.passed, true);
  });

  it('enforces that all frontend source files match Prettier formatting and automatic class sorting', async () => {
    const config = (await prettier.resolveConfig('./prettier.config.mjs')) || {};
    const frontendSrc = path.resolve('frontend/src');

    function getFiles(dir) {
      let files: string[] = [];
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          files = files.concat(getFiles(full));
        } else if (/\.(tsx|ts|html|css)$/.test(entry.name)) {
          files.push(full);
        }
      }
      return files;
    }

    const files = getFiles(frontendSrc);
    const unformatted: string[] = [];

    for (const file of files) {
      const content = fs.readFileSync(file, 'utf8');
      const isFormatted = await prettier.check(content, {
        ...config,
        filepath: file,
      });
      if (!isFormatted) {
        unformatted.push(path.relative('.', file));
      }
    }

    if (unformatted.length > 0) {
      assert.fail(
        `Files not formatted according to Prettier and automatic Tailwind class sorting:\n${unformatted.map((f) => `  - ${f}`).join('\n')}\nRun 'npm run format' to fix.`
      );
    }

    assert.equal(unformatted.length, 0);
  });
});
