import os from 'node:os';
import { logger } from './logs/logger.js';
import { RemoteSwarmRunner, normalizePrPolicy } from './runner/index.js';
import type { PrPolicy } from './config/schema.js';

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
  prPolicy?: PrPolicy;
}

const parseCsvList = (value?: string): string[] => {
  if (!value || value.trim() === '') return [];
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
};

// A URL missing its scheme fails every poll with the same opaque fetch error, so settle it at boot.
const normalizeCoordinatorUrl = (raw: string): string => {
  const trimmed = raw.trim() || 'http://127.0.0.1:8484';
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  return new URL(withScheme).toString().replace(/\/+$/, '');
};

// A blank value is not a value: compose emits '' for an unset var, and Number('') is 0, which
// disables long-polling and leaves the poll loop never sleeping.
const readIntervalMs = (raw: string | undefined, fallback: number): number => {
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
};

export const parseRunnerCliArgs = (
  argv: string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env
): RunnerCliOptions => {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i]!;
    if (!raw.startsWith('--')) continue;

    const eqIdx = raw.indexOf('=');
    if (eqIdx !== -1) {
      args[raw.slice(2, eqIdx)] = raw.slice(eqIdx + 1);
      continue;
    }

    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      args[raw.slice(2)] = next;
      i++;
    } else {
      args[raw.slice(2)] = 'true';
    }
  }

  const rawCoordinatorUrl =
    args.url ||
    args['coordinator-url'] ||
    env.COORDINATOR_URL ||
    env.AGYLITY_COORDINATOR_URL ||
    'http://127.0.0.1:8484';
  let coordinatorUrl: string;
  try {
    coordinatorUrl = normalizeCoordinatorUrl(rawCoordinatorUrl);
  } catch {
    throw new Error(`Coordinator URL is not a valid URL: "${rawCoordinatorUrl}"`);
  }

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

  // One variable can carry either credential, so the prefix decides which one was supplied.
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
    pollTimeoutMs: readIntervalMs(env.RUNNER_POLL_TIMEOUT_MS, 25000),
    idlePollIntervalMs: readIntervalMs(env.RUNNER_IDLE_INTERVAL_MS, 2000),
    // An unrecognised policy must not reach the bot guards as "anything goes"; unknown inherits.
    prPolicy: normalizePrPolicy(args['pr-policy'] || env.PR_POLICY) ?? undefined,
  };
};

const SHUTDOWN_GRACE_MS = 8000;

export const runRunnerCli = async (): Promise<void> => {
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
    prPolicy: opts.prPolicy,
    logger: log,
  });

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) {
      log.warn('[Notice] %s received again; exiting now', signal);
      process.exit(0);
    }
    shuttingDown = true;
    log.info('[Notice] Received %s, stopping Agylity Swarm Runner...', signal);
    runner.stop();
    // Docker sends SIGKILL 10s after SIGTERM, so a wedged subprocess must not hold the container open.
    const watchdog = setTimeout(() => {
      log.warn(
        '[Notice] In-flight task did not stop within %dms; exiting with it',
        SHUTDOWN_GRACE_MS
      );
      process.exit(0);
    }, SHUTDOWN_GRACE_MS);
    watchdog.unref();
  };

  const onSigint = (): void => shutdown('SIGINT');
  const onSigterm = (): void => shutdown('SIGTERM');
  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigterm);

  try {
    await runner.start();
  } finally {
    process.off('SIGINT', onSigint);
    process.off('SIGTERM', onSigterm);
  }
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
