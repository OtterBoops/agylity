import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type {
  Notifier,
  QuotaAlert,
  QuotaSnapshot,
  DispatchStatusUpdate,
  DispatchRequest,
  DispatchResult,
} from '../../src/notify/types.js';
import {
  DispatchStepSchema,
  DispatchRequestSchema,
  DispatchResultSchema,
  DispatchStatusUpdateSchema,
} from '../../src/notify/types.js';
import { createNotifier } from '../../src/notify/factory.js';
import { ConsoleNotifier } from '../../src/notify/adapters/console.js';
import { WebhookNotifier } from '../../src/notify/adapters/webhook.js';
import {
  DiscordNotifier,
  generateProgressBar,
  formatProgressBar,
  renderProgressBar,
  renderQuotaEmbed,
  createRepoSelectMenu,
  createDispatchModal,
  TaskPromptSchema,
} from '../../src/notify/adapters/discord.js';
import { BUILTIN_DEFAULTS } from '../../src/config/schema.js';

const execFileAsync = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const createMockInteraction = (
  options: {
    userId?: string;
    channelId?: string;
    commandName?: string;
    selectedRepo?: string;
    taskPrompt?: string;
    customId?: string;
  } = {}
) => {
  let deferred = false;
  let deferredAt: number | null = null;
  let replied = false;
  let replyData: any = null;
  let editedData: any = null;
  let modalShown: any = null;

  return {
    id: `interaction-${Date.now()}-${Math.random()}`,
    user: { id: options.userId ?? 'user-123', username: 'otter' },
    channelId: options.channelId ?? 'channel-sentry-1',
    commandName: options.commandName,
    customId:
      options.customId ??
      (options.selectedRepo
        ? 'repo_select'
        : options.taskPrompt !== undefined
          ? 'modal_dispatch:repo-1'
          : undefined),
    values: options.selectedRepo ? [options.selectedRepo] : [],
    fields: {
      getTextInputValue: (id: string) => (id === 'task_prompt' ? (options.taskPrompt ?? '') : ''),
    },
    isChatInputCommand: () => options.commandName !== undefined,
    isStringSelectMenu: () => options.selectedRepo !== undefined,
    isModalSubmit: () => options.taskPrompt !== undefined,
    async deferReply(opts?: { ephemeral?: boolean }) {
      deferred = true;
      deferredAt = Date.now();
      return { deferred: true, opts };
    },
    async reply(payload: unknown) {
      replied = true;
      replyData = payload;
      return payload;
    },
    async editReply(payload: unknown) {
      editedData = payload;
      return payload;
    },
    async showModal(modal: unknown) {
      modalShown = modal;
      return modal;
    },
    get state() {
      return { deferred, deferredAt, replied, replyData, editedData, modalShown };
    },
  };
};

describe('Milestone 3 Unit Tests: Pluggable Notification & Discord Architecture', () => {
  /* ==================================================================== */
  /* 1. Universal Notifier Interface & Type Schemas                       */
  /* ==================================================================== */
  describe('1. Notifier Interface Contract & Types', () => {
    it('validates DispatchStepSchema enum values', () => {
      const validSteps = ['waking', 'polling', 'executing', 'completed', 'aborted', 'failed'];
      for (const step of validSteps) {
        assert.equal(DispatchStepSchema.parse(step), step);
      }
      assert.throws(() => DispatchStepSchema.parse('invalid_step'));
    });

    it('validates DispatchRequestSchema boundaries', () => {
      const validRequest: DispatchRequest = {
        repositoryName: 'agylity',
        repositoryPath: '/opt/agylity',
        prompt: 'Fix quota sentry timeout bug',
        requestedBy: 'otter',
      };
      assert.deepEqual(DispatchRequestSchema.parse(validRequest), validRequest);

      // Rejects empty prompt or empty repo name
      assert.throws(() => DispatchRequestSchema.parse({ ...validRequest, prompt: '' }));
      assert.throws(() => DispatchRequestSchema.parse({ ...validRequest, repositoryName: '' }));
      // Rejects prompt exceeding 4000 characters
      assert.throws(() =>
        DispatchRequestSchema.parse({ ...validRequest, prompt: 'a'.repeat(4001) })
      );
    });

    it('validates DispatchResultSchema', () => {
      const validResult: DispatchResult = {
        success: true,
        branchName: 'antigravity/continuation-20261019',
        output: 'All tests passed',
        durationMs: 4200,
      };
      assert.deepEqual(DispatchResultSchema.parse(validResult), validResult);

      assert.throws(() => DispatchResultSchema.parse({ ...validResult, durationMs: -1 }));
    });

    it('validates DispatchStatusUpdateSchema flexibility', () => {
      const update1 = {
        status: 'waking' as const,
        repositoryName: 'agylity',
        message: 'Waking worker node',
      };
      assert.ok(DispatchStatusUpdateSchema.parse(update1));

      const update2 = {
        step: 'waking',
        message: 'Waking worker',
        details: { target: 'worker-node-1' },
      };
      assert.ok(DispatchStatusUpdateSchema.parse(update2));
    });

    it('implements Notifier lifecycle on ConsoleNotifier', async () => {
      const notifier = new ConsoleNotifier();
      assert.equal(notifier.channelName, 'console');
      assert.equal(notifier.initialized, false);

      await notifier.initialize();
      assert.equal(notifier.initialized, true);

      await notifier.shutdown();
      assert.equal(notifier.initialized, false);
    });

    it('implements Notifier lifecycle on WebhookNotifier', async () => {
      const notifier = new WebhookNotifier();
      assert.equal(notifier.channelName, 'webhook');
      await notifier.init();
      assert.equal(notifier.initialized, true);
      await notifier.shutdown();
      assert.equal(notifier.initialized, false);
    });

    it('implements Notifier lifecycle on DiscordNotifier', async () => {
      const notifier = new DiscordNotifier();
      assert.equal(notifier.channelName, 'discord');
      assert.equal(notifier.initialized, false);

      await notifier.initialize();
      assert.equal(notifier.initialized, true);

      await notifier.shutdown();
      assert.equal(notifier.initialized, false);
    });
  });

  /* ==================================================================== */
  /* 2. Dynamic Import Factory & Channel Isolation                        */
  /* ==================================================================== */
  describe('2. Dynamic Import Factory & Channel Isolation', () => {
    it('creates ConsoleNotifier when channel is "console"', async () => {
      const notifier = await createNotifier('console');
      assert.equal(notifier.channelName, 'console');
      assert.ok(notifier instanceof ConsoleNotifier);
    });

    it('creates WebhookNotifier when channel is "webhook"', async () => {
      const notifier = await createNotifier('webhook');
      assert.equal(notifier.channelName, 'webhook');
      assert.ok(notifier instanceof WebhookNotifier);
    });

    it('creates DiscordNotifier when channel is "discord"', async () => {
      const notifier = await createNotifier('discord');
      assert.equal(notifier.channelName, 'discord');
      assert.ok(notifier instanceof DiscordNotifier);
    });

    it('supports createNotifier(resolvedConfig) signature', async () => {
      const config = {
        ...BUILTIN_DEFAULTS,
        notificationChannel: 'console' as const,
      };
      const notifier = await createNotifier(config);
      assert.equal(notifier.channelName, 'console');
    });

    it('rejects unsupported channel with typed error', async () => {
      await assert.rejects(() => createNotifier('slack'), /Unknown notification channel: slack/);
      await assert.rejects(
        () => createNotifier('telegram'),
        /Unknown notification channel: telegram/
      );
    });

    it('channel isolation: creating console notifier does NOT evaluate discord.js in fresh process', async () => {
      // In a separate Node process, load factory and create console notifier.
      // Assert that discord.js is not loaded into memory cache.
      const testCode = `
        import { createRequire } from 'node:module';
        const req = createRequire(import.meta.url);
        import { createNotifier } from './src/notify/factory.js';

        const notifier = await createNotifier('console');
        if (notifier.channelName !== 'console') {
          process.exit(1);
        }

        const discordModules = Object.keys(req.cache).filter((k) => k.toLowerCase().includes('discord'));
        if (discordModules.length > 0) {
          console.error('Channel isolation violation: discord modules loaded in memory:', discordModules);
          process.exit(1);
        }

        process.exit(0);
      `;

      const projectRoot = path.resolve(__dirname, '../..');
      const { stdout, stderr } = await execFileAsync(
        process.execPath,
        ['--no-warnings', '--import', 'tsx', '--input-type=module', '-e', testCode],
        { cwd: projectRoot, timeout: 5000 }
      );

      assert.equal(stderr, '');
    });
  });

  /* ==================================================================== */
  /* 3. Visual Progress Bar Formatting                                    */
  /* ==================================================================== */
  describe('3. Visual Progress Bar Formatting', () => {
    it('generates standard 10-slot visual progress bars accurately', () => {
      assert.equal(generateProgressBar(1.0), '██████████');
      assert.equal(generateProgressBar(0.9), '█████████░');
      assert.equal(generateProgressBar(0.82), '████████░░');
      assert.equal(generateProgressBar(0.5), '█████░░░░░');
      assert.equal(generateProgressBar(0.25), '███░░░░░░░');
      assert.equal(generateProgressBar(0.1), '█░░░░░░░░░');
      assert.equal(generateProgressBar(0.0), '░░░░░░░░░░');
    });

    it('clamps boundary and out-of-range fractions safely', () => {
      assert.equal(generateProgressBar(-0.5), '░░░░░░░░░░');
      assert.equal(generateProgressBar(1.5), '██████████');
      assert.equal(generateProgressBar(Number.NaN), '░░░░░░░░░░');
    });

    it('supports custom bar slot lengths', () => {
      assert.equal(generateProgressBar(0.5, 20), '██████████░░░░░░░░░░');
      assert.equal(generateProgressBar(1.0, 5), '█████');
      assert.equal(generateProgressBar(0.0, 5), '░░░░░');
    });

    it('formatProgressBar returns bracketed bar with percentage', () => {
      assert.equal(formatProgressBar(0.6), '[██████░░░░] 60%');
      assert.equal(formatProgressBar(0.0), '[░░░░░░░░░░] 0%');
      assert.equal(formatProgressBar(1.0), '[██████████] 100%');
      assert.equal(formatProgressBar(0.824), '[████████░░] 82%');
    });

    it('renderProgressBar returns markdown formatted Discord string', () => {
      assert.equal(renderProgressBar(0.5), '`[█████░░░░░]` **50%**');
      assert.equal(renderProgressBar(0.494), '`[█████░░░░░]` **49%**');
    });

    it('sanitizes totalBars and fraction safely on negative or non-finite inputs', () => {
      assert.equal(generateProgressBar(0.5, -5), '█████░░░░░');
      assert.equal(generateProgressBar(0.5, 0), '█████░░░░░');
      assert.equal(generateProgressBar(0.5, Number.NaN), '█████░░░░░');
      assert.equal(generateProgressBar(Number.POSITIVE_INFINITY, 10), '░░░░░░░░░░');
      assert.equal(formatProgressBar(0.5, -5), '[█████░░░░░] 50%');
      assert.equal(renderProgressBar(0.5, -5), '`[█████░░░░░]` **50%**');
    });
  });

  /* ==================================================================== */
  /* 4. Discord 3-Second Timeout Guardrail & Modal Prompt Handling         */
  /* ==================================================================== */
  describe('4. Discord 3-Second Timeout Guardrail & Modal Lifecycle', () => {
    it('TaskPromptSchema validates character bounds and UTF-8 formatting', () => {
      const valid = 'Test prompt';
      assert.equal(TaskPromptSchema.parse(valid), valid);

      const exactly4000 = 'x'.repeat(4000);
      assert.equal(TaskPromptSchema.parse(exactly4000), exactly4000);

      assert.throws(
        () => TaskPromptSchema.parse('x'.repeat(4001)),
        /Prompt exceeds 4000 character limit/
      );
      assert.throws(() => TaskPromptSchema.parse(''), /Prompt is required/);
      assert.throws(() => TaskPromptSchema.parse('   \n\t   '), /Prompt is required/);

      const complex = '🚀 Antigravity continuation ⚡ 修复内存泄漏';
      assert.equal(TaskPromptSchema.parse(complex), complex);
    });

    it('synchronously calls deferReply() immediately upon modal submission', async () => {
      const interaction = createMockInteraction({
        taskPrompt: 'Execute continuation task',
        customId: 'modal_dispatch:repo-1',
      });

      const notifier = new DiscordNotifier({
        repositories: [{ id: 'repo-1', name: 'Agylity', path: '/opt/agylity' }],
      });

      const startTime = Date.now();
      await notifier.handleInteraction(interaction);
      const deferElapsed = (interaction.state.deferredAt ?? 0) - startTime;

      assert.equal(interaction.state.deferred, true);
      assert.ok(deferElapsed < 100, `deferReply took ${deferElapsed}ms (must be <100ms)`);
      assert.ok(interaction.state.editedData);
    });

    it('executes onDispatchRequested callback and edits reply with continuation branch on success', async () => {
      let dispatchCalled = false;
      let receivedReq: DispatchRequest | null = null;

      const interaction = createMockInteraction({
        taskPrompt: 'Run unit test suite',
        customId: 'modal_dispatch:repo-1',
      });

      const notifier = new DiscordNotifier(
        {
          repositories: [{ id: 'repo-1', name: 'Agylity Core', path: '/opt/agylity' }],
        },
        {
          onDispatchRequested: async (req: DispatchRequest) => {
            dispatchCalled = true;
            receivedReq = req;
            return {
              success: true,
              branchName: 'antigravity/continuation-20261019-test',
              durationMs: 3500,
            };
          },
        }
      );

      await notifier.handleInteraction(interaction);

      assert.equal(dispatchCalled, true);
      assert.equal(receivedReq?.repositoryId, 'repo-1');
      assert.equal(receivedReq?.repositoryName, 'Agylity Core');
      assert.equal(receivedReq?.prompt, 'Run unit test suite');

      assert.deepEqual(interaction.state.editedData, {
        content:
          '[Success] Antigravity continuation complete on branch `antigravity/continuation-20261019-test`',
      });
    });

    it('edits reply with Zero-Clobber guardrail message on dispatch failure', async () => {
      const interaction = createMockInteraction({
        taskPrompt: 'Deploy service',
        customId: 'modal_dispatch:repo-1',
      });

      const notifier = new DiscordNotifier(
        {
          repositories: [{ id: 'repo-1', name: 'Backend API', path: '/opt/backend' }],
        },
        {
          onDispatchRequested: async () => ({
            success: false,
            error: 'Host node@worker failed to wake within 60s timeout. Aborted.',
            durationMs: 60000,
          }),
        }
      );

      await notifier.handleInteraction(interaction);

      assert.deepEqual(interaction.state.editedData, {
        content:
          '[Blocked] Zero-Clobber Guardrail: Host node@worker failed to wake within 60s timeout. Aborted.',
      });
    });

    it('handles rapid double-submission via debounce lock', async () => {
      let dispatchCount = 0;

      const interaction1 = createMockInteraction({
        userId: 'user-rapid',
        taskPrompt: 'Task A',
        customId: 'modal_dispatch:repo-rapid',
      });
      const interaction2 = createMockInteraction({
        userId: 'user-rapid',
        taskPrompt: 'Task A',
        customId: 'modal_dispatch:repo-rapid',
      });

      const notifier = new DiscordNotifier(
        {
          repositories: [{ id: 'repo-rapid', name: 'Rapid', path: '/opt/rapid' }],
        },
        {
          onDispatchRequested: async () => {
            dispatchCount++;
            await new Promise((r) => setTimeout(r, 50));
            return { success: true, branchName: 'main', durationMs: 50 };
          },
        }
      );

      // Launch both submissions concurrently
      const [res1, res2] = await Promise.all([
        notifier.handleInteraction(interaction1),
        notifier.handleInteraction(interaction2),
      ]);

      assert.equal(dispatchCount, 1);
      // One succeeded, one was debounced
      const edit1 = interaction1.state.editedData?.content ?? '';
      const edit2 = interaction2.state.editedData?.content ?? '';
      assert.ok(edit1.includes('already in progress') || edit2.includes('already in progress'));
    });

    it('rejects invalid/empty prompt in modal with helpful error reply', async () => {
      const interaction = createMockInteraction({
        taskPrompt: '   \n   ',
        customId: 'modal_dispatch:repo-1',
      });

      const notifier = new DiscordNotifier({
        repositories: [{ id: 'repo-1', name: 'Agylity', path: '/opt/agylity' }],
      });

      await notifier.handleInteraction(interaction);

      assert.ok((interaction.state.editedData?.content ?? '').includes('Prompt is required'));
    });

    it('truncates dispatch error messages exceeding 2000 chars to avoid DiscordAPIError[50035]', async () => {
      const interaction = createMockInteraction({
        taskPrompt: 'Trigger huge error',
        customId: 'modal_dispatch:repo-1',
      });

      const hugeError = 'Stack trace error details: ' + 'x'.repeat(2500);
      const notifier = new DiscordNotifier(
        {
          repositories: [{ id: 'repo-1', name: 'Error Repo', path: '/opt/error' }],
        },
        {
          onDispatchRequested: async () => ({
            success: false,
            error: hugeError,
            durationMs: 100,
          }),
        }
      );

      await notifier.handleInteraction(interaction);

      const content = interaction.state.editedData?.content ?? '';
      assert.ok(content.length <= 2000);
      assert.ok(content.startsWith('[Blocked] Zero-Clobber Guardrail: Stack trace error details:'));
    });
  });

  /* ==================================================================== */
  /* 5. Discord UI Components, Embeds & Slash Command                     */
  /* ==================================================================== */
  describe('5. Discord UI Components, Embeds & Slash Command', () => {
    it('renderQuotaEmbed handles zero model pools gracefully', () => {
      const embed = renderQuotaEmbed([]);
      assert.equal(embed.data.title, 'Antigravity Model Quota Status');
      assert.equal(embed.data.description, 'No active quota pools currently monitored.');
      assert.equal(embed.data.fields, undefined);
    });

    it('renderQuotaEmbed renders progress bars and countdowns for active pools', () => {
      const snapshots: QuotaSnapshot[] = [
        {
          poolId: 'claude',
          family: 'claude',
          displayName: 'Claude 5.5 / Opus',
          remainingFraction: 0.494,
          resetTime: '2026-10-20T14:59:48Z',
          hoursUntilReset: 25.5,
          models: ['Claude Sonnet 5.5'],
        },
        {
          poolId: 'gemini-argon',
          family: 'gemini-argon',
          displayName: 'Gemini 4 Argon',
          remainingFraction: 0.17,
          resetTime: '2026-10-26T09:17:32Z',
          hoursUntilReset: 164.2,
          models: ['Gemini 4 Argon'],
        },
      ];

      const embed = renderQuotaEmbed(snapshots);
      assert.equal(embed.data.fields?.length, 2);
      assert.equal(embed.data.fields?.[0]?.name, 'Claude 5.5 / Opus');
      assert.ok(embed.data.fields?.[0]?.value.includes('49%'));
      assert.ok(embed.data.fields?.[0]?.value.includes('25.5h'));
      assert.equal(embed.data.fields?.[1]?.name, 'Gemini 4 Argon');
      assert.ok(embed.data.fields?.[1]?.value.includes('17%'));
    });

    it('createRepoSelectMenu handles empty repository registry safely', () => {
      const row = createRepoSelectMenu([]);
      const menu = row.components[0]?.toJSON() as any;

      assert.equal(menu.type, 3);
      assert.equal(menu.custom_id, 'repo_select');
      assert.equal(menu.disabled, true);
      assert.equal(menu.placeholder, 'No repositories configured');
      assert.equal(menu.options?.length, 1);
      assert.equal(menu.options?.[0]?.value, 'none');
    });

    it('createRepoSelectMenu populates options from configured repositories', () => {
      const repos = [
        { id: 'repo-1', name: 'Frontend', path: '/opt/frontend', description: 'Web UI' },
        { id: 'repo-2', name: 'Backend', path: '/opt/backend' },
      ];
      const row = createRepoSelectMenu(repos);
      const menu = row.components[0]?.toJSON() as any;

      assert.equal(menu.disabled, undefined);
      assert.equal(menu.placeholder, 'Select target repository to dispatch task...');
      assert.equal(menu.options?.length, 2);
      assert.equal(menu.options?.[0]?.label, 'Frontend');
      assert.equal(menu.options?.[0]?.value, 'repo-1');
      assert.equal(menu.options?.[0]?.description, 'Web UI');
      assert.equal(menu.options?.[1]?.label, 'Backend');
      assert.equal(menu.options?.[1]?.value, 'repo-2');
      assert.equal(menu.options?.[1]?.description, '/opt/backend');
    });

    it('createDispatchModal builds modal with task_prompt paragraph input', () => {
      const modal = createDispatchModal('repo-1', 'Agylity Core');
      const data = modal.toJSON() as any;

      assert.equal(data.custom_id, 'modal_dispatch:repo-1');
      assert.equal(data.title, 'Dispatch Task: Agylity Core');
      assert.equal(data.components.length, 1);

      const textInput = data.components[0].components[0];
      assert.equal(textInput.type, 4); // TextInput
      assert.equal(textInput.custom_id, 'task_prompt');
      assert.equal(textInput.style, 2); // Paragraph
      assert.equal(textInput.required, true);
      assert.equal(textInput.max_length, 4000);
    });

    it('slash command /quota responds with quota embed and select menu', async () => {
      const interaction = createMockInteraction({
        commandName: 'quota',
        channelId: 'sentry-channel',
      });

      const notifier = new DiscordNotifier(
        {
          discordNotificationChannelId: 'sentry-channel',
          repositories: [{ id: 'agylity', name: 'Agylity', path: '/opt/agylity' }],
        },
        {
          onQuotaRequested: async () => [
            {
              poolId: 'claude',
              family: 'claude',
              displayName: 'Claude 5.5 / Opus',
              remainingFraction: 0.82,
              resetTime: '2026-10-20T12:00:00Z',
              hoursUntilReset: 23.5,
              models: ['Claude Sonnet 5.5'],
            },
          ],
        }
      );

      await notifier.handleInteraction(interaction);

      assert.equal(interaction.state.replied, true);
      const reply = interaction.state.replyData as any;
      assert.ok(reply.embeds);
      assert.equal(reply.embeds.length, 1);
      assert.ok(reply.components);
      assert.equal(reply.components.length, 1);
    });

    it('slash command /quota rejects execution outside designated channel with ephemeral reply', async () => {
      const interaction = createMockInteraction({
        commandName: 'quota',
        channelId: 'general-chat',
      });

      const notifier = new DiscordNotifier({
        discordNotificationChannelId: 'sentry-channel',
      });

      await notifier.handleInteraction(interaction);

      assert.equal(interaction.state.replied, true);
      assert.deepEqual(interaction.state.replyData, {
        content: 'You do not have permission to run /quota in this channel.',
        ephemeral: true,
      });
    });

    it('StringSelectMenu repository selection opens modal', async () => {
      const interaction = createMockInteraction({
        selectedRepo: 'repo-1',
      });

      const notifier = new DiscordNotifier({
        repositories: [{ id: 'repo-1', name: 'Agylity Sentry', path: '/opt/agylity' }],
      });

      await notifier.handleInteraction(interaction);

      assert.ok(interaction.state.modalShown);
      const modalData = (interaction.state.modalShown as any).toJSON();
      assert.equal(modalData.custom_id, 'modal_dispatch:repo-1');
      assert.equal(modalData.title, 'Dispatch Task: Agylity Sentry');
    });

    it('createRepoSelectMenu gracefully truncates list > 25 repositories and labels/values to 100 chars', () => {
      const repos = Array.from({ length: 30 }, (_, i) => ({
        id: `repo-${i}-${'id-'.repeat(30)}`,
        name: `Repo Name ${i} ${'long-'.repeat(25)}`,
        path: `/opt/repo-${i}`,
      }));

      const row = createRepoSelectMenu(repos);
      const menu = row.components[0]?.toJSON() as any;

      assert.equal(menu.options?.length, 25);
      assert.equal(menu.placeholder, 'Select repository (showing 25 of 30)...');
      assert.ok(menu.options[0].label.length <= 100);
      assert.ok(menu.options[0].value.length <= 100);
    });

    it('createRepoSelectMenu omits description when empty or whitespace only', () => {
      const repos = [
        { id: 'repo-no-desc', name: 'No Desc' },
        { id: 'repo-ws-desc', name: 'Whitespace Desc', description: '   ', path: '   ' },
      ];

      const row = createRepoSelectMenu(repos);
      const menu = row.components[0]?.toJSON() as any;

      assert.equal(menu.options?.length, 2);
      assert.equal(menu.options[0].description, undefined);
      assert.equal(menu.options[1].description, undefined);
    });

    it('createDispatchModal truncates title to 45 chars and customId to 100 chars', () => {
      const longRepoId = 'x'.repeat(120);
      const longRepoName = 'y'.repeat(60);

      const modal = createDispatchModal(longRepoId, longRepoName);
      const data = modal.toJSON() as any;

      assert.ok(data.title.length <= 45);
      assert.ok(data.custom_id.length <= 100);
      assert.equal(data.title, `Dispatch Task: ${longRepoName}`.slice(0, 45));
      assert.equal(data.custom_id, `modal_dispatch:${longRepoId}`.slice(0, 100));
    });

    it('handleRepoSelect replies ephemerally when selected repository is none or empty', async () => {
      const interaction = createMockInteraction({
        selectedRepo: 'none',
      });

      const notifier = new DiscordNotifier({
        repositories: [],
      });

      await notifier.handleInteraction(interaction);

      assert.equal(interaction.state.replied, true);
      assert.deepEqual(interaction.state.replyData, {
        content:
          '[Notice] No repositories are currently configured. Please configure repositories in settings.',
        ephemeral: true,
      });
    });

    it('renderQuotaEmbed guards field names to 256 chars and field values to 1024 chars', () => {
      const snapshots: QuotaSnapshot[] = [
        {
          poolId: 'claude-super-long-id-'.repeat(20),
          family: 'claude',
          displayName: 'Claude Model Name Super Long '.repeat(15),
          remainingFraction: 0.5,
          resetTime: '2026-10-20T12:00:00Z',
          hoursUntilReset: 24,
          models: ['Claude'],
        },
      ];

      const embed = renderQuotaEmbed(snapshots);
      assert.equal(embed.data.fields?.length, 1);
      const field = embed.data.fields?.[0];
      assert.ok((field?.name?.length ?? 0) <= 256);
      assert.ok((field?.value?.length ?? 0) <= 1024);
    });
  });

  /* ==================================================================== */
  /* 6. Console & Webhook Adapter Notifications                           */
  /* ==================================================================== */
  describe('6. Console & Webhook Adapter Notifications', () => {
    it('ConsoleNotifier logs formatted quota alerts and records history', async () => {
      const notifier = new ConsoleNotifier();
      await notifier.initialize();

      const alert: QuotaAlert = {
        pool: {
          poolId: 'claude-5-5',
          family: 'claude',
          displayName: 'Claude 5.5 / Opus',
          remainingFraction: 0.4944,
          resetTime: '2026-10-20T14:59:48Z',
          hoursUntilReset: 25.8,
          models: ['Claude Sonnet 5.5'],
        },
        milestoneHours: 24,
        remainingPercentage: 49.4,
        triggeredAt: '2026-10-19T13:12:00.000Z',
      };

      await notifier.notifyQuotaAlert(alert);
      assert.equal(notifier.alerts.length, 1);
      assert.equal(notifier.alerts[0]?.milestoneHours, 24);
      assert.equal(notifier.alerts[0]?.pool.family, 'claude');
      await notifier.shutdown();
    });

    it('ConsoleNotifier logs formatted dispatch status and records history', async () => {
      const notifier = new ConsoleNotifier();
      await notifier.initialize();

      const status1: DispatchStatusUpdate = {
        status: 'waking',
        repositoryName: 'agylity',
        branchName: 'antigravity/continuation-1',
        message: 'Waking worker node',
      };
      const status2: DispatchStatusUpdate = {
        status: 'completed',
        repositoryName: 'agylity',
        branchName: 'antigravity/continuation-1',
        message: 'Task completed in 42s',
      };

      await notifier.notifyDispatchStatus(status1);
      await notifier.notifyDispatchStatus(status2);

      assert.equal(notifier.statuses.length, 2);
      assert.equal(notifier.statuses[0]?.status, 'waking');
      assert.equal(notifier.statuses[1]?.status, 'completed');
      await notifier.shutdown();
    });

    it('posts webhook JSON with x-agylity-signature when webhook URL and secret are configured', async () => {
      let receivedHeaders: http.IncomingHttpHeaders = {};
      let receivedBody: any = null;

      const server = http.createServer((req, res) => {
        receivedHeaders = req.headers;
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          receivedBody = JSON.parse(body);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        });
      });

      try {
        await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
        const port = (server.address() as { port: number }).port;
        const webhookUrl = `http://127.0.0.1:${port}/hook`;

        process.env.WEBHOOK_SECRET = 'super-secret-key-123';

        const notifier = new WebhookNotifier({
          notificationWebhookUrl: webhookUrl,
        });
        await notifier.initialize();

        const alert: QuotaAlert = {
          pool: {
            poolId: 'gemini-argon',
            family: 'gemini-argon',
            displayName: 'Gemini 4 Argon',
            remainingFraction: 0.17,
            resetTime: '2026-10-26T09:17:32Z',
            hoursUntilReset: 164.2,
            models: ['Gemini 4 Argon'],
          },
          milestoneHours: 12,
          remainingPercentage: 17,
          triggeredAt: '2026-10-19T13:15:00.000Z',
        };

        await notifier.notifyQuotaAlert(alert);

        assert.equal(receivedBody?.event, 'quota_alert');
        assert.equal(receivedBody?.poolId, 'gemini-argon');
        assert.equal(receivedBody?.milestone, 12);
        assert.ok(receivedHeaders['x-agylity-signature']);
        assert.ok((receivedHeaders['x-agylity-signature'] as string).startsWith('sha256='));

        delete process.env.WEBHOOK_SECRET;
        await notifier.shutdown();
      } finally {
        server.closeAllConnections?.();
        await new Promise<void>((r) => server.close(() => r()));
      }
    });

    it('testNotification masks sensitive webhook URL secrets and parameters in returned messages', async () => {
      const server = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });

      try {
        await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
        const port = (server.address() as { port: number }).port;
        const secretToken = 'DISCORD_SUPER_SECRET_TOKEN_XYZ12345';
        const rawUrl = `http://127.0.0.1:${port}/api/webhooks/987654321/${secretToken}?auth=superSecretQuery`;

        const notifier = new WebhookNotifier({
          notificationWebhookUrl: rawUrl,
        });
        await notifier.initialize();

        const result = await notifier.testNotification();
        assert.equal(result.success, true);
        assert.ok(!result.message.includes(secretToken), 'Message must NOT contain secretToken');
        assert.ok(
          !result.message.includes('superSecretQuery'),
          'Message must NOT contain query secret'
        );
        assert.ok(result.message.includes('***'), 'Message must contain masked placeholder ***');
        assert.ok(
          result.message.includes('987654321'),
          'Message retains non-sensitive channel/webhook id'
        );

        await notifier.shutdown();
      } finally {
        server.closeAllConnections?.();
        await new Promise<void>((r) => server.close(() => r()));
      }
    });

    it('testNotification masks sensitive URL and secrets in error message on HTTP failure', async () => {
      const server = http.createServer((req, res) => {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ message: 'Not found' }));
      });

      try {
        await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
        const port = (server.address() as { port: number }).port;
        const secretToken = 'SECRET_TOKEN_REDACT_TEST_12345';
        const rawUrl = `http://127.0.0.1:${port}/api/webhooks/55555/${secretToken}`;

        const notifier = new WebhookNotifier({
          notificationWebhookUrl: rawUrl,
        });
        await notifier.initialize();

        const result = await notifier.testNotification();
        assert.equal(result.success, false);
        assert.ok(result.message.includes('Webhook ping failed'));
        assert.ok(
          !result.message.includes(secretToken),
          'Error message must NOT contain raw secretToken'
        );
        assert.ok(
          result.message.includes('***'),
          'Error message must contain masked placeholder ***'
        );

        await notifier.shutdown();
      } finally {
        server.closeAllConnections?.();
        await new Promise<void>((r) => server.close(() => r()));
      }
    });

    it('sanitizeWebhookUrl masks Discord, Slack, query parameters, and basic auth credentials', async () => {
      const { sanitizeWebhookUrl, sanitizeErrorMessage } =
        await import('../../src/notify/adapters/webhook.js');

      // Discord webhook
      assert.equal(
        sanitizeWebhookUrl('https://discord.com/api/webhooks/12345/abcdef_token_secret'),
        'https://discord.com/api/webhooks/12345/***'
      );

      // Slack webhook
      assert.equal(
        sanitizeWebhookUrl('https://hooks.slack.com/services/T123/B456/token789'),
        'https://hooks.slack.com/services/T123/B456/***'
      );

      // Query parameter masking
      assert.equal(
        sanitizeWebhookUrl('https://example.com/hook?token=secret123&key=val456'),
        'https://example.com/hook?token=***&key=***'
      );

      // Basic auth masking
      assert.equal(
        sanitizeWebhookUrl('https://user:password@example.com/hook'),
        'https://***:***@example.com/hook'
      );

      // Hash fragment masking / stripping
      assert.equal(
        sanitizeWebhookUrl('https://example.com/webhook#token=secret123'),
        'https://example.com/webhook'
      );
      assert.equal(
        sanitizeWebhookUrl(
          'https://webhook.example.com/api/notify?token=secret123#token=secret_fragment_abc'
        ),
        'https://webhook.example.com/api/***?token=***'
      );

      // Generic 2-segment path masking (short token < 24 chars)
      assert.equal(
        sanitizeWebhookUrl('https://my-webhook.com/webhook/shortkey123'),
        'https://my-webhook.com/webhook/***'
      );
      assert.equal(
        sanitizeWebhookUrl('https://hooks.example.com/alerts/token456'),
        'https://hooks.example.com/alerts/***'
      );

      // Error message masking
      const raw =
        'Request failed with status code 404: POST https://discord.com/api/webhooks/12345/abcdef_secret';
      assert.equal(
        sanitizeErrorMessage(raw),
        'Request failed with status code 404: POST https://discord.com/api/webhooks/12345/***'
      );
    });

    it('safely handles webhook network failures without throwing unhandled rejections', async () => {
      const notifier = new WebhookNotifier({
        notificationWebhookUrl: 'http://127.0.0.1:59999/dead-port',
      });
      await notifier.initialize();

      // Should not throw or crash process
      await notifier.notifyDispatchStatus({
        status: 'executing',
        message: 'Testing dead webhook',
      });

      assert.equal(notifier.statuses.length, 1);
      await notifier.shutdown();
    });
  });

  /* ==================================================================== */
  /* 7. Discord Status Updates & Live Interaction Relaying                */
  /* ==================================================================== */
  describe('7. Discord Status Updates & Live Interaction Relaying', () => {
    it('relays notifyDispatchStatus updates to active deferred modal interaction and cleans up on completion', async () => {
      const interaction = createMockInteraction({
        taskPrompt: 'Continuation run',
        customId: 'modal_dispatch:repo-1',
      });

      let resolveDispatch!: (res: any) => void;
      const dispatchPromise = new Promise((resolve) => {
        resolveDispatch = resolve;
      });

      const notifier = new DiscordNotifier(
        {
          repositories: [{ id: 'repo-1', name: 'Repo One', path: '/opt/repo1' }],
        },
        {
          onDispatchRequested: async () => {
            return dispatchPromise;
          },
        }
      );

      // Submit modal in flight
      const handlePromise = notifier.handleInteraction(interaction);

      // Allow microtasks to execute so deferReply and activeInteractions.set take place
      await new Promise((r) => setImmediate(r));

      // Now relay dispatch status while task is in flight
      await notifier.notifyDispatchStatus({
        status: 'waking',
        repositoryName: 'repo-1',
        message: 'Waking worker node at 00:11:22:33:44:55...',
      });

      assert.deepEqual(interaction.state.editedData, {
        content: 'Waking worker node at 00:11:22:33:44:55...',
      });

      await notifier.notifyDispatchStatus({
        status: 'completed',
        repositoryName: 'repo-1',
        message: 'Continuation ready on branch antigravity/continuation-42',
      });

      assert.deepEqual(interaction.state.editedData, {
        content: 'Continuation ready on branch antigravity/continuation-42',
      });

      // Complete the dispatch
      resolveDispatch({
        success: true,
        branchName: 'antigravity/continuation-42',
        durationMs: 100,
      });

      await handlePromise;

      // Verify that activeInteractions is cleaned up in finally block
      assert.equal(notifier.activeInteractions.size, 0);

      await notifier.shutdown();
    });
  });
});
