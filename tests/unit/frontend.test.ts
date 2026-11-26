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
const quota = await importClient('../../frontend/src/utils/quota.ts');

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
const resetWindowState = quota.resetWindowState as (
  rawResetTime: string | null | undefined,
  nowMs: number
) => string;
const resetWindowLabel = quota.resetWindowLabel as (
  rawResetTime: string | null | undefined,
  nowMs: number,
  verb?: 'Resets' | 'Refreshes'
) => string;
const resetDateLabel = quota.resetDateLabel as (rawResetTime: string | null | undefined) => string;
const quotaStatus = quota.quotaStatus as (input: {
  weeklyPercent: number;
  shortTermPercent: number | null;
  minHeadroomPercent: number;
  weeklyHours: number;
  windowActive: boolean;
}) => { tone: string; text: string };

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

describe('Frontend: quota reset-window helpers', () => {
  const EPOCH_ZERO = '1970-01-01T00:00:00Z';
  const NOW_MS = Date.parse('2026-11-14T12:00:00Z');

  it('reads the epoch placeholder as an unstarted window, never as a passed deadline', () => {
    assert.equal(resetWindowState(EPOCH_ZERO, NOW_MS), 'unset');
    // Every other way of saying "no deadline" lands on the same state.
    assert.equal(resetWindowState('', NOW_MS), 'unset');
    assert.equal(resetWindowState(null, NOW_MS), 'unset');
    assert.equal(resetWindowState(undefined, NOW_MS), 'unset');
    assert.equal(resetWindowState('not-a-date', NOW_MS), 'unset');

    // Both verbs describe an idle pool the same way; neither counts anything down.
    assert.equal(resetWindowLabel(EPOCH_ZERO, NOW_MS, 'Resets'), 'Starts on first use');
    assert.equal(resetWindowLabel(EPOCH_ZERO, NOW_MS, 'Refreshes'), 'Starts on first use');
    assert.equal(resetDateLabel(EPOCH_ZERO), '');
  });

  it('counts down a live deadline and phrases an expired one without stacking verbs', () => {
    const inTwoHours = new Date(NOW_MS + 2 * 3600 * 1000).toISOString();
    assert.equal(resetWindowState(inTwoHours, NOW_MS), 'counting');
    assert.equal(resetWindowLabel(inTwoHours, NOW_MS), 'Resets in 2h 0m');

    const past = new Date(NOW_MS - 60_000).toISOString();
    assert.equal(resetWindowState(past, NOW_MS), 'now');
    // The label owns the verb, so an expired window must read "Resetting now".
    assert.equal(resetWindowLabel(past, NOW_MS), 'Resetting now');
    assert.equal(resetWindowLabel(past, NOW_MS, 'Refreshes'), 'Refreshing now');
  });

  it('calls a full pool whose window never opened idle instead of wasting quota', () => {
    const unstarted = quotaStatus({
      weeklyPercent: 100,
      shortTermPercent: null,
      minHeadroomPercent: 10,
      weeklyHours: 0,
      windowActive: false,
    });
    assert.equal(unstarted.text, 'Idle');
    assert.equal(unstarted.tone, 'idle');
    assert.notEqual(unstarted.text, 'Use it or lose it');

    // The same figures on a window that has started are an expiring balance.
    const expiring = quotaStatus({
      weeklyPercent: 100,
      shortTermPercent: null,
      minHeadroomPercent: 10,
      weeklyHours: 2,
      windowActive: true,
    });
    assert.equal(expiring.text, 'Use it or lose it');
    assert.equal(expiring.tone, 'urgent');
  });

  it('treats the headroom floor as a strict lower bound rather than engaging at equality', () => {
    const atFloor = quotaStatus({
      weeklyPercent: 10,
      shortTermPercent: null,
      minHeadroomPercent: 10,
      weeklyHours: 20,
      windowActive: true,
    });
    assert.equal(atFloor.tone, 'spent');
    assert.equal(atFloor.text, 'Well spent');

    const belowFloor = quotaStatus({
      weeklyPercent: 9,
      shortTermPercent: null,
      minHeadroomPercent: 10,
      weeklyHours: 20,
      windowActive: true,
    });
    assert.equal(belowFloor.tone, 'floor');
    assert.equal(belowFloor.text, 'Safety floor');

    // A short-term window sitting exactly at the floor is not in burst cooldown.
    const shortTermAtFloor = quotaStatus({
      weeklyPercent: 50,
      shortTermPercent: 10,
      minHeadroomPercent: 10,
      weeklyHours: 20,
      windowActive: true,
    });
    assert.notEqual(shortTermAtFloor.tone, 'burst');

    const shortTermBelowFloor = quotaStatus({
      weeklyPercent: 10,
      shortTermPercent: 9,
      minHeadroomPercent: 10,
      weeklyHours: 20,
      windowActive: true,
    });
    assert.equal(shortTermBelowFloor.tone, 'burst');
    assert.equal(shortTermBelowFloor.text, '5h Burst Cooldown');

    // A floor above 25% must not mislabel a pool sitting exactly at the floor as "Well spent".
    const highFloorAtBoundary = quotaStatus({
      weeklyPercent: 50,
      shortTermPercent: null,
      minHeadroomPercent: 50,
      weeklyHours: 20,
      windowActive: true,
    });
    assert.equal(highFloorAtBoundary.tone, 'ready');
    assert.equal(highFloorAtBoundary.text, 'Ready to burn');
  });
});

describe('Dashboard client: runner polling', () => {
  it('surfaces a failed poll instead of reporting an empty fleet', async () => {
    const api = await importClient('../../frontend/src/api.ts');
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response('{"error":"boom"}', { status: 500 })) as unknown as typeof fetch;

    try {
      await assert.rejects(api.getRunners(), 'a 500 must not read as "no runners registered"');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
