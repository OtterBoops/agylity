import { REST, Routes, SlashCommandBuilder } from 'discord.js';
import { z } from 'zod';
import type { ResolvedConfig } from '../../config/schema.js';
import { logger } from '../../logs/logger.js';

// Task prompt validation schema enforcing 1-4000 character boundaries.
export const TaskPromptSchema = z
  .string()
  .trim()
  .min(1, 'Prompt is required')
  .max(4000, 'Prompt exceeds 4000 character limit');

/** Slash command payloads registered against the Discord application (guild-scoped when configured). */
export const buildSlashCommandDefinitions = (): unknown[] => [
  new SlashCommandBuilder()
    .setName('quota')
    .setDescription('Check remaining Antigravity model quota headroom')
    .toJSON(),
  new SlashCommandBuilder()
    .setName('dispatch')
    .setDescription('Dispatch a background continuation task to Antigravity swarm')
    .addStringOption((opt) =>
      opt
        .setName('repository')
        .setDescription('Target repository ID or name')
        .setRequired(true)
        .setAutocomplete(true)
    )
    .addStringOption((opt) =>
      opt.setName('prompt').setDescription('Task prompt or instructions').setRequired(true)
    )
    .addStringOption((opt) =>
      opt
        .setName('model')
        .setDescription('Model override (e.g. gemini-4-argon, claude-opus-5-5)')
        .setRequired(false)
        .setAutocomplete(true)
    )
    .addStringOption((opt) =>
      opt
        .setName('effort')
        .setDescription('Reasoning effort')
        .setRequired(false)
        .addChoices(
          { name: 'low', value: 'low' },
          { name: 'medium', value: 'medium' },
          { name: 'high', value: 'high' }
        )
    )
    .toJSON(),
];

/** Registers the /quota and /dispatch application commands; no-op without token + client ID. */
export const registerSlashCommands = async (config: ResolvedConfig): Promise<void> => {
  if (!config.discordToken || !config.discordClientId) return;
  try {
    const rest = new REST({ version: '10' }).setToken(config.discordToken);
    const commands = buildSlashCommandDefinitions();

    if (config.discordGuildId) {
      await rest.put(
        Routes.applicationGuildCommands(config.discordClientId, config.discordGuildId),
        { body: commands as any }
      );
    } else {
      await rest.put(Routes.applicationCommands(config.discordClientId), {
        body: commands as any,
      });
    }
    logger
      .child('notify:discord')
      .info('Registered Discord application commands (/quota, /dispatch).');
  } catch (err: any) {
    logger.child('notify:discord').warn('Failed to register Discord commands: %s', err.message);
  }
};
