import type { Notifier, NotifierOptions } from './types.js';
import type { ResolvedConfig } from '../config/schema.js';
import { BUILTIN_DEFAULTS } from '../config/schema.js';

/**
 * Creates an isolated Notifier adapter instance based on the active channel.
 *
 * Isolation Invariant:
 * Inactive notification channels (e.g. console, webhook) NEVER import or evaluate
 * discord.js or its dependencies into V8 memory.
 */
export const createNotifier = async (
  channelOrConfig: string | ResolvedConfig,
  configOrOptions?: ResolvedConfig | NotifierOptions,
  maybeOptions?: NotifierOptions
): Promise<Notifier> => {
  let channel: string;
  let config: ResolvedConfig;
  let options: NotifierOptions | undefined;

  if (typeof channelOrConfig === 'string') {
    channel = channelOrConfig;
    if (configOrOptions && 'notificationChannel' in configOrOptions) {
      config = configOrOptions as ResolvedConfig;
      options = maybeOptions;
    } else {
      config = { ...BUILTIN_DEFAULTS, notificationChannel: channel as any };
      options = configOrOptions as NotifierOptions | undefined;
    }
  } else {
    config = channelOrConfig;
    channel = config.notificationChannel;
    options = configOrOptions as NotifierOptions | undefined;
  }

  const normalized = (channel || '').toLowerCase().trim();

  switch (normalized) {
    case 'console': {
      const { ConsoleNotifier } = await import('./adapters/console.js');
      return new ConsoleNotifier(config, options);
    }
    case 'webhook': {
      const { WebhookNotifier } = await import('./adapters/console.js');
      return new WebhookNotifier(config, options);
    }
    case 'discord': {
      const { DiscordNotifier } = await import('./adapters/discord.js');
      return new DiscordNotifier(config, options);
    }
    default:
      throw new Error(`Unknown notification channel: ${channel}`);
  }
};
