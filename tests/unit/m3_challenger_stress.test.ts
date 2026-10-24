import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';

import { createNotifier } from '../../src/notify/factory.js';
import { ConsoleNotifier, WebhookNotifier } from '../../src/notify/adapters/console.js';
import {
  DiscordNotifier,
  TaskPromptSchema,
  generateProgressBar,
  formatProgressBar,
  renderProgressBar,
  renderQuotaEmbed,
  createRepoSelectMenu,
  createDispatchModal,
} from '../../src/notify/adapters/discord.js';
import type {
  DispatchRequest,
  DispatchResult,
  DispatchStatusUpdate,
} from '../../src/notify/types.js';

const execFileAsync = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '../..');

/**
 * High-fidelity Discord Interaction Mock with strict 3-second timeout enforcement.
 * Emulates the Discord Gateway constraint:
 * - If deferReply() is NOT invoked within 3000ms of creation, subsequent replies throw DiscordAPIError[10062].
 * - Once deferred, interaction token is valid for 15 minutes (900,000ms).
 */
const createStrictDiscordInteraction = (
  options: {
    userId?: string;
    channelId?: string;
    commandName?: string;
    selectedRepo?: string;
    taskPrompt?: string;
    customId?: string;
    failDefer?: boolean;
    failEdit?: boolean;
  } = {}
) => {
  const createdAt = Date.now();
  let deferred = false;
  let deferredAt: number | null = null;
  let replied = false;
  let replyData: any = null;
  const editHistory: any[] = [];
  let modalShown: any = null;

  return {
    id: `strict-interaction-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    user: { id: options.userId ?? 'otter-user-1', username: 'otter' },
    channelId: options.channelId ?? 'sentry-channel-1',
    commandName: options.commandName,
    customId:
      options.customId ??
      (options.selectedRepo
        ? 'repo_select'
        : options.taskPrompt !== undefined
          ? 'modal_dispatch:repo-test'
          : undefined),
    values: options.selectedRepo ? [options.selectedRepo] : [],
    fields: {
      getTextInputValue: (id: string) => (id === 'task_prompt' ? (options.taskPrompt ?? '') : ''),
    },
    isChatInputCommand: () => options.commandName !== undefined,
    isStringSelectMenu: () => options.selectedRepo !== undefined,
    isModalSubmit: () => options.taskPrompt !== undefined,

    async deferReply(opts?: { ephemeral?: boolean }) {
      if (options.failDefer) {
        throw new Error('DiscordAPIError[50001]: Missing Access or Network Timeout on deferReply');
      }
      const now = Date.now();
      if (now - createdAt > 3000) {
        throw new Error(
          'DiscordAPIError[10062]: Unknown interaction (3-second acknowledgment window expired)'
        );
      }
      deferred = true;
      deferredAt = now;
      return { deferred: true, opts };
    },

    async reply(payload: unknown) {
      const now = Date.now();
      if (!deferred && now - createdAt > 3000) {
        throw new Error(
          'DiscordAPIError[10062]: Unknown interaction (3-second acknowledgment window expired)'
        );
      }
      replied = true;
      replyData = payload;
      return payload;
    },

    async editReply(payload: unknown) {
      if (options.failEdit) {
        throw new Error('DiscordAPIError[50006]: Cannot edit message');
      }
      if (!deferred) {
        throw new Error(
          'DiscordAPIError[10062]: Cannot edit reply before deferReply has been executed'
        );
      }
      const now = Date.now();
      if (deferredAt && now - deferredAt > 900000) {
        throw new Error('DiscordAPIError[10062]: Interaction token expired (exceeded 15 minutes)');
      }
      editHistory.push(payload);
      return payload;
    },

    async showModal(modal: unknown) {
      modalShown = modal;
      return modal;
    },

    get state() {
      return {
        createdAt,
        deferred,
        deferredAt,
        deferElapsedMs: deferredAt ? deferredAt - createdAt : null,
        replied,
        replyData,
        editHistory,
        latestEdit: editHistory.length > 0 ? editHistory[editHistory.length - 1] : null,
        modalShown,
      };
    },
  };
};

describe('Challenger M3: Adversarial Stress Test Suite', () => {
  /* ==================================================================== */
  /* 1. Dynamic Import Isolation Invariant Stress Testing                 */
  /* ==================================================================== */
  describe('1. Dynamic Import Isolation Invariant Stress Testing', () => {
    it('empirical isolation: channel=console in fresh Node process NEVER loads discord.js into require.cache', async () => {
      const testScript = `
        import { createRequire } from 'node:module';
        const require = createRequire(import.meta.url);
        import { createNotifier } from './src/notify/factory.js';

        const notifier = await createNotifier('console');
        if (notifier.channelName !== 'console') {
          console.error('Incorrect channel name');
          process.exit(1);
        }

        const discordModules = Object.keys(require.cache).filter(
          (k) => k.includes('discord.js') || k.includes('@discordjs')
        );

        if (discordModules.length > 0) {
          console.error('VIOLATION: discord.js loaded into require.cache:', discordModules);
          process.exit(2);
        }

        process.exit(0);
      `;

      const { stdout, stderr } = await execFileAsync(
        process.execPath,
        ['--no-warnings', '--import', 'tsx', '--input-type=module', '-e', testScript],
        { cwd: projectRoot, timeout: 10000 }
      );

      assert.equal(stderr, '');
    });

    it('empirical isolation: channel=webhook in fresh Node process NEVER loads discord.js into require.cache', async () => {
      const testScript = `
        import { createRequire } from 'node:module';
        const require = createRequire(import.meta.url);
        import { createNotifier } from './src/notify/factory.js';

        const notifier = await createNotifier('webhook');
        if (notifier.channelName !== 'webhook') {
          console.error('Incorrect channel name');
          process.exit(1);
        }

        const discordModules = Object.keys(require.cache).filter(
          (k) => k.includes('discord.js') || k.includes('@discordjs')
        );

        if (discordModules.length > 0) {
          console.error('VIOLATION: discord.js loaded into require.cache for webhook channel:', discordModules);
          process.exit(2);
        }

        process.exit(0);
      `;

      const { stdout, stderr } = await execFileAsync(
        process.execPath,
        ['--no-warnings', '--import', 'tsx', '--input-type=module', '-e', testScript],
        { cwd: projectRoot, timeout: 10000 }
      );

      assert.equal(stderr, '');
    });

    it('empirical isolation: channel=discord loads discord.js on-demand when requested', async () => {
      const testScript = `
        import { createRequire } from 'node:module';
        const require = createRequire(import.meta.url);
        import { createNotifier } from './src/notify/factory.js';

        const notifier = await createNotifier('discord');
        if (notifier.channelName !== 'discord') {
          console.error('Incorrect channel name');
          process.exit(1);
        }

        const discordModules = Object.keys(require.cache).filter(
          (k) => k.includes('discord.js')
        );

        if (discordModules.length === 0) {
          console.error('Expected discord.js to be loaded for discord channel');
          process.exit(3);
        }

        console.log('discord_loaded_count=' + discordModules.length);
        process.exit(0);
      `;

      const { stdout, stderr } = await execFileAsync(
        process.execPath,
        ['--no-warnings', '--import', 'tsx', '--input-type=module', '-e', testScript],
        { cwd: projectRoot, timeout: 10000 }
      );

      assert.equal(stderr, '');
      assert.ok(stdout.includes('discord_loaded_count='));
    });
  });

  /* ==================================================================== */
  /* 2. Discord 3-Second Timeout Guard Stress Testing                     */
  /* ==================================================================== */
  describe('2. Discord 3-Second Timeout Guard Stress Testing', () => {
    it('oracle verification: un-deferred interaction throws 10062 if asynchronous delay exceeds 3000ms', async () => {
      const interaction = createStrictDiscordInteraction({
        taskPrompt: 'Testing oracle',
      });

      // Intentionally omit deferReply and wait 3100ms
      await new Promise((r) => setTimeout(r, 3100));

      await assert.rejects(
        () => interaction.reply({ content: 'Late reply' }),
        /DiscordAPIError\[10062\]/
      );
    });

    it('stress test: delayed workstation wake (5,000ms delay) succeeds because deferReply executed in <20ms', async () => {
      const interaction = createStrictDiscordInteraction({
        taskPrompt: 'Execute long continuation after worker wake',
        customId: 'modal_dispatch:repo-target',
      });

      let wakeStartedAt = 0;
      let wakeEndedAt = 0;

      const notifier = new DiscordNotifier(
        {
          repositories: [{ id: 'repo-target', name: 'Workstation Target', path: '/opt/target' }],
        },
        {
          onDispatchRequested: async (req: DispatchRequest): Promise<DispatchResult> => {
            wakeStartedAt = Date.now();
            // Simulate 5000ms slow workstation wake
            await new Promise((r) => setTimeout(r, 5000));
            wakeEndedAt = Date.now();
            return {
              success: true,
              branchName: 'antigravity/continuation-target-5s',
              durationMs: wakeEndedAt - wakeStartedAt,
            };
          },
        }
      );

      const tStart = Date.now();
      await notifier.handleInteraction(interaction);
      const tTotal = Date.now() - tStart;

      // 1. deferReply must have been called immediately
      assert.equal(interaction.state.deferred, true);
      assert.ok(
        (interaction.state.deferElapsedMs ?? 9999) < 50,
        `deferReply must execute in <50ms (actual: ${interaction.state.deferElapsedMs}ms)`
      );

      // 2. The dispatch actually took >= 5000ms (exceeding Discord 3000ms timeout)
      assert.ok(tTotal >= 5000, `Total time must be >= 5000ms (actual: ${tTotal}ms)`);

      // 3. editReply must have succeeded with continuation branch without throwing 10062
      assert.deepEqual(interaction.state.latestEdit, {
        content:
          '✅ Antigravity continuation complete on branch `antigravity/continuation-target-5s`',
      });
    });

    it('stress test: simulated 15-second delayed wake relays intermediate status updates before final edit', async () => {
      const interaction = createStrictDiscordInteraction({
        taskPrompt: '15-second heavy orchestration',
        customId: 'modal_dispatch:repo-heavy',
      });

      const notifier = new DiscordNotifier(
        {
          repositories: [{ id: 'repo-heavy', name: 'Heavy Repo', path: '/opt/heavy' }],
        },
        {
          onDispatchRequested: async (req: DispatchRequest): Promise<DispatchResult> => {
            // Emulate progressive status relays during a 15-second process (compressed in ticks)
            await notifier.notifyDispatchStatus({
              status: 'waking',
              repositoryName: 'repo-heavy',
              message: 'Notifying worker node...',
            });

            await notifier.notifyDispatchStatus({
              status: 'worker_connecting' as any,
              repositoryName: 'repo-heavy',
              message: 'Connecting to worker node (booting)...',
            });

            await notifier.notifyDispatchStatus({
              status: 'executing',
              repositoryName: 'repo-heavy',
              message: 'Worker awake. Running git clean & agy continuation...',
            });

            return {
              success: true,
              branchName: 'antigravity/continuation-heavy-15s',
              durationMs: 15000,
            };
          },
        }
      );

      await notifier.handleInteraction(interaction);

      // Verify deferral
      assert.equal(interaction.state.deferred, true);
      assert.ok((interaction.state.deferElapsedMs ?? 9999) < 50);

      // Verify progression of edit history
      const history = interaction.state.editHistory;
      assert.ok(history.length >= 4, `Expected at least 4 edit updates, got ${history.length}`);
      assert.deepEqual(history[0], { content: 'Notifying worker node...' });
      assert.deepEqual(history[1], { content: 'Connecting to worker node (booting)...' });
      assert.deepEqual(history[2], {
        content: 'Worker awake. Running git clean & agy continuation...',
      });
      assert.deepEqual(history[3], {
        content:
          '✅ Antigravity continuation complete on branch `antigravity/continuation-heavy-15s`',
      });
    });

    it('stress test: Zero-Clobber guardrail abort under 5s delay gracefully edits reply with abort reason', async () => {
      const interaction = createStrictDiscordInteraction({
        taskPrompt: 'Task on unreachable host',
        customId: 'modal_dispatch:repo-dead',
      });

      const notifier = new DiscordNotifier(
        {
          repositories: [{ id: 'repo-dead', name: 'Dead Host Repo', path: '/opt/dead' }],
        },
        {
          onDispatchRequested: async () => {
            await new Promise((r) => setTimeout(r, 50));
            return {
              success: false,
              error: 'Worker failed to respond within 60s. Aborted.',
              durationMs: 60000,
            };
          },
        }
      );

      await notifier.handleInteraction(interaction);

      assert.equal(interaction.state.deferred, true);
      assert.deepEqual(interaction.state.latestEdit, {
        content: '❌ Zero-Clobber Guardrail: Worker failed to respond within 60s. Aborted.',
      });
    });

    it('stress test: interactionCreate listener invokes deferReply synchronously before next event loop turn', async () => {
      const mockClient = new EventEmitter() as any;
      const notifier = new DiscordNotifier(
        {
          repositories: [{ id: 'repo-1', name: 'Instant Test', path: '/opt/instant' }],
        },
        { client: mockClient }
      );

      await notifier.initialize();

      const interaction = createStrictDiscordInteraction({
        taskPrompt: 'Synchronous event emission test',
        customId: 'modal_dispatch:repo-1',
      });

      // Emit interactionCreate via Discord.js Gateway client
      mockClient.emit('interactionCreate', interaction);

      // In the same tick or immediate microtask, deferReply must be completed
      await new Promise((r) => setImmediate(r));
      assert.equal(interaction.state.deferred, true);

      await notifier.shutdown();
    });
  });

  /* ==================================================================== */
  /* 3. Rapid Repeated Clicks & Concurrency Debounce Protection           */
  /* ==================================================================== */
  describe('3. Rapid Repeated Clicks & Debounce Protection', () => {
    it('burst challenge: 20 rapid concurrent modal submissions from same user execute dispatch EXACTLY once', async () => {
      let dispatchExecutionCount = 0;

      const notifier = new DiscordNotifier(
        {
          repositories: [{ id: 'repo-burst', name: 'Burst Repo', path: '/opt/burst' }],
        },
        {
          onDispatchRequested: async () => {
            dispatchExecutionCount++;
            // Simulate 100ms task duration
            await new Promise((r) => setTimeout(r, 100));
            return {
              success: true,
              branchName: 'antigravity/continuation-burst',
              durationMs: 100,
            };
          },
        }
      );

      // Create 20 distinct interaction instances representing rapid repeated user clicks
      const interactions = Array.from({ length: 20 }, (_, i) =>
        createStrictDiscordInteraction({
          userId: 'rapid-clicker-99',
          customId: 'modal_dispatch:repo-burst',
          taskPrompt: `Prompt attempt #${i + 1}`,
        })
      );

      // Submit all 20 interactions concurrently
      await Promise.all(interactions.map((interaction) => notifier.handleInteraction(interaction)));

      // 1. Critical assertion: onDispatchRequested was called EXACTLY ONCE
      assert.equal(
        dispatchExecutionCount,
        1,
        `Expected exactly 1 dispatch execution, but received ${dispatchExecutionCount}`
      );

      // 2. All 20 interactions must have called deferReply immediately (none timed out)
      for (let i = 0; i < interactions.length; i++) {
        assert.equal(
          interactions[i]!.state.deferred,
          true,
          `Interaction #${i + 1} did not call deferReply`
        );
      }

      // 3. Exactly 1 interaction received completion message, and 19 received the debounce message
      let successEdits = 0;
      let debouncedEdits = 0;

      for (const interaction of interactions) {
        const content = interaction.state.latestEdit?.content ?? '';
        if (content.includes('✅ Antigravity continuation complete')) {
          successEdits++;
        } else if (content.includes('⚠️ A task is already in progress')) {
          debouncedEdits++;
        }
      }

      assert.equal(successEdits, 1, `Expected 1 success edit, got ${successEdits}`);
      assert.equal(debouncedEdits, 19, `Expected 19 debounced edits, got ${debouncedEdits}`);
    });

    it('debounce recovery: sequential submissions from same user succeed once previous task finishes', async () => {
      let dispatchCount = 0;

      const notifier = new DiscordNotifier(
        {
          repositories: [{ id: 'repo-seq', name: 'Seq Repo', path: '/opt/seq' }],
        },
        {
          onDispatchRequested: async () => {
            dispatchCount++;
            await new Promise((r) => setTimeout(r, 20));
            return { success: true, branchName: `branch-${dispatchCount}`, durationMs: 20 };
          },
        }
      );

      const interaction1 = createStrictDiscordInteraction({
        userId: 'user-seq',
        customId: 'modal_dispatch:repo-seq',
        taskPrompt: 'Task One',
      });
      await notifier.handleInteraction(interaction1);

      assert.equal(dispatchCount, 1);
      assert.ok(interaction1.state.latestEdit?.content.includes('branch-1'));

      // Second task after task 1 completes
      const interaction2 = createStrictDiscordInteraction({
        userId: 'user-seq',
        customId: 'modal_dispatch:repo-seq',
        taskPrompt: 'Task Two',
      });
      await notifier.handleInteraction(interaction2);

      assert.equal(dispatchCount, 2);
      assert.ok(interaction2.state.latestEdit?.content.includes('branch-2'));
    });

    it('debounce lock recovery on rejection: activeSubmissions lock is cleanly deleted when dispatch throws', async () => {
      let failNext = true;
      let runs = 0;

      const notifier = new DiscordNotifier(
        {
          repositories: [{ id: 'repo-err', name: 'Err Repo', path: '/opt/err' }],
        },
        {
          onDispatchRequested: async () => {
            runs++;
            if (failNext) {
              failNext = false;
              throw new Error('Connection broken pipe');
            }
            return { success: true, branchName: 'recovered-branch', durationMs: 10 };
          },
        }
      );

      // Submission 1: will reject
      const interaction1 = createStrictDiscordInteraction({
        userId: 'user-err',
        customId: 'modal_dispatch:repo-err',
        taskPrompt: 'Failing prompt',
      });
      await notifier.handleInteraction(interaction1);

      assert.equal(runs, 1);
      assert.ok(
        interaction1.state.latestEdit?.content.includes(
          'Task dispatch failed: Connection broken pipe'
        )
      );

      // Submission 2: lock must have been released in finally block
      const interaction2 = createStrictDiscordInteraction({
        userId: 'user-err',
        customId: 'modal_dispatch:repo-err',
        taskPrompt: 'Recovery prompt',
      });
      await notifier.handleInteraction(interaction2);

      assert.equal(runs, 2);
      assert.ok(interaction2.state.latestEdit?.content.includes('recovered-branch'));
    });
  });

  /* ==================================================================== */
  /* 4. Adversarial Edge Cases & Boundary Mining                          */
  /* ==================================================================== */
  describe('4. Adversarial Edge Cases & Boundary Mining', () => {
    it('boundary validation: rejects 4001 characters with validation message and zero dispatch invocation', async () => {
      let dispatchCalled = false;
      const interaction = createStrictDiscordInteraction({
        taskPrompt: 'a'.repeat(4001),
        customId: 'modal_dispatch:repo-1',
      });

      const notifier = new DiscordNotifier(
        {
          repositories: [{ id: 'repo-1', name: 'Boundary', path: '/opt/boundary' }],
        },
        {
          onDispatchRequested: async () => {
            dispatchCalled = true;
            return { success: true, durationMs: 0 };
          },
        }
      );

      await notifier.handleInteraction(interaction);

      assert.equal(dispatchCalled, false);
      assert.equal(interaction.state.deferred, true);
      assert.ok(
        interaction.state.latestEdit?.content.includes('Prompt exceeds 4000 character limit')
      );
    });

    it('boundary validation: accepts exactly 4000 UTF-8 characters and dispatches', async () => {
      let receivedPrompt = '';
      const prompt4000 = 'x'.repeat(4000);
      const interaction = createStrictDiscordInteraction({
        taskPrompt: prompt4000,
        customId: 'modal_dispatch:repo-1',
      });

      const notifier = new DiscordNotifier(
        {
          repositories: [{ id: 'repo-1', name: 'Boundary', path: '/opt/boundary' }],
        },
        {
          onDispatchRequested: async (req) => {
            receivedPrompt = req.prompt;
            return { success: true, branchName: 'ok', durationMs: 0 };
          },
        }
      );

      await notifier.handleInteraction(interaction);

      assert.equal(receivedPrompt.length, 4000);
      assert.ok(
        interaction.state.latestEdit?.content.includes('✅ Antigravity continuation complete')
      );
    });

    it('fault injection: handles interaction deferReply failure gracefully without crashing process', async () => {
      const mockClient = new EventEmitter() as any;
      const notifier = new DiscordNotifier(
        {
          repositories: [{ id: 'repo-1', name: 'Crash Test', path: '/opt/crash' }],
        },
        { client: mockClient }
      );
      await notifier.initialize();

      const interaction = createStrictDiscordInteraction({
        taskPrompt: 'Test crash safety',
        customId: 'modal_dispatch:repo-1',
        failDefer: true, // Throws during deferReply
      });

      // Emitting to event listener must not throw an uncaught exception
      assert.doesNotThrow(() => {
        mockClient.emit('interactionCreate', interaction);
      });

      await notifier.shutdown();
    });

    it('fault injection: handles secondary editReply failure gracefully without crashing process', async () => {
      const interaction = createStrictDiscordInteraction({
        taskPrompt: 'Test secondary error',
        customId: 'modal_dispatch:repo-1',
        failEdit: true, // Throws during editReply
      });

      const notifier = new DiscordNotifier(
        {
          repositories: [{ id: 'repo-1', name: 'Fail Edit', path: '/opt/failedit' }],
        },
        {
          onDispatchRequested: async () => {
            throw new Error('Primary error');
          },
        }
      );

      // Should safely handle secondary error in catch
      await assert.doesNotReject(() => notifier.handleInteraction(interaction));
    });
  });
});
