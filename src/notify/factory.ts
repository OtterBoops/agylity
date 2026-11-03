import type { Notifier, NotifierOptions } from './types.js';
import type { ResolvedConfig } from '../config/schema.js';
import { BUILTIN_DEFAULTS } from '../config/schema.js';
import { CompositeNotifier } from './adapters/composite.js';

export { CompositeNotifier } from './adapters/composite.js';

/** Channels resolve from the plural form first; blanks, 'none' and duplicates are dropped. */
const resolveChannels = (config: ResolvedConfig): string[] => {
  const raw =
    Array.isArray(config.notificationChannels) && config.notificationChannels.length > 0
      ? config.notificationChannels.map((c) => String(c))
      : config.notificationChannel
        ? [String(config.notificationChannel)]
        : [];

  return Array.from(
    new Set(raw.map((c) => c.trim().toLowerCase()).filter((c) => Boolean(c) && c !== 'none'))
  );
};

/** One instantiation table, so a new adapter is registered in a single place. */
const instantiateChannels = async (
  channels: string[],
  config: ResolvedConfig,
  options: NotifierOptions | undefined,
  onUnknown: 'throw' | 'skip'
): Promise<Notifier[]> => {
  const notifiers: Notifier[] = [];

  for (const ch of channels) {
    switch (ch) {
      case 'console': {
        const { ConsoleNotifier } = await import('./adapters/console.js');
        notifiers.push(new ConsoleNotifier(config, options));
        break;
      }
      case 'webhook': {
        const { WebhookNotifier } = await import('./adapters/webhook.js');
        notifiers.push(new WebhookNotifier(config, options));
        break;
      }
      case 'discord': {
        const { DiscordNotifier } = await import('./adapters/discord.js');
        notifiers.push(new DiscordNotifier(config, options));
        break;
      }
      default:
        if (onUnknown === 'throw') {
          throw new Error(`Unknown notification channel: ${ch}`);
        }
    }
  }

  return notifiers;
};

// Inactive channels must never import discord.js into memory; only 'discord' may.
export const createNotifier = async (
  channelOrConfig: string | ResolvedConfig,
  configOrOptions?: ResolvedConfig | NotifierOptions,
  maybeOptions?: NotifierOptions
): Promise<Notifier> => {
  let channels: string[];
  let config: ResolvedConfig;
  let options: NotifierOptions | undefined;

  if (typeof channelOrConfig === 'string') {
    if (
      configOrOptions &&
      ('notificationChannels' in configOrOptions || 'notificationChannel' in configOrOptions)
    ) {
      config = configOrOptions as ResolvedConfig;
      options = maybeOptions;
    } else {
      config = { ...BUILTIN_DEFAULTS };
      options = configOrOptions as NotifierOptions | undefined;
    }

    channels = Array.from(
      new Set(
        channelOrConfig
          .split(',')
          .map((c) => c.trim().toLowerCase())
          .filter((c) => Boolean(c) && c !== 'none')
      )
    );
  } else {
    config = channelOrConfig;
    options = configOrOptions as NotifierOptions | undefined;
    channels = resolveChannels(config);
  }

  if (channels.length === 0) {
    return new CompositeNotifier([], options);
  }

  const instantiatedNotifiers = await instantiateChannels(channels, config, options, 'throw');

  if (instantiatedNotifiers.length === 1 && instantiatedNotifiers[0]) {
    return instantiatedNotifiers[0];
  }

  return new CompositeNotifier(instantiatedNotifiers, options);
};

export const createDaemonNotifier = async (
  config: ResolvedConfig,
  options?: NotifierOptions
): Promise<CompositeNotifier> => {
  // A daemon must survive a channel typo, so an unknown channel is skipped rather than fatal.
  const notifiers = await instantiateChannels(resolveChannels(config), config, options, 'skip');
  return new CompositeNotifier(notifiers, options, config);
};
