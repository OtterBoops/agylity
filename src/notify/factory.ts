import type { Notifier, NotifierOptions } from './types.js';
import type { ResolvedConfig } from '../config/schema.js';
import { BUILTIN_DEFAULTS } from '../config/schema.js';
import { CompositeNotifier } from './adapters/composite.js';

export { CompositeNotifier } from './adapters/composite.js';

/**
 * Creates an isolated Notifier adapter instance based on the active channels.
 *
 * Isolation Invariant:
 * Inactive notification channels (e.g. console, webhook) NEVER import or evaluate
 * discord.js or its dependencies into V8 memory unless 'discord' is explicitly enabled.
 */
export const createNotifier = async (
  channelOrConfig: string | ResolvedConfig,
  configOrOptions?: ResolvedConfig | NotifierOptions,
  maybeOptions?: NotifierOptions
): Promise<Notifier> => {
  let channels: string[];
  let config: ResolvedConfig;
  let options: NotifierOptions | undefined;

  if (typeof channelOrConfig === 'string') {
    const rawChannelStr = channelOrConfig;
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

    channels = rawChannelStr
      .split(',')
      .map((c) => c.trim())
      .filter((c) => Boolean(c) && c.toLowerCase() !== 'none');
  } else {
    config = channelOrConfig;
    options = configOrOptions as NotifierOptions | undefined;

    if (Array.isArray(config.notificationChannels) && config.notificationChannels.length > 0) {
      channels = config.notificationChannels
        .map((c) => String(c).trim())
        .filter((c) => Boolean(c) && c.toLowerCase() !== 'none');
    } else if (config.notificationChannel) {
      const single = String(config.notificationChannel).trim();
      channels = single && single.toLowerCase() !== 'none' ? [single] : [];
    } else {
      channels = [];
    }
  }

  // Deduplicate channels
  const uniqueChannels = Array.from(new Set(channels));

  if (uniqueChannels.length === 0) {
    return new CompositeNotifier([]);
  }

  const instantiatedNotifiers: Notifier[] = [];

  for (const rawCh of uniqueChannels) {
    const ch = rawCh.toLowerCase();
    switch (ch) {
      case 'console': {
        const { ConsoleNotifier } = await import('./adapters/console.js');
        instantiatedNotifiers.push(new ConsoleNotifier(config, options));
        break;
      }
      case 'webhook': {
        const { WebhookNotifier } = await import('./adapters/webhook.js');
        instantiatedNotifiers.push(new WebhookNotifier(config, options));
        break;
      }
      case 'discord': {
        const { DiscordNotifier } = await import('./adapters/discord.js');
        instantiatedNotifiers.push(new DiscordNotifier(config, options));
        break;
      }
      default:
        throw new Error(`Unknown notification channel: ${rawCh}`);
    }
  }

  if (instantiatedNotifiers.length === 1 && instantiatedNotifiers[0]) {
    return instantiatedNotifiers[0];
  }

  return new CompositeNotifier(instantiatedNotifiers);
};
