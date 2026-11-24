import type { Notifier, NotifierOptions } from './types.js';
import type { ResolvedConfig } from '../config/schema.js';
import { BUILTIN_DEFAULTS } from '../config/schema.js';
import { logger } from '../logs/logger.js';
import { CompositeNotifier, normalizeChannelNames } from './adapters/composite.js';

// Console output is logging now, not a destination: a stored 'console' must not silently become
// "no channels at all", so it is dropped out loud.
const RETIRED_CHANNELS: ReadonlySet<string> = new Set(['console']);
let retiredAnnounced = false;

export { CompositeNotifier } from './adapters/composite.js';

const resolveChannels = (config: ResolvedConfig): string[] => {
  const raw =
    Array.isArray(config.notificationChannels) && config.notificationChannels.length > 0
      ? config.notificationChannels.map((c) => String(c))
      : config.notificationChannel
        ? [String(config.notificationChannel)]
        : [];

  const named = normalizeChannelNames(raw);
  const retired = named.filter((c) => RETIRED_CHANNELS.has(c));
  if (retired.length > 0 && !retiredAnnounced) {
    retiredAnnounced = true;
    logger.warn(
      "Notification channel '%s' is retired; console output is plain logging now.",
      retired.join("', '")
    );
  }
  return named.filter((c) => !RETIRED_CHANNELS.has(c));
};

const instantiateChannels = async (
  channels: string[],
  config: ResolvedConfig,
  options: NotifierOptions | undefined,
  onUnknown: 'throw' | 'skip'
): Promise<Notifier[]> => {
  const notifiers: Notifier[] = [];

  for (const ch of channels) {
    switch (ch) {
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

    channels = normalizeChannelNames(channelOrConfig.split(','));
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
  const notifiers = await instantiateChannels(resolveChannels(config), config, options, 'skip');
  return new CompositeNotifier(notifiers, options, config);
};
