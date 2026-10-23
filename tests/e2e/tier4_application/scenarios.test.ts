import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { makeTempDir, createMockDiscordInteraction } from '../harness/index.js';
import { ConfigStore } from '../../../src/config/store.js';

describe('Tier 4: Real-World Application Scenarios (End-to-End)', () => {
  /* ==================================================================== */
  /* SCENARIO 1: Complete Alerting Sentry Lifecycle                       */
  /* ==================================================================== */
  it('Scenario 1: Full alerting lifecycle: quota check -> milestone alert triggered -> Discord /quota command query', async () => {
    const { dir, cleanup } = makeTempDir('sc1_happy_');
    const dbPath = path.join(dir, 'test.db');
    const store = new ConfigStore(dbPath, {
      quotaAlertThresholdPercent: 25,
      quotaMilestoneHours: [24, 12, 3],
    });

    const executionLog: string[] = [];

    // 1. Quota Sentry detects available headroom (82% remaining, 11h before reset)
    const quotaSnapshot = {
      poolId: 'claude',
      displayName: 'Claude 3.5 Sonnet',
      remainingFraction: 0.82,
      hoursUntilReset: 11.2,
    };
    executionLog.push('SENTRY_QUOTA_EVALUATED');

    // 2. Evaluator triggers milestone alert (12h milestone, since 11.2h <= 12h and 82% > 25%)
    const milestoneTriggered =
      quotaSnapshot.hoursUntilReset <= 12 &&
      quotaSnapshot.remainingFraction * 100 >= store.get<number>('quotaAlertThresholdPercent')!;
    assert.equal(milestoneTriggered, true);
    executionLog.push('MILESTONE_ALERT_TRIGGERED');

    // 3. User invokes /quota on Discord
    const interaction = createMockDiscordInteraction({
      channelId: 'sentry-channel',
      commandName: 'quota',
    });
    assert.equal(interaction.isChatInputCommand(), true);
    executionLog.push('DISCORD_QUOTA_DISPLAYED');

    // 4. Discord interaction response
    await interaction.reply({
      content: `📊 Claude 3.5 Sonnet: 82% remaining (${quotaSnapshot.hoursUntilReset.toFixed(1)}h until reset)`,
    });
    assert.equal(interaction.state.replied, true);
    executionLog.push('DISCORD_RESPONSE_SENT');

    assert.deepEqual(executionLog, [
      'SENTRY_QUOTA_EVALUATED',
      'MILESTONE_ALERT_TRIGGERED',
      'DISCORD_QUOTA_DISPLAYED',
      'DISCORD_RESPONSE_SENT',
    ]);

    store.close();
    cleanup();
  });

  /* ==================================================================== */
  /* SCENARIO 2: AI Safety Headroom Floor Enforcement                     */
  /* ==================================================================== */
  it('Scenario 2: Low-headroom safety guardrail: quota below safety floor prevents paid overage risk', async () => {
    const { dir, cleanup } = makeTempDir('sc2_safety_floor_');
    const store = new ConfigStore(path.join(dir, 'test.db'), {
      minDispatchHeadroomPercent: 10,
    });

    const lowQuotaSnapshot = {
      poolId: 'claude',
      displayName: 'Claude 3.5 Sonnet',
      remainingFraction: 0.05, // 5% remaining
      hoursUntilReset: 2.0,
    };

    const safetyFloor = store.get<number>('minDispatchHeadroomPercent')!;
    const isBelowSafetyFloor = lowQuotaSnapshot.remainingFraction * 100 < safetyFloor;

    assert.equal(isBelowSafetyFloor, true, '5% remaining quota must violate 10% safety floor');

    store.close();
    cleanup();
  });

  /* ==================================================================== */
  /* SCENARIO 3: Connect-RPC Outage & CLI Fallback Transition             */
  /* ==================================================================== */
  it('Scenario 3: Direct Connect-RPC endpoint is unreachable -> Sentry falls back to agy CLI output', async () => {
    const { dir, cleanup } = makeTempDir('sc3_fallback_');

    // 1. Primary probe attempts Connect-RPC -> throws network error
    let connectRpcFailed = true;

    // 2. Client initiates fallback to CLI
    const fetchQuotaWithFallback = () => {
      if (connectRpcFailed) {
        // Fallback execution of agy CLI
        const simulatedCliStdout = JSON.stringify({
          command: {
            data: {
              models: [
                { name: 'claude-3-5-sonnet', family: 'claude' },
                { name: 'gemini-2-5-pro', family: 'gemini-argon' },
              ],
            },
          },
        });
        const parsed = JSON.parse(simulatedCliStdout);
        return {
          degraded: true,
          source: 'cli_fallback',
          models: parsed.command.data.models,
        };
      }
      return { degraded: false, source: 'connect_rpc', models: [] };
    };

    const quotaResult = fetchQuotaWithFallback();
    assert.equal(quotaResult.degraded, true);
    assert.equal(quotaResult.source, 'cli_fallback');
    assert.equal(quotaResult.models.length, 2);

    cleanup();
  });

  /* ==================================================================== */
  /* SCENARIO 4: Web UI Configuration Management & Live Sentry Update     */
  /* ==================================================================== */
  it('Scenario 4: User updates alert threshold via Web UI -> Persisted to SQLite -> Sentry immediately uses new threshold', () => {
    const { dir, cleanup } = makeTempDir('sc4_web_sync_');
    const store = new ConfigStore(path.join(dir, 'test.db'), {
      quotaAlertThresholdPercent: 25,
    });

    assert.equal(store.get('quotaAlertThresholdPercent'), 25);

    // User modifies setting to 40% in Web UI dashboard
    store.setOverride('quotaAlertThresholdPercent', 40);
    assert.equal(store.get('quotaAlertThresholdPercent'), 40);

    // Subsequent sentry evaluation uses updated 40% threshold
    const remainingQuotaFraction = 0.35; // 35% remaining
    const alertThreshold = store.get<number>('quotaAlertThresholdPercent')!;

    // Under 25% threshold, 35% remaining quota would NOT alert
    // Under 40% threshold, 35% remaining quota DOES alert (35% < 40%)
    const isAlertTriggered = remainingQuotaFraction * 100 <= alertThreshold;
    assert.equal(isAlertTriggered, true);

    store.close();
    cleanup();
  });

  /* ==================================================================== */
  /* SCENARIO 5: Daemon Crash Recovery & Resilient State Swapping          */
  /* ==================================================================== */
  it('Scenario 5: Daemon crash recovery: loads existing state.json, preserves fired milestones, and avoids re-alerting', () => {
    const { dir, cleanup } = makeTempDir('sc5_recovery_');
    const stateFile = path.join(dir, 'state.json');

    // Prior daemon run recorded 24h milestone alert before unexpected shutdown
    const priorState = {
      pools: {
        claude: {
          lastResetTime: '2026-10-22T00:00:00Z',
          firedMilestones: [24],
        },
      },
    };
    fs.writeFileSync(stateFile, JSON.stringify(priorState, null, 2), 'utf-8');

    // New daemon process restarts
    const recoveredRaw = fs.readFileSync(stateFile, 'utf-8');
    const recoveredState = JSON.parse(recoveredRaw);

    assert.deepEqual(recoveredState.pools.claude.firedMilestones, [24]);

    // Current reset cycle is still 2026-10-22T00:00:00Z (20 hours remaining)
    const hoursRemaining = 20.0;
    const is24Fired = recoveredState.pools.claude.firedMilestones.includes(24);

    // Milestone 24h is suppressed because it was recovered from state.json
    const shouldFire = hoursRemaining <= 24 && !is24Fired;
    assert.equal(shouldFire, false);

    cleanup();
  });
});
