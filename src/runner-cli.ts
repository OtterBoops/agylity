import os from 'node:os';
import { logger } from './logs/logger.js';
import { RemoteSwarmRunner } from './coordinator/runner.js';
import type { BotPrPolicy } from './config/schema.js';

export interface RunnerCliOptions {
  coordinatorUrl: string;
  registrationToken?: string;
  runnerToken?: string;
  sharedSecret?: string;
  runnerId?: string;
  runnerName?: string;
  labels: string[];
  repositories?: string[];
  runnerStatePath: string;
  agyBinPath: string;
  pollTimeoutMs: number;
  idlePollIntervalMs: number;
  botPrPolicy?: BotPrPolicy;
}

const parseCsvList = (value?: string): string[] => {
  if (!value || value.trim() === '') return [];
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
};

export const parseRunnerCliArgs = (
  argv: string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env
): RunnerCliOptions => {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i]!;
    if (raw.startsWith('--')) {
      const eqIdx = raw.indexOf('=');
      if (eqIdx !== -1) {
        args[raw.slice(2, eqIdx)] = raw.slice(eqIdx + 1);
      } else {
        const next = argv[i + 1];
        if (next && !next.startsWith('--')) {
          args[raw.slice(2)] = next;
          i++;
        } else {
          args[raw.slice(2)] = 'true';
        }
      }
    }
  }

  const coordinatorUrl = (
    args.url ||
    args['coordinator-url'] ||
    env.COORDINATOR_URL ||
    env.AGYLITY_COORDINATOR_URL ||
    'http://127.0.0.1:8484'
  ).trim();

  const rawToken = (
    args.token ||
    args['registration-token'] ||
    env.REGISTRATION_TOKEN ||
    env.AGYLITY_REGISTRATION_TOKEN ||
    ''
  ).trim();

  const rawRunnerToken = (
    args['runner-token'] ||
    env.RUNNER_TOKEN ||
    env.AGYLITY_RUNNER_TOKEN ||
    ''
  ).trim();

  // Auto-detect whether --token / REGISTRATION_TOKEN is a one-time agyr_reg_ token or persistent agyr_run_ token
  const registrationToken = rawToken.startsWith('agyr_reg_')
    ? rawToken
    : !rawRunnerToken && rawToken && !rawToken.startsWith('agyr_run_')
      ? rawToken
      : undefined;

  const runnerToken = rawRunnerToken || (rawToken.startsWith('agyr_run_') ? rawToken : undefined);

  const sharedSecret = (args.secret || env.RUNNER_SHARED_SECRET || '').trim() || undefined;
  const runnerId = (args.id || args['runner-id'] || env.RUNNER_ID || '').trim() || undefined;
  const runnerName =
    (args.name || args['runner-name'] || env.RUNNER_NAME || os.hostname()).trim() || os.hostname();

  const labels = parseCsvList(args.labels || env.RUNNER_LABELS);
  const repoList = parseCsvList(args.repos || args.repositories || env.RUNNER_REPOSITORIES);

  const runnerStatePath = (
    args.state ||
    args['state-path'] ||
    env.RUNNER_STATE_PATH ||
    'data/runner.json'
  ).trim();

  const agyBinPath = (args['agy-bin'] || env.AGY_BIN_PATH || 'agy').trim();
  const pollTimeoutMs = Number(env.RUNNER_POLL_TIMEOUT_MS ?? 25000);
  const idlePollIntervalMs = Number(env.RUNNER_IDLE_INTERVAL_MS ?? 2000);
  const botPrPolicy = (args['bot-pr-policy'] || env.BOT_PR_POLICY || '').trim() as
    BotPrPolicy | undefined;

  return {
    coordinatorUrl,
    registrationToken,
    runnerToken,
    sharedSecret,
    runnerId,
    runnerName,
    labels,
    repositories: repoList.length > 0 ? repoList : undefined,
    runnerStatePath,
    agyBinPath,
    pollTimeoutMs: Number.isFinite(pollTimeoutMs) ? pollTimeoutMs : 25000,
    idlePollIntervalMs: Number.isFinite(idlePollIntervalMs) ? idlePollIntervalMs : 2000,
    botPrPolicy: botPrPolicy || undefined,
  };
};

export const runRunnerCli = async (): Promise<void> => {
  // Never swap agy out from under a running task; the entrypoint refreshes it before this runs.
  process.env.AGY_CLI_DISABLE_AUTO_UPDATE = 'true';

  const log = logger.child('runner-cli');
  const opts = parseRunnerCliArgs();

  log.info(
    '[Notice] Starting Agylity Swarm Runner "%s" (coordinator=%s, state=%s)',
    opts.runnerName ?? 'runner',
    opts.coordinatorUrl,
    opts.runnerStatePath
  );

  const runner = new RemoteSwarmRunner({
    coordinatorUrl: opts.coordinatorUrl,
    registrationToken: opts.registrationToken,
    runnerToken: opts.runnerToken,
    sharedSecret: opts.sharedSecret,
    runnerId: opts.runnerId,
    runnerName: opts.runnerName,
    labels: opts.labels,
    repositories: opts.repositories,
    runnerStatePath: opts.runnerStatePath,
    agyBinPath: opts.agyBinPath,
    pollTimeoutMs: opts.pollTimeoutMs,
    idlePollIntervalMs: opts.idlePollIntervalMs,
    botPrPolicy: opts.botPrPolicy,
    logger: log,
  });

  const handleShutdown = (sig: string) => {
    log.info('[Notice] Received %s, stopping Agylity Swarm Runner...', sig);
    runner.stop();
  };

  process.once('SIGINT', () => handleShutdown('SIGINT'));
  process.once('SIGTERM', () => handleShutdown('SIGTERM'));

  await runner.start();
};

const isDirectEntry =
  process.argv[1] &&
  (process.argv[1].endsWith('runner-cli.js') || process.argv[1].endsWith('runner-cli.ts'));

if (isDirectEntry) {
  runRunnerCli().catch((err) => {
    logger.error('[Error] Agylity Swarm Runner fatal error: %s', err?.message ?? String(err));
    process.exitCode = 1;
  });
}
