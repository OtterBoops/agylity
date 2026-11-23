import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

/*
 * The dashboard is compiled with bundler module resolution, so its sources cannot join this
 * NodeNext program: a computed specifier keeps these imports runtime-only while still exercising
 * the real client modules. The client's own `tsc` still type-checks them.
 */
const importClient = (specifier: string): Promise<Record<string, any>> => import(specifier);

const status = await importClient('../../frontend/src/utils/status.ts');
const statusLabels = await importClient('../../frontend/src/components/tasks/statusLabels.ts');
const executionRow = await importClient('../../frontend/src/components/tasks/executionRow.ts');

interface DisplayInput {
  status: string;
  prUrl?: string | null;
  issueUrls?: string[] | null;
}

const toneBadgeClass = status.toneBadgeClass as (tone: string) => string;
const taskStatusBadgeClass = status.taskStatusBadgeClass as (value: string) => string;
const isIssueFiledTask = statusLabels.isIssueFiledTask as (task: DisplayInput) => boolean;
const statusLabel = statusLabels.statusLabel as (value: string) => string;
const taskDisplayStatusLabel = statusLabels.taskDisplayStatusLabel as (
  task: DisplayInput
) => string;
const taskDisplayBadgeClass = statusLabels.taskDisplayBadgeClass as (task: DisplayInput) => string;
const taskDisplayDotTextClass = statusLabels.taskDisplayDotTextClass as (
  task: DisplayInput
) => string;
const githubIssueLabel = executionRow.githubIssueLabel as (url: string) => string;
const githubPrLabel = executionRow.githubPrLabel as (url: string) => string;

describe('Frontend: derived issue-filed display status', () => {
  it('treats only a completed run with issues and no PR as an issue deliverable', () => {
    assert.equal(
      isIssueFiledTask({
        status: 'completed',
        prUrl: undefined,
        issueUrls: ['https://github.com/o/r/issues/1'],
      }),
      true
    );
    // A PR is the deliverable when there is one.
    assert.equal(
      isIssueFiledTask({
        status: 'completed',
        prUrl: 'https://github.com/o/r/pull/2',
        issueUrls: ['https://github.com/o/r/issues/1'],
      }),
      false
    );
    assert.equal(isIssueFiledTask({ status: 'completed', issueUrls: [] }), false);
    assert.equal(
      isIssueFiledTask({ status: 'failed', issueUrls: ['https://github.com/o/r/issues/1'] }),
      false
    );
    assert.equal(isIssueFiledTask({ status: 'completed' }), false);
  });

  it('labels one issue, several issues, and everything else', () => {
    assert.equal(
      taskDisplayStatusLabel({
        status: 'completed',
        issueUrls: ['https://github.com/o/r/issues/1'],
      }),
      'Issue Filed'
    );
    assert.equal(
      taskDisplayStatusLabel({
        status: 'completed',
        issueUrls: ['https://github.com/o/r/issues/1', 'https://github.com/o/r/issues/2'],
      }),
      'Issues Filed'
    );
    assert.equal(taskDisplayStatusLabel({ status: 'completed' }), statusLabel('completed'));
    assert.equal(
      taskDisplayStatusLabel({ status: 'completed', prUrl: 'https://github.com/o/r/pull/3' }),
      'Completed'
    );
  });

  it('paints the badge and dot with the iris tone the status tone owns', () => {
    const issueTone = 'border-pine-iris/40 bg-pine-iris/15 text-pine-iris';
    assert.equal(toneBadgeClass('issue'), issueTone);
    assert.equal(
      taskDisplayBadgeClass({
        status: 'completed',
        issueUrls: ['https://github.com/o/r/issues/1'],
      }),
      issueTone
    );
    assert.equal(
      taskDisplayDotTextClass({
        status: 'completed',
        issueUrls: ['https://github.com/o/r/issues/1', 'https://github.com/o/r/issues/2'],
      }),
      'text-pine-iris'
    );
    // A task without an issue deliverable keeps the plain status badge, pulse included.
    assert.equal(taskDisplayBadgeClass({ status: 'executing' }), taskStatusBadgeClass('executing'));
    assert.equal(taskDisplayDotTextClass({ status: 'failed' }), 'text-pine-love');
  });
});

describe('Frontend: GitHub link labels', () => {
  it('shortens an issue URL to its number', () => {
    assert.equal(githubIssueLabel('https://github.com/OtterBoops/agylity/issues/14'), '#14');
    assert.equal(githubIssueLabel('https://github.com/OtterBoops/agylity/issues/14?x=1'), '#14');
  });

  it('labels a pull request with its number, distinct from an issue label', () => {
    assert.equal(githubPrLabel('https://github.com/OtterBoops/agylity/pull/99'), 'PR #99');
    // A tab path appended by the browser must not become the label.
    assert.equal(githubPrLabel('https://github.com/OtterBoops/agylity/pull/99/files'), 'PR #99');
    assert.equal(githubPrLabel(''), '');
  });
});
