import { run } from 'node:test';
import { spec } from 'node:test/reporters';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const runAllE2ETests = async (): Promise<boolean> => {
  console.log('====================================================');
  console.log('   AGYLITY OPAQUE-BOX E2E TEST SUITE (TIERS 1 - 4)  ');
  console.log('====================================================\n');

  const files = [
    // Tier 1: Feature Coverage (Features 1-25)
    path.join(__dirname, 'tier1_features', 'config_persistence.test.ts'),
    path.join(__dirname, 'tier1_features', 'quota_sentry.test.ts'),
    path.join(__dirname, 'tier1_features', 'notification_discord.test.ts'),
    path.join(__dirname, 'tier1_features', 'remote_orchestrator.test.ts'),
    path.join(__dirname, 'tier1_features', 'web_ui_lifecycle.test.ts'),

    // Tier 2: Boundary & Corner Cases
    path.join(__dirname, 'tier2_boundaries', 'config_boundaries.test.ts'),
    path.join(__dirname, 'tier2_boundaries', 'quota_boundaries.test.ts'),
    path.join(__dirname, 'tier2_boundaries', 'discord_boundaries.test.ts'),
    path.join(__dirname, 'tier2_boundaries', 'remote_boundaries.test.ts'),
    path.join(__dirname, 'tier2_boundaries', 'web_boundaries.test.ts'),

    // Tier 3: Cross-Feature Interactions
    path.join(__dirname, 'tier3_combinations', 'cross_feature.test.ts'),

    // Tier 4: Real-World Application Scenarios
    path.join(__dirname, 'tier4_application', 'scenarios.test.ts'),
  ];

  const stream = run({
    files,
    concurrency: 1, // Sequential execution for deterministic isolation
  });

  stream.compose(new spec()).pipe(process.stdout);

  return new Promise<boolean>((resolve) => {
    stream.on('test:fail', () => {
      // Stream encountered failure
    });
    stream.on('end', () => {
      resolve(true);
    });
  });
};

// Allow direct execution: node --import tsx tests/e2e/runner.ts
if (process.argv[1] === __filename) {
  runAllE2ETests().catch((err) => {
    console.error('E2E Test Runner failed:', err);
    process.exit(1);
  });
}
