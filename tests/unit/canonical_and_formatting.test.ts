import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ESLint } from 'eslint';
import prettier from 'prettier';

describe('Tailwind CSS Canonicalization & Prettier Class Sorting Invariants', () => {
  it('enforces that all utility classes across frontend components are strictly canonical via eslint-plugin-better-tailwindcss', async () => {
    const eslint = new ESLint();
    const results = await eslint.lintFiles(['frontend/src/**/*.{ts,tsx}']);
    const errorResults = results.filter((r) => r.errorCount > 0 || r.warningCount > 0);

    if (errorResults.length > 0) {
      const formatter = await eslint.loadFormatter('stylish');
      const output = await formatter.format(errorResults);
      assert.fail(`Found Tailwind CSS lint violations:\n${output}`);
    }

    assert.equal(errorResults.length, 0);
  });

  it('enforces that all frontend source files match Prettier formatting and automatic class sorting', async () => {
    const config = (await prettier.resolveConfig('./prettier.config.mjs')) || {};
    const frontendSrc = path.resolve('frontend/src');

    const getFiles = (dir: string): string[] => {
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
    };

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
