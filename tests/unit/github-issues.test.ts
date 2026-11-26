import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { removeIssueLabel } from '../../src/coordinator/githubIssues.js';

describe('Coordinator: backlog issue label lifecycle', () => {
  it('removes the label through the gh CLI when the coordinator has no token', async () => {
    const calls: string[][] = [];
    const outcome = await removeIssueLabel({
      repoSlug: 'OtterBoops/agylity',
      issueNumber: 25,
      label: 'backlog',
      execFileFn: (async (file: string, args: string[]) => {
        calls.push([file, ...args]);
        return { stdout: '', stderr: '' };
      }) as never,
    });

    assert.equal(outcome, 'cli');
    assert.deepEqual(calls[0], [
      'gh',
      'issue',
      'edit',
      '25',
      '--repo',
      'OtterBoops/agylity',
      '--remove-label',
      'backlog',
    ]);
  });

  it('reports a failure instead of throwing when the CLI rejects', async () => {
    const outcome = await removeIssueLabel({
      repoSlug: 'OtterBoops/agylity',
      issueNumber: 25,
      label: 'backlog',
      execFileFn: (async () => {
        throw new Error('no such issue');
      }) as never,
    });

    assert.equal(outcome, 'failed');
  });
});
