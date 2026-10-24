import { EventEmitter } from 'node:events';
import { AppDatabase } from '../storage/db.js';
import { BUILTIN_DEFAULTS, parseRawEnv, type AppConfig, type ResolvedConfig } from './schema.js';

export interface IConfigStore {
  get<T>(key: string): T | undefined;
  set<T>(key: string, value: T): void;
  delete(key: string): void;
  getAll(): Record<string, unknown>;
  resolveConfig(): ResolvedConfig;
}

const ENV_TO_CONFIG_KEY: Record<string, keyof AppConfig> = {
  NOTIFICATION_CHANNELS: 'notificationChannels',
  NOTIFICATION_CHANNEL: 'notificationChannel',
  NOTIFICATION_WEBHOOK_URL: 'notificationWebhookUrl',
  WEBHOOK_URL: 'notificationWebhookUrl',
  WEBHOOK_SECRET: 'webhookSecret',
  WEBHOOK_CUSTOM_HEADERS: 'webhookCustomHeaders',
  DISCORD_TOKEN: 'discordToken',
  DISCORD_CLIENT_ID: 'discordClientId',
  DISCORD_GUILD_ID: 'discordGuildId',
  DISCORD_NOTIFICATION_CHANNEL_ID: 'discordNotificationChannelId',
  ANTIGRAVITY_ENDPOINT_URL: 'antigravityEndpointUrl',
  ANTIGRAVITY_CSRF_TOKEN: 'antigravityCsrfToken',
  ANTIGRAVITY_LS_PORT: 'antigravityLsPort',
  QUOTA_CHECK_INTERVAL_SECONDS: 'quotaCheckIntervalSeconds',
  QUOTA_ALERT_THRESHOLD_PERCENT: 'quotaAlertThresholdPercent',
  QUOTA_MILESTONE_HOURS: 'quotaMilestoneHours',
  QUOTA_STATE_FILE_PATH: 'quotaStateFilePath',
  MIN_DISPATCH_HEADROOM_PERCENT: 'minDispatchHeadroomPercent',
  REPOSITORIES_JSON: 'repositories',
  DATABASE_PATH: 'databasePath',
  ORCHESTRATOR_ENABLED: 'orchestratorEnabled',
  WEB_UI_ENABLED: 'webUiEnabled',
  WEB_UI_PORT: 'webUiPort',
  WEB_UI_HOST: 'webUiHost',
};

const normalizeKey = (key: string): keyof AppConfig | string => ENV_TO_CONFIG_KEY[key] ?? key;

export class ConfigStore extends EventEmitter implements IConfigStore {
  private database: AppDatabase;
  private envConfig: Partial<AppConfig>;
  private defaults: AppConfig;

  constructor(dbOrPath?: string | AppDatabase, envOverride?: Partial<AppConfig>) {
    super();
    this.envConfig = envOverride ?? parseRawEnv(process.env);
    this.defaults = { ...BUILTIN_DEFAULTS };

    if (dbOrPath instanceof AppDatabase) {
      this.database = dbOrPath;
    } else {
      const activeDbPath = dbOrPath ?? this.envConfig.databasePath ?? this.defaults.databasePath;
      this.database = new AppDatabase(activeDbPath);
    }
  }

  public getDatabase(): AppDatabase {
    return this.database;
  }

  public getAllOverrides(): Partial<AppConfig> {
    return Object.fromEntries(
      Object.entries(this.database.getAll()).map(([k, v]) => [normalizeKey(k), v])
    ) as Partial<AppConfig>;
  }

  public getAll(): Record<string, unknown> {
    return this.getAllOverrides();
  }

  public resolveConfig(): ResolvedConfig {
    const overrides = this.getAllOverrides();
    const resolved: Partial<AppConfig> = {};

    for (const key of Object.keys(this.defaults) as Array<keyof AppConfig>) {
      (resolved as Record<string, unknown>)[key] =
        overrides[key] ?? this.envConfig[key] ?? this.defaults[key];
    }

    // Synchronize notificationChannels and notificationChannel
    if (overrides.notificationChannels !== undefined) {
      resolved.notificationChannels = overrides.notificationChannels;
      resolved.notificationChannel = resolved.notificationChannels[0] ?? 'none';
    } else if (overrides.notificationChannel !== undefined) {
      resolved.notificationChannel = overrides.notificationChannel;
      resolved.notificationChannels =
        overrides.notificationChannel !== 'none' ? [overrides.notificationChannel] : [];
    } else if (this.envConfig.notificationChannels !== undefined) {
      resolved.notificationChannels = this.envConfig.notificationChannels;
      resolved.notificationChannel = resolved.notificationChannels[0] ?? 'none';
    } else if (this.envConfig.notificationChannel !== undefined) {
      resolved.notificationChannel = this.envConfig.notificationChannel;
      resolved.notificationChannels =
        this.envConfig.notificationChannel !== 'none' ? [this.envConfig.notificationChannel] : [];
    }

    return resolved as ResolvedConfig;
  }

  public getResolvedConfig(): ResolvedConfig {
    return this.resolveConfig();
  }

  public get<T = unknown>(key: string): T | undefined {
    const normKey = normalizeKey(key) as keyof AppConfig;

    // Level 1: SQLite
    const sqliteVal = this.database.get(normKey as string) ?? this.database.get(key);
    if (sqliteVal !== undefined && sqliteVal !== null) {
      return sqliteVal as T;
    }

    // Level 2: Environment Variables
    const envVal = this.envConfig[normKey];
    if (envVal !== undefined && envVal !== null) {
      return envVal as unknown as T;
    }

    // Level 3: Built-in Defaults
    if (normKey in this.defaults) {
      return this.defaults[normKey] as unknown as T;
    }

    return undefined;
  }

  public setOverride<K extends keyof AppConfig>(key: K | string, value: unknown): void {
    const normKey = normalizeKey(key as string);
    const prev = this.get(normKey as string);
    this.database.set(normKey as string, value);

    const resolved = this.resolveConfig();
    this.emit('change', {
      key: normKey,
      previousValue: prev,
      newValue: value,
      resolvedConfig: resolved,
    });
    this.emit(`change:${normKey}`, value, resolved);
  }

  public set<T>(key: string, value: T): void {
    this.setOverride(key, value);
  }

  public removeOverride<K extends keyof AppConfig>(key: K | string): void {
    const normKey = normalizeKey(key as string);
    const prev = this.get(normKey as string);
    this.database.delete(normKey as string);
    if (normKey !== key) {
      this.database.delete(key as string);
    }

    const resolved = this.resolveConfig();
    const currentVal = this.get(normKey as string);
    this.emit('change', {
      key: normKey,
      previousValue: prev,
      newValue: currentVal,
      resolvedConfig: resolved,
    });
    this.emit(`change:${normKey}`, currentVal, resolved);
  }

  public deleteOverride<K extends keyof AppConfig>(key: K | string): void {
    this.removeOverride(key);
  }

  public delete(key: string): void {
    this.removeOverride(key);
  }

  public clearAllOverrides(): void {
    this.database.clear();
    const resolved = this.resolveConfig();
    this.emit('change', {
      key: '*',
      previousValue: null,
      newValue: null,
      resolvedConfig: resolved,
    });
  }

  public close(): void {
    this.database.close();
  }
}

export default ConfigStore;
