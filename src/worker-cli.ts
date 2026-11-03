import os from 'node:os';
import { logger } from './logs/logger.js';
import { RemoteSwarmWorker } from './orchestrator/worker.js';

export interface WorkerCliOptions {
  coordinatorUrl: string;
  registrationToken?: string;
  runnerToken?: string;
  sharedSecret?: string;
  workerId?: string;
  workerName?: string;
  labels: string[];
  repositories?: string[];
  runnerStatePath: string;
  agyBinPath: string;
  pollTimeoutMs: number;
  idlePollIntervalMs: number;
}

const parseCsvList = (value?: string): string[] => {
  if (!value || value.trim() === '') return [];
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
};

export const parseWorkerCliArgs = (
  argv: string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env
): WorkerCliOptions => {
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

  const sharedSecret = (args.secret || env.WORKER_SHARED_SECRET || '').trim() || undefined;
  const workerId = (args.id || args['worker-id'] || env.WORKER_ID || '').trim() || undefined;
  const workerName =
    (args.name || args['worker-name'] || env.WORKER_NAME || os.hostname()).trim() || os.hostname();

  const labels = parseCsvList(args.labels || env.WORKER_LABELS);
  const repoList = parseCsvList(args.repos || args.repositories || env.WORKER_REPOSITORIES);

  const runnerStatePath = (
    args.state ||
    args['state-path'] ||
    env.RUNNER_STATE_PATH ||
    'data/runner.json'
  ).trim();

  const agyBinPath = (args['agy-bin'] || env.AGY_BIN_PATH || 'agy').trim();
  const pollTimeoutMs = Number(env.WORKER_POLL_TIMEOUT_MS ?? 25000);
  const idlePollIntervalMs = Number(env.WORKER_IDLE_INTERVAL_MS ?? 2000);

  return {
    coordinatorUrl,
    registrationToken,
    runnerToken,
    sharedSecret,
    workerId,
    workerName,
    labels,
    repositories: repoList.length > 0 ? repoList : undefined,
    runnerStatePath,
    agyBinPath,
    pollTimeoutMs: Number.isFinite(pollTimeoutMs) ? pollTimeoutMs : 25000,
    idlePollIntervalMs: Number.isFinite(idlePollIntervalMs) ? idlePollIntervalMs : 2000,
  };
};

export const runWorkerCli = async (): Promise<void> => {
  // Never swap agy out from under a running task; the entrypoint refreshes it before this runs.
  process.env.AGY_CLI_DISABLE_AUTO_UPDATE = 'true';

  const log = logger.child('runner-cli');
  const opts = parseWorkerCliArgs();

  log.info(
    '[Notice] Starting Agylity Swarm Runner "%s" (coordinator=%s, state=%s)',
    opts.workerName ?? 'runner',
    opts.coordinatorUrl,
    opts.runnerStatePath
  );

  const worker = new RemoteSwarmWorker({
    coordinatorUrl: opts.coordinatorUrl,
    registrationToken: opts.registrationToken,
    runnerToken: opts.runnerToken,
    sharedSecret: opts.sharedSecret,
    workerId: opts.workerId,
    workerName: opts.workerName,
    labels: opts.labels,
    repositories: opts.repositories,
    runnerStatePath: opts.runnerStatePath,
    agyBinPath: opts.agyBinPath,
    pollTimeoutMs: opts.pollTimeoutMs,
    idlePollIntervalMs: opts.idlePollIntervalMs,
    logger: log,
  });

  const handleShutdown = (sig: string) => {
    log.info('[Notice] Received %s, stopping Agylity Swarm Runner...', sig);
    worker.stop();
  };

  process.once('SIGINT', () => handleShutdown('SIGINT'));
  process.once('SIGTERM', () => handleShutdown('SIGTERM'));

  await worker.start();
};

const isDirectEntry =
  process.argv[1] &&
  (process.argv[1].endsWith('worker-cli.js') || process.argv[1].endsWith('worker-cli.ts'));

if (isDirectEntry) {
  runWorkerCli().catch((err) => {
    logger.error('[Error] Agylity Swarm Runner fatal error: %s', err?.message ?? String(err));
    process.exitCode = 1;
  });
}
