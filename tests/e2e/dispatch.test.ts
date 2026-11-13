import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import ky from 'ky';
import { ConfigStore } from '../../src/config/store.js';
import { startWebServer, closeWebServer } from '../../src/web/server.js';
import { RemoteSwarmRunner, TaskExecutor } from '../../src/coordinator/runner.js';
import { SentryStateManager } from '../../src/sentry/state.js';
import { defaultExecFileAsync, type ExecFileAsyncFn } from '../../src/sentry/discovery.js';

const execFileAsync = promisify(execFile);

async function runGit(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout.trim();
}

async function main() {
  console.log('[E2E Test] Starting Autonomous Worker & Dispatch Verification...');
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agylity_e2e_dispatch_'));
  const repoDir = path.join(tmpRoot, 'test-target-repo');
  const dbPath = path.join(tmpRoot, 'coordinator.db');
  const runnerStatePath = path.join(tmpRoot, 'runner-state.json');
  const coordinatorStatePath = path.join(tmpRoot, 'coordinator-state.json');

  let serverInstance: any = null;
  let configStore: ConfigStore | null = null;

  try {
    // 1. Initialize a realistic local Git repository fixture
    console.log(`[E2E Test] 1. Initializing Git fixture at: ${repoDir}`);
    fs.mkdirSync(repoDir, { recursive: true });
    await runGit(['init', '-b', 'main'], repoDir);
    await runGit(['config', 'user.name', 'Agylity Tester'], repoDir);
    await runGit(['config', 'user.email', 'test@agylity.local'], repoDir);

    fs.writeFileSync(
      path.join(repoDir, 'README.md'),
      '# Agylity Target Project\n\nInitial repository contents for task testing.\n'
    );
    await runGit(['add', 'README.md'], repoDir);
    await runGit(['commit', '-m', 'Initial base commit'], repoDir);

    const baseRev = await runGit(['rev-parse', 'HEAD'], repoDir);
    const initialBranch = await runGit(['branch', '--show-current'], repoDir);
    console.log(`[E2E Test] Fixture ready on ${initialBranch} (${baseRev.slice(0, 7)})`);

    // 2. Initialize Coordinator & Web Server
    console.log('[E2E Test] 2. Booting Agylity Coordinator & HTTP API...');
    configStore = new ConfigStore(dbPath, {
      coordinatorEnabled: true,
      webUiEnabled: true,
      defaultDispatchModel: 'gemini-3.8-flash',
      defaultDispatchEffort: 'medium',
      repositories: [
        {
          id: 'test-project',
          name: 'Target Project',
          path: repoDir,
          defaultBranch: 'main',
        },
      ],
    });

    // Live telemetry: without it the safety floor fails closed and the claim is refused.
    const sentryState = new SentryStateManager(coordinatorStatePath);
    sentryState.setState({
      version: 1,
      lastProbeAt: new Date().toISOString(),
      lastProbeSource: 'connect_rpc',
      pools: {
        'gemini-flash': {
          resetTime: new Date(Date.now() + 3600000).toISOString(),
          remainingFraction: 0.8,
          firedMilestones: [],
          lastAlertSentAt: null,
        },
      },
    });

    const { server, port } = await startWebServer({
      configStore,
      sentryState,
      host: '127.0.0.1',
      port: 0,
    });
    serverInstance = server;
    const baseUrl = `http://127.0.0.1:${port}`;
    console.log(`[E2E Test] Coordinator listening on ${baseUrl}`);

    // Verify Coordinator models endpoint returns default flash medium
    const modelsRes = await ky.get(`${baseUrl}/api/models`).json<any>();
    console.log(
      `[E2E Test] Models endpoint default: ${modelsRes.defaultModel} (effort: ${modelsRes.defaultEffort})`
    );
    if (modelsRes.defaultModel !== 'gemini-3.8-flash' || modelsRes.defaultEffort !== 'medium') {
      throw new Error(
        `Unexpected default model/effort: ${modelsRes.defaultModel} / ${modelsRes.defaultEffort}`
      );
    }

    // 3. Generate runner registration token
    console.log('[E2E Test] 3. Requesting Runner Registration Token...');
    const tokenRes = await ky
      .post(`${baseUrl}/api/runners/registration-token`, {
        json: {
          nameHint: 'local-runner-1',
          labels: ['local', 'windows'],
        },
      })
      .json<any>();
    console.log(
      `[E2E Test] Registration token received: ${tokenRes.registrationToken.slice(0, 16)}...`
    );

    // 4. Spin up pull-worker runner with intercepted agy simulation
    console.log('[E2E Test] 4. Booting Swarm Pull-Worker Runner...');
    const interceptedAgyCalls: { binary: string; args: readonly string[]; cwd?: string }[] = [];

    // Custom execFileFn: delegates real git commands to host git, intercepts agy CLI
    const customExecFile: ExecFileAsyncFn = async (
      file: string,
      args: readonly string[],
      options?: Record<string, unknown>
    ) => {
      if (file === 'git') {
        const res = await defaultExecFileAsync(file, args as string[], options as any);
        return {
          stdout: String(res.stdout),
          stderr: String(res.stderr),
        };
      }
      if (file === 'agy' || file.endsWith('agy.exe')) {
        interceptedAgyCalls.push({ binary: file, args, cwd: options?.cwd as string | undefined });
        console.log(`[Worker Intercept] Simulated agy command executed in ${options?.cwd}`);
        console.log(`[Worker Intercept] Args: ${args.join(' ')}`);

        // Simulate agent making changes requested in task prompt
        const cwd = (options?.cwd as string) || repoDir;
        fs.appendFileSync(
          path.join(cwd, 'README.md'),
          '\n## Feature Update\nAutomated task applied by autonomous agent.\n'
        );
        fs.writeFileSync(
          path.join(cwd, 'result.json'),
          JSON.stringify(
            { status: 'ok', prompt: args[1], timestamp: new Date().toISOString() },
            null,
            2
          )
        );

        return {
          stdout: 'Antigravity agent successfully updated README.md and created result.json',
          stderr: '',
        };
      }
      const res = await defaultExecFileAsync(file, args as string[], options as any);
      return {
        stdout: String(res.stdout),
        stderr: String(res.stderr),
      };
    };

    const executor = new TaskExecutor({
      agyBinPath: 'agy',
      execFileFn: customExecFile,
    });

    const runner = new RemoteSwarmRunner({
      coordinatorUrl: baseUrl,
      registrationToken: tokenRes.registrationToken,
      runnerStatePath,
      executor,
    });

    // Runner registers and exchanges agyr_reg_ for agyr_run_
    const registeredRunner = await runner.registerIfNeeded();
    console.log(
      `[E2E Test] Runner registered successfully: ${registeredRunner?.name} (${registeredRunner?.runnerId})`
    );
    console.log(`[E2E Test] Persistent runner token: ${runner.getRunnerToken()?.slice(0, 16)}...`);

    // Verify runner appears in coordinator registry
    const runnersList = await ky.get(`${baseUrl}/api/runners`).json<any>();
    const runnersArr = Array.isArray(runnersList) ? runnersList : (runnersList?.runners ?? []);
    console.log(`[E2E Test] Coordinator reports ${runnersArr.length} active runner(s)`);
    if (runnersArr.length !== 1 || runnersArr[0].runnerId !== runner.getRunnerId()) {
      throw new Error('Runner not found in coordinator registry');
    }

    // 5. Dispatch task with instructions/prompt
    const samplePrompt = 'Refactor error handling in README and generate task verification result';
    console.log(`[E2E Test] 5. Dispatching Task: "${samplePrompt}"`);
    const dispatchRes = await ky
      .post(`${baseUrl}/api/dispatch`, {
        json: {
          repositoryId: 'test-project',
          prompt: samplePrompt,
          model: 'gemini-3.8-flash',
          effort: 'medium',
          pushBranch: false, // Local test: keep branch locally without git remote
        },
      })
      .json<any>();

    console.log(
      `[E2E Test] Task queued: id=${dispatchRes.taskId}, status=${dispatchRes.task?.status}`
    );

    // Verify task is queued in coordinator
    let tasksRes = await ky.get(`${baseUrl}/api/tasks`).json<any>();
    let tasksArr = Array.isArray(tasksRes) ? tasksRes : (tasksRes?.tasks ?? []);
    let taskRecord = tasksArr.find((t: any) => t.id === dispatchRes.taskId);
    console.log(`[E2E Test] Task status in queue before poll: ${taskRecord?.status}`);
    if (taskRecord?.status !== 'queued') {
      throw new Error(`Expected task to be 'queued', got '${taskRecord?.status}'`);
    }

    // 6. Runner polls for work, claims, and executes
    console.log('[E2E Test] 6. Runner polling and executing task...');
    const claimedTask = await runner.pollOnce();
    console.log(`[E2E Test] Runner claimed and finished processing task: ${claimedTask?.id}`);

    // 7. Verify task status in coordinator after execution
    tasksRes = await ky.get(`${baseUrl}/api/tasks`).json<any>();
    tasksArr = Array.isArray(tasksRes) ? tasksRes : (tasksRes?.tasks ?? []);
    taskRecord = tasksArr.find((t: any) => t.id === dispatchRes.taskId);
    console.log(`[E2E Test] 7. Task final status in coordinator: ${taskRecord?.status}`);
    console.log(`[E2E Test] Created branch: ${taskRecord?.branchName}`);
    console.log(`[E2E Test] Duration: ${taskRecord?.durationMs}ms`);

    if (taskRecord?.status !== 'completed') {
      throw new Error(
        `Expected task status 'completed', got '${taskRecord?.status}' (error: ${taskRecord?.error})`
      );
    }

    // 8. Verify Git Branch Isolation and Commits on Disk
    console.log('[E2E Test] 8. Verifying Git branch and commit artifacts on disk...');
    const branches = (await runGit(['branch', '--list'], repoDir))
      .split('\n')
      .map((b) => b.trim().replace(/^\*\s*/, ''));
    console.log(`[E2E Test] Branches in repository: ${branches.join(', ')}`);

    if (!branches.includes(taskRecord.branchName)) {
      throw new Error(`Expected branch ${taskRecord.branchName} to exist in repository!`);
    }

    // Check branch commit log
    const branchLog = await runGit(['log', '-n', '2', '--oneline', taskRecord.branchName], repoDir);
    console.log(`[E2E Test] Branch commit log:\n${branchLog}`);

    // Check files on the task branch
    await runGit(['checkout', taskRecord.branchName], repoDir);
    const readmeContent = fs.readFileSync(path.join(repoDir, 'README.md'), 'utf8');
    const resultJsonExists = fs.existsSync(path.join(repoDir, 'result.json'));

    console.log(
      `[E2E Test] README content updated: ${readmeContent.includes('## Feature Update')}`
    );
    console.log(`[E2E Test] result.json created: ${resultJsonExists}`);

    if (!readmeContent.includes('## Feature Update') || !resultJsonExists) {
      throw new Error('Expected file changes on continuation branch were not found!');
    }

    // Return to main branch and verify main was untouched (Branch Isolation Invariant)
    await runGit(['checkout', 'main'], repoDir);
    const mainReadme = fs.readFileSync(path.join(repoDir, 'README.md'), 'utf8');
    const mainResultExists = fs.existsSync(path.join(repoDir, 'result.json'));
    console.log(
      `[E2E Test] Main branch clean: ${!mainReadme.includes('## Feature Update')} (isolated)`
    );
    if (mainReadme.includes('## Feature Update') || mainResultExists) {
      throw new Error('Branch isolation violated: changes leaked into main branch!');
    }

    // 9. Verify CLI invocation arguments passed to agy
    console.log('[E2E Test] 9. Verifying CLI invocation contract:');
    if (interceptedAgyCalls.length !== 1) {
      throw new Error(`Expected 1 agy call, got ${interceptedAgyCalls.length}`);
    }
    const call = interceptedAgyCalls[0];
    if (!call) {
      throw new Error('Call record is undefined');
    }
    console.log(`[E2E Test] - Binary: ${call.binary}`);
    console.log(`[E2E Test] - Args: ${JSON.stringify(call.args)}`);
    const expectedFooter =
      '*Dispatched via Agylity (immediate) with `gemini-3.8-flash` (medium reasoning) — please review carefully.*';
    if (
      call.args[0] !== '-p' ||
      !call.args[1]?.startsWith(samplePrompt) ||
      !call.args[1]?.includes(expectedFooter)
    ) {
      throw new Error(
        `Prompt mismatch in CLI call: expected "${samplePrompt}" with flat footer, got "${call.args[1]}"`
      );
    }
    if (!call.args.includes('--model') || !call.args.includes('gemini-3.8-flash')) {
      throw new Error('Default model gemini-3.8-flash not passed to agy CLI');
    }
    if (!call.args.includes('--effort') || !call.args.includes('medium')) {
      throw new Error('Default effort medium not passed to agy CLI');
    }

    console.log('\n[Success] ALL E2E DISPATCH & WORKER VERIFICATIONS PASSED CLEANLY!\n');
  } finally {
    if (serverInstance) {
      await closeWebServer(serverInstance);
    }
    if (configStore) {
      configStore.close();
    }
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {}
  }
}

main().catch((err) => {
  console.error('[Error] E2E Test Failed:', err);
  process.exit(1);
});
