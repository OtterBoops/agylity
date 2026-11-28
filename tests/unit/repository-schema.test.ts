import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RepositoriesJsonSchema } from '../../src/config/env.js';

test('derives repository id and name from a clone URL with a trailing slash', () => {
  const [plain] = RepositoriesJsonSchema.parse([{ cloneUrl: 'https://github.com/owner/repo' }]);
  const [slashed] = RepositoriesJsonSchema.parse([{ cloneUrl: 'https://github.com/owner/repo/' }]);
  const [slashedGit] = RepositoriesJsonSchema.parse([
    { cloneUrl: 'https://github.com/owner/repo.git/' },
  ]);

  for (const repo of [plain, slashed, slashedGit]) {
    assert.equal(repo?.id, 'repo');
    assert.equal(repo?.name, 'owner/repo');
    assert.equal(repo?.path, '/repos/repo');
  }
});
