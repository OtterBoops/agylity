import type { NotificationDestination, NotificationDestinationType } from '../shared/contracts.js';
import {
  ENCRYPTION_PREFIX,
  SECRET_JSON_MARKER,
  SECRET_MASK,
  decryptSecret,
  encryptSecret,
  isSecretMask,
} from '../storage/crypto.js';

// The one place that knows how a destination instance is shaped, seeded and encrypted. The config
// store, the migration, the notifier factory and the config controller all read it from here.

export const DESTINATION_SECRET_FIELDS: Record<NotificationDestinationType, readonly string[]> = {
  discord: ['token'],
  webhook: ['url', 'secret', 'customHeaders'],
};

export const DESTINATION_LABELS: Record<NotificationDestinationType, string> = {
  discord: 'Discord Bot',
  webhook: 'Webhook',
};

/** Delivery results and logs key an instance by `<type>:<id>`, never by bare type. */
export const destinationChannelName = (destination: {
  id: string;
  type: NotificationDestinationType;
}): string => `${destination.type}:${destination.id}`;

export const generateDestinationId = (
  type: NotificationDestinationType,
  random = () => Math.random().toString(36).slice(2, 10)
): string => `${type}-${random()}`;

export interface DestinationInputs {
  destinations?: NotificationDestination[] | undefined;
  notificationChannels?: readonly string[] | undefined;
  notificationChannel?: string | undefined;
  discordToken?: string | undefined;
  discordClientId?: string | undefined;
  discordGuildId?: string | undefined;
  discordNotificationChannelId?: string | undefined;
  discordPingOwner?: boolean | undefined;
  notificationWebhookUrl?: string | undefined;
  webhookSecret?: string | undefined;
  webhookCustomHeaders?: Record<string, string> | undefined;
  webhookPingOwner?: boolean | undefined;
}

const isSet = (value: unknown): boolean =>
  typeof value === 'string' ? value.trim() !== '' : value !== undefined && value !== null;

const stringValue = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() !== '' ? value : undefined;

const seedType = (config: DestinationInputs): NotificationDestinationType[] => {
  const plural =
    Array.isArray(config.notificationChannels) && config.notificationChannels.length > 0
      ? config.notificationChannels
      : config.notificationChannel
        ? [config.notificationChannel]
        : [];
  const named = plural.map((entry) => String(entry).trim().toLowerCase());
  const types: NotificationDestinationType[] = [];
  for (const entry of named) {
    if (entry === 'discord' && !types.includes('discord')) types.push('discord');
    if (entry === 'webhook' && !types.includes('webhook')) types.push('webhook');
  }
  return types;
};

const seedDiscord = (config: DestinationInputs): NotificationDestination | null => {
  const token = stringValue(config.discordToken);
  const channelId = stringValue(config.discordNotificationChannelId);
  const clientId = stringValue(config.discordClientId);
  const guildId = stringValue(config.discordGuildId);
  if (!token && !channelId && !clientId && !guildId) return null;
  const values: Record<string, unknown> = {};
  if (token) values.token = token;
  if (channelId) values.channelId = channelId;
  if (clientId) values.clientId = clientId;
  if (guildId) values.guildId = guildId;
  return {
    id: 'discord-seed',
    type: 'discord',
    label: DESTINATION_LABELS.discord,
    enabled: true,
    pingOwner: config.discordPingOwner !== false,
    config: values,
  };
};

const seedWebhook = (config: DestinationInputs): NotificationDestination | null => {
  const url = stringValue(config.notificationWebhookUrl);
  const secret = stringValue(config.webhookSecret);
  const headers =
    config.webhookCustomHeaders && Object.keys(config.webhookCustomHeaders).length > 0
      ? JSON.stringify(config.webhookCustomHeaders)
      : undefined;
  if (!url && !secret && !headers) return null;
  const values: Record<string, unknown> = {};
  if (url) values.url = url;
  if (secret) values.secret = secret;
  if (headers) values.customHeaders = headers;
  return {
    id: 'webhook-seed',
    type: 'webhook',
    label: DESTINATION_LABELS.webhook,
    enabled: true,
    pingOwner: config.webhookPingOwner !== false,
    config: values,
  };
};

/**
 * Explicit instances win. Otherwise `NOTIFICATION_CHANNELS` (or the singular) seeds one instance per
 * named type from the legacy fields, so an existing deployment keeps delivering with no new config.
 */
export const seedNotificationDestinations = (
  config: DestinationInputs
): NotificationDestination[] => {
  const seeded: NotificationDestination[] = [];
  for (const type of seedType(config)) {
    const instance = type === 'discord' ? seedDiscord(config) : seedWebhook(config);
    // A named channel seeds even with no credentials: the adapter exists and its test reports the
    // missing fields, instead of the whole channel silently vanishing from the list.
    seeded.push(
      instance ?? {
        id: `${type}-seed`,
        type,
        label: DESTINATION_LABELS[type],
        enabled: true,
        pingOwner:
          type === 'discord'
            ? config.discordPingOwner !== false
            : config.webhookPingOwner !== false,
        config: {},
      }
    );
  }
  // A single configured destination with no `NOTIFICATION_CHANNELS` entry still has to deliver.
  if (seeded.length === 0) {
    const discord = seedDiscord(config);
    if (discord) seeded.push(discord);
    const webhook = seedWebhook(config);
    if (webhook) seeded.push(webhook);
  }
  return seeded;
};

export const resolveNotificationDestinations = (
  config: DestinationInputs
): NotificationDestination[] => {
  // An explicit array is authoritative even when empty: clearing every instance must not be
  // silently re-seeded from the legacy fields.
  if (Array.isArray(config.destinations)) return config.destinations;
  return seedNotificationDestinations(config);
};

const decodeSecretValue = (plaintext: string): unknown => {
  if (!plaintext.startsWith(SECRET_JSON_MARKER)) return plaintext;
  try {
    return JSON.parse(plaintext.slice(SECRET_JSON_MARKER.length));
  } catch {
    return plaintext.slice(SECRET_JSON_MARKER.length);
  }
};

const mapSecrets = (
  destinations: NotificationDestination[],
  transform: (type: NotificationDestinationType, field: string, value: unknown) => unknown
): NotificationDestination[] =>
  destinations.map((destination) => {
    const fields = DESTINATION_SECRET_FIELDS[destination.type] ?? [];
    if (fields.length === 0) return { ...destination, config: { ...destination.config } };
    const next: Record<string, unknown> = { ...destination.config };
    for (const field of fields) {
      if (!Object.hasOwn(next, field)) continue;
      next[field] = transform(destination.type, field, next[field]);
    }
    return { ...destination, config: next };
  });

/** Encrypts each secret in place; an already-encrypted or masked value is left untouched. */
export const encryptDestinationSecrets = (
  destinations: NotificationDestination[],
  masterKey?: Buffer
): NotificationDestination[] =>
  mapSecrets(destinations, (_type, _field, value) => {
    if (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      Object.keys(value as Record<string, unknown>).length > 0
    ) {
      return encryptSecret(`${SECRET_JSON_MARKER}${JSON.stringify(value)}`, masterKey);
    }
    if (typeof value !== 'string') return value;
    if (value.trim() === '' || isSecretMask(value)) return value;
    if (value.startsWith(ENCRYPTION_PREFIX)) return value;
    return encryptSecret(value, masterKey);
  });

export const decryptDestinationSecrets = (
  destinations: NotificationDestination[],
  masterKey?: Buffer
): NotificationDestination[] =>
  mapSecrets(destinations, (_type, _field, value) => {
    if (typeof value !== 'string' || !value.startsWith(ENCRYPTION_PREFIX)) return value;
    return decodeSecretValue(decryptSecret(value, masterKey));
  });

export interface DestinationSecretsMeta {
  [destinationId: string]: Record<string, { isSet: boolean }>;
}

/** A client view: every secret becomes a mask (or an empty string) plus a per-field `isSet` flag. */
export const maskNotificationDestinations = (
  destinations: NotificationDestination[]
): { destinations: NotificationDestination[]; meta: DestinationSecretsMeta } => {
  const meta: DestinationSecretsMeta = {};
  const masked = destinations.map((destination) => {
    const fields = DESTINATION_SECRET_FIELDS[destination.type] ?? [];
    const fieldMeta: Record<string, { isSet: boolean }> = {};
    const next: Record<string, unknown> = { ...destination.config };
    for (const field of fields) {
      const value = next[field];
      fieldMeta[field] = { isSet: isSet(value) };
      next[field] = isSet(value) ? SECRET_MASK : '';
    }
    if (fields.length > 0) meta[destination.id] = fieldMeta;
    return { ...destination, config: next };
  });
  return { destinations: masked, meta };
};

/**
 * A masked placeholder means "keep what is stored". Values are matched by destination id, so a
 * reordered or renamed instance keeps its own secrets and a new one starts unset.
 */
export const mergeDestinationSecrets = (
  incoming: NotificationDestination[],
  stored: NotificationDestination[]
): NotificationDestination[] => {
  const storedById = new Map(stored.map((destination) => [destination.id, destination]));
  return incoming.map((destination) => {
    const existing = storedById.get(destination.id);
    const fields = DESTINATION_SECRET_FIELDS[destination.type] ?? [];
    const next: Record<string, unknown> = { ...destination.config };
    for (const field of fields) {
      if (!Object.hasOwn(next, field)) continue;
      const value = next[field];
      const keepsStored =
        value === null ||
        value === undefined ||
        (typeof value === 'string' && (value.trim() === '' || isSecretMask(value)));
      if (!keepsStored) continue;
      if (existing && Object.hasOwn(existing.config, field)) {
        next[field] = existing.config[field];
      } else if (isSecretMask(value)) {
        delete next[field];
      }
    }
    return { ...destination, config: next };
  });
};
