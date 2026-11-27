import type { Notifier, NotifierOptions } from './types.js';
import type { ResolvedConfig } from '../config/schema.js';
import { BUILTIN_DEFAULTS } from '../config/schema.js';
import { logger } from '../logs/logger.js';
import { CompositeNotifier, normalizeChannelNames } from './adapters/composite.js';
import {
  decryptDestinationSecrets,
  destinationChannelName,
  seedNotificationDestinations,
} from '../config/destinations.js';
import type { NotificationDestination } from '../shared/contracts.js';

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

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

const parsedHeaders = (value: unknown): Record<string, string> | undefined => {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, string>;
  }
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  try {
    const decoded = JSON.parse(value);
    return decoded && typeof decoded === 'object' && !Array.isArray(decoded)
      ? (decoded as Record<string, string>)
      : undefined;
  } catch {
    return undefined;
  }
};

/** One instance's own values overlaid on the resolved config, so the adapters read one place. */
export const applyDestinationConfig = (
  config: ResolvedConfig,
  destination: NotificationDestination
): ResolvedConfig => {
  const values = destination.config ?? {};
  const base: ResolvedConfig = {
    ...config,
    notificationChannel: destination.type,
    notificationChannels: [destination.type],
    destinations: [destination],
  };
  if (destination.type === 'discord') {
    return {
      ...base,
      discordToken: text(values.token) || undefined,
      discordNotificationChannelId: text(values.channelId) || undefined,
      discordClientId: text(values.clientId) || undefined,
      discordGuildId: text(values.guildId) || undefined,
      discordPingOwner: destination.pingOwner,
    };
  }
  return {
    ...base,
    notificationWebhookUrl: text(values.url) || undefined,
    webhookSecret: text(values.secret) || undefined,
    webhookCustomHeaders: parsedHeaders(values.customHeaders),
    webhookPingOwner: destination.pingOwner,
  };
};

const instantiateDestination = async (
  destination: NotificationDestination,
  config: ResolvedConfig,
  options: NotifierOptions | undefined
): Promise<Notifier> => {
  const instanceConfig = applyDestinationConfig(config, destination);
  const instanceOptions: NotifierOptions = {
    ...options,
    channelName: destinationChannelName(destination),
  };
  if (destination.type === 'discord') {
    const { DiscordNotifier } = await import('./adapters/discord.js');
    return new DiscordNotifier(instanceConfig, instanceOptions);
  }
  const { WebhookNotifier } = await import('./adapters/webhook.js');
  return new WebhookNotifier(instanceConfig, instanceOptions);
};

export const createNotifierForDestination = instantiateDestination;

/** Destinations in the config; an absent array seeds from the legacy fields. Ciphertext needs the key. */
export const resolvedDestinations = (
  config: ResolvedConfig,
  masterKey?: Buffer
): NotificationDestination[] => {
  const list = Array.isArray(config.destinations)
    ? config.destinations
    : seedNotificationDestinations(config);
  return masterKey ? decryptDestinationSecrets(list, masterKey) : list;
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
  if (typeof channelOrConfig !== 'string') {
    const config = channelOrConfig;
    const options = configOrOptions as NotifierOptions | undefined;
    const destinations = resolvedDestinations(config).filter((destination) => destination.enabled);
    if (destinations.length === 0) return new CompositeNotifier([], options, config);
    const notifiers = await Promise.all(
      destinations.map((destination) => instantiateDestination(destination, config, options))
    );
    if (notifiers.length === 1 && notifiers[0]) return notifiers[0];
    return new CompositeNotifier(notifiers, options, config);
  }

  let config: ResolvedConfig;
  let options: NotifierOptions | undefined;
  if (
    configOrOptions &&
    ('notificationChannels' in configOrOptions || 'notificationChannel' in configOrOptions)
  ) {
    config = configOrOptions as ResolvedConfig;
    options = maybeOptions;
  } else {
    config = { ...BUILTIN_DEFAULTS, destinations: [] } as ResolvedConfig;
    options = configOrOptions as NotifierOptions | undefined;
  }

  const channels = normalizeChannelNames(channelOrConfig.split(','));
  if (channels.length === 0) {
    return new CompositeNotifier([], options);
  }

  const instantiatedNotifiers = await instantiateChannels(channels, config, options, 'throw');

  if (instantiatedNotifiers.length === 1 && instantiatedNotifiers[0]) {
    return instantiatedNotifiers[0];
  }

  return new CompositeNotifier(instantiatedNotifiers, options, config);
};

export const createDaemonNotifier = async (
  config: ResolvedConfig,
  options?: NotifierOptions,
  masterKey?: Buffer
): Promise<CompositeNotifier> => {
  const destinations = resolvedDestinations(config, masterKey);
  const enabled = destinations.filter((destination) => destination.enabled);

  // A legacy `console`/`none` value still has to log its retirement even when destinations exist.
  resolveChannels(config);

  const notifiers = await Promise.all(
    enabled.map((destination) => instantiateDestination(destination, config, options))
  );
  const composite = new CompositeNotifier(notifiers, options, config);
  composite.setDestinations(destinations);
  return composite;
};
