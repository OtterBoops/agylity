import ky from 'ky';
import { z } from 'zod';
import { logger, type Logger } from '../logs/logger.js';
import {
  defaultExecFileAsync,
  discoverLocalLanguageServer,
  type DiscoveredLanguageServer,
  type ExecFileAsyncFn,
} from './discovery.js';
import {
  aggregateQuotaPools,
  aggregateUserQuotaSummary,
  calculateHoursUntilReset,
  LanguageServerResponseSchema,
  RetrieveUserQuotaSummaryResponseSchema,
  resolveModelFamily,
  type QuotaClient as IQuotaClient,
  type QuotaFamily,
  type QuotaSnapshot,
} from './models.js';

export {
  defaultExecFileAsync,
  discoverLocalLanguageServer,
  type DiscoveredLanguageServer,
  type ExecFileAsyncFn,
};

export class LanguageServerError extends Error {
  public readonly code: string;
  public readonly cause?: unknown;

  constructor(message: string, code: string = 'LANGUAGE_SERVER_ERROR', cause?: unknown) {
    super(message);
    this.name = 'LanguageServerError';
    this.code = code;
    this.cause = cause;
  }
}

export const CliModelItemSchema = z.object({
  id: z.string(),
  label: z.string().optional(),
});

export const CliModelsResponseSchema = z.object({
  status: z.string().optional(),
  command: z
    .object({
      name: z.string().optional(),
      data: z
        .object({
          models: z.array(CliModelItemSchema).optional(),
        })
        .optional(),
    })
    .optional(),
  models: z.array(CliModelItemSchema).optional(),
});

export type CliModelsResponse = z.infer<typeof CliModelsResponseSchema>;

/**
 * Extracts a JSON object from CLI stdout, handling leading status banners
 * such as "Fetching available models...\n{\n...".
 */
export const extractCliJsonPayload = (stdout: string): unknown => {
  const trimmed = stdout.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const firstBrace = trimmed.indexOf('{');
    const lastBrace = trimmed.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1));
    }
    throw new SyntaxError('No valid JSON object found in CLI output');
  }
};

export interface ConnectRpcQuotaClientOptions {
  endpointUrl?: string;
  host?: string;
  port?: number;
  csrfToken?: string;
  protocol?: 'http' | 'https';
  timeoutMs?: number;
  fallbackPorts?: number[];
  agyBinPath?: string;
  enableCliFallback?: boolean;
  enableProcessDiscovery?: boolean;
  cachedSnapshotProvider?: () => QuotaSnapshot[];
  logger?: Logger;
  fetchFn?: typeof fetch;
  execFileFn?: (
    file: string,
    args: readonly string[],
    options: Record<string, unknown>
  ) => Promise<{ stdout: string; stderr: string }>;
}

export const RPC_PATH = '/exa.language_server_pb.LanguageServerService/GetCascadeModelConfigData';
export const QUOTA_SUMMARY_RPC_PATH =
  '/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary';

// Connect-RPC Client Implementation

const isConnectionRefused = (err: unknown): boolean => {
  if (!err) return false;
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return (
    msg.includes('econnrefused') ||
    msg.includes('ehostunreach') ||
    msg.includes('enotfound') ||
    msg.includes('connection refused') ||
    msg.includes('failed due to a network error')
  );
};

export class ConnectRpcQuotaClient implements IQuotaClient {
  private static readonly CREDITS_TTL_MS = 5 * 60 * 1000; // 5 minutes
  private endpointUrl?: string;
  private host: string;
  private port: number;
  private csrfToken: string;
  private protocol: 'http' | 'https';
  private timeoutMs: number;
  private fallbackPorts: number[];
  private agyBinPath: string;
  private enableCliFallback: boolean;
  private enableProcessDiscovery: boolean;
  private isCreditsProbing: boolean = false;
  private cachedSnapshotProvider?: () => QuotaSnapshot[];
  private lastKnownSnapshots: QuotaSnapshot[] = [];
  private minRefreshIntervalMs: number;
  private lastFetchedAt: number = 0;
  private activeProvider: 'rpc' | 'cli' | 'unknown' = 'unknown';
  private lastProbeSource: 'connect_rpc' | 'cli_fallback' = 'connect_rpc';
  private nextRpcProbeAt: number = 0;
  private fetchFn?: typeof fetch;
  private logger: Logger;
  private cachedRemainingCredits: number | null = null;
  private lastCreditsProbeAt: number = 0;
  private execFileFn: (
    file: string,
    args: readonly string[],
    options: Record<string, unknown>
  ) => Promise<{ stdout: string; stderr: string }>;

  constructor(options: ConnectRpcQuotaClientOptions & { minRefreshIntervalMs?: number } = {}) {
    this.logger = options.logger ?? logger.child('sentry');
    this.endpointUrl = options.endpointUrl ?? process.env.ANTIGRAVITY_ENDPOINT_URL;
    this.host = options.host ?? '127.0.0.1';
    this.port =
      options.port ??
      (process.env.ANTIGRAVITY_LS_PORT ? Number(process.env.ANTIGRAVITY_LS_PORT) : 60643);
    this.csrfToken = options.csrfToken ?? process.env.ANTIGRAVITY_CSRF_TOKEN ?? '';
    this.protocol = options.protocol ?? 'http';
    this.timeoutMs = options.timeoutMs ?? 5000;
    this.fallbackPorts =
      options.fallbackPorts ?? (this.port === 60643 ? [60643, 60642] : [this.port, 60643, 60642]);
    this.agyBinPath =
      options.agyBinPath ?? process.env.REMOTE_AGY_BIN_PATH ?? process.env.AGY_BIN_PATH ?? 'agy';
    this.enableCliFallback = options.enableCliFallback ?? true;
    this.enableProcessDiscovery = options.enableProcessDiscovery ?? true;
    this.cachedSnapshotProvider = options.cachedSnapshotProvider;
    this.minRefreshIntervalMs =
      options.minRefreshIntervalMs ??
      (process.env.QUOTA_MIN_REFRESH_INTERVAL_MS
        ? Number(process.env.QUOTA_MIN_REFRESH_INTERVAL_MS)
        : 0);
    this.fetchFn = options.fetchFn;
    this.execFileFn = options.execFileFn ?? (defaultExecFileAsync as any);
  }

  /**
   * Fetches rolling model quota snapshots from the Antigravity Language Server.
   * Enforces minimum refresh interval cooldown when configured to prevent API rate limiting.
   * Connect-RPC -> Dual-port fallback -> CLI fallback.
   */
  async fetchQuota(force = false): Promise<QuotaSnapshot[]> {
    // Return cached snapshots if called within minimum refresh cooldown window
    if (
      !force &&
      this.minRefreshIntervalMs > 0 &&
      Array.isArray(this.lastKnownSnapshots) &&
      this.lastKnownSnapshots.length > 0 &&
      Date.now() - this.lastFetchedAt < this.minRefreshIntervalMs
    ) {
      return this.lastKnownSnapshots;
    }

    // Fast path: if already latched to healthy CLI fallback and RPC probe cooldown is active, query CLI directly
    const shouldProbeRpc =
      force ||
      this.activeProvider === 'rpc' ||
      this.activeProvider === 'unknown' ||
      Date.now() >= this.nextRpcProbeAt;

    if (!shouldProbeRpc && this.enableCliFallback) {
      try {
        const cliSnapshots = await this.fallbackToCli();
        if (cliSnapshots && cliSnapshots.length > 0) {
          this.lastKnownSnapshots = cliSnapshots;
          this.lastFetchedAt = Date.now();
          this.lastProbeSource = 'cli_fallback';
          return cliSnapshots;
        }
      } catch (cliErr: unknown) {
        // CLI failed: reset provider to force immediate RPC re-probe
        this.activeProvider = 'unknown';
        this.nextRpcProbeAt = 0;
      }
    }

    let rpcError: Error | null = null;

    // 0. Proactively discover live process credentials if endpointUrl is not explicitly fixed
    if (
      this.enableProcessDiscovery &&
      !this.endpointUrl &&
      (!this.lastFetchedAt || this.port === 60643)
    ) {
      try {
        const discovered = await discoverLocalLanguageServer(this.execFileFn as any);
        this.applyDiscoveredCredentials(discovered);
      } catch {
        // Discovery is best-effort
      }
    }

    // 1. Attempt Connect-RPC over configured endpoint / dual ports
    try {
      const snapshots = await this.tryConnectRpc();
      if (snapshots && snapshots.length > 0) {
        this.activeProvider = 'rpc';
        this.lastProbeSource = 'connect_rpc';
        this.lastKnownSnapshots = snapshots;
        this.lastFetchedAt = Date.now();
        return snapshots;
      }
    } catch (err: unknown) {
      rpcError = err instanceof Error ? err : new Error(String(err));
    }

    // 2. If RPC failed and process discovery is enabled, discover live language_server credentials
    if (this.enableProcessDiscovery) {
      try {
        const discovered = await discoverLocalLanguageServer(this.execFileFn as any);
        if (this.applyDiscoveredCredentials(discovered)) {
          const snapshots = await this.tryConnectRpc();
          if (snapshots && snapshots.length > 0) {
            this.activeProvider = 'rpc';
            this.lastProbeSource = 'connect_rpc';
            this.lastKnownSnapshots = snapshots;
            this.lastFetchedAt = Date.now();
            return snapshots;
          }
        }
      } catch {
        // Discovery retry failed
      }
    }

    // 3. Fallback to agy CLI if enabled
    if (this.enableCliFallback) {
      this.logger.info('Attempting fallback to agy CLI models subcommand (%s)...', this.agyBinPath);
      try {
        const cliSnapshots = await this.fallbackToCli();
        if (cliSnapshots && cliSnapshots.length > 0) {
          this.activeProvider = 'cli';
          this.lastProbeSource = 'cli_fallback';
          this.nextRpcProbeAt = Date.now() + 15 * 60 * 1000;
          this.logger.info('Retrieved %d model pools via agy CLI fallback', cliSnapshots.length);
          this.lastKnownSnapshots = cliSnapshots;
          this.lastFetchedAt = Date.now();
          return cliSnapshots;
        }
      } catch (cliErr: unknown) {
        this.activeProvider = 'unknown';
        this.nextRpcProbeAt = 0;
        const cliError = cliErr instanceof Error ? cliErr : new Error(String(cliErr));
        this.logger.error('CLI fallback failed: %s', cliError.message);
        throw new LanguageServerError(
          `Language Server Connect-RPC failed (${rpcError?.message ?? 'unknown'}) and CLI fallback failed (${cliError.message})`,
          'LANGUAGE_SERVER_UNAVAILABLE',
          { rpcError, cliError }
        );
      }
    }

    // 4. If CLI fallback disabled or failed, throw typed error
    throw new LanguageServerError(
      `Language Server Connect-RPC failed: ${rpcError?.message ?? 'Endpoint unreachable'}`,
      'LANGUAGE_SERVER_UNAVAILABLE',
      rpcError
    );
  }

  private applyDiscoveredCredentials(discovered: any): boolean {
    if (
      discovered?.csrfToken ||
      (discovered?.ports && discovered.ports.length > 0) ||
      discovered?.port
    ) {
      if (discovered.csrfToken) {
        this.csrfToken = discovered.csrfToken;
      }
      if (discovered.ports && discovered.ports.length > 0) {
        this.port = Math.max(...discovered.ports);
        this.fallbackPorts = Array.from(new Set([...discovered.ports, ...this.fallbackPorts]));
      } else if (discovered.port && discovered.port > 1) {
        this.port = discovered.port;
        this.fallbackPorts = Array.from(new Set([discovered.port, ...this.fallbackPorts]));
      }
      this.logger.info(
        'Discovered local language_server (port: %d, csrf: %s)',
        this.port,
        this.csrfToken ? 'configured' : 'none'
      );
      return true;
    }
    return false;
  }

  public getActiveProvider(): 'rpc' | 'cli' | 'unknown' {
    return this.activeProvider;
  }

  public getLastProbeSource(): 'connect_rpc' | 'cli_fallback' {
    return this.lastProbeSource;
  }

  public updateConfig(config: {
    antigravityEndpointUrl?: string;
    antigravityCsrfToken?: string;
  }): void {
    if (config.antigravityEndpointUrl !== undefined) {
      this.endpointUrl = config.antigravityEndpointUrl;
    }
    if (config.antigravityCsrfToken !== undefined) {
      this.csrfToken = config.antigravityCsrfToken;
    }
    // Invalidate cached snapshots and reset active provider so next fetch immediately uses updated endpoint
    this.lastFetchedAt = 0;
    this.activeProvider = 'unknown';
    this.nextRpcProbeAt = 0;
    this.logger.info(
      'Updated Language Server config (endpoint: %s)',
      this.endpointUrl ?? 'dynamic'
    );
  }

  /**
   * Returns cached AI credits immediately without blocking quota queries.
   * Kicks off asynchronous background refresh if cache is stale or missing.
   */
  public async getRemainingCredits(force = false): Promise<number | null> {
    void this.triggerCreditsRefreshInBackground(force);
    return this.cachedRemainingCredits;
  }

  /**
   * Asynchronously probes /credits in the background without blocking callers.
   * On Windows locally, routes through hidden PowerShell to prevent terminal popups.
   * In container / Linux, executes directly.
   */
  public async triggerCreditsRefreshInBackground(force = false): Promise<number | null> {
    const now = Date.now();
    if (
      !force &&
      this.cachedRemainingCredits !== null &&
      now - this.lastCreditsProbeAt < ConnectRpcQuotaClient.CREDITS_TTL_MS
    ) {
      return this.cachedRemainingCredits;
    }
    if (this.isCreditsProbing) {
      return this.cachedRemainingCredits;
    }
    this.isCreditsProbing = true;

    try {
      let stdout: string;
      if (process.platform === 'win32') {
        const script = `& '${this.agyBinPath.replace(/'/g, "''")}' --output-format json -p /credits`;
        const res = await this.execFileFn(
          'powershell.exe',
          ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script],
          { timeout: 15000, windowsHide: true }
        );
        stdout = res.stdout;
      } else {
        const res = await this.execFileFn(
          this.agyBinPath,
          ['--output-format', 'json', '-p', '/credits'],
          { timeout: 15000, windowsHide: true }
        );
        stdout = res.stdout;
      }

      const creditsJson = extractCliJsonPayload(stdout) as any;
      if (typeof creditsJson?.command?.data?.remaining_credits === 'number') {
        const credits = creditsJson.command.data.remaining_credits;
        this.cachedRemainingCredits = credits;
        this.lastCreditsProbeAt = Date.now();
        if (this.lastKnownSnapshots && this.lastKnownSnapshots.length > 0) {
          for (const s of this.lastKnownSnapshots) {
            s.remainingCredits = credits;
          }
        }
        return credits;
      }
    } catch (err: unknown) {
      this.logger.debug(
        'Background credits query failed: %s',
        err instanceof Error ? err.message : String(err)
      );
    } finally {
      this.isCreditsProbing = false;
    }
    return this.cachedRemainingCredits;
  }

  /**
   * Tries to query Language Server Connect-RPC endpoint across configured ports.
   * Priority:
   * 1. RetrieveUserQuotaSummary (provides full dual quota breakdown: weekly & 5-hour limits)
   * 2. GetCascadeModelConfigData (fallback for legacy/mocked environments)
   */
  private async tryConnectRpc(): Promise<QuotaSnapshot[]> {
    const targetBases: string[] = [];

    if (this.endpointUrl && this.endpointUrl.trim() !== '') {
      const base = this.endpointUrl.endsWith('/')
        ? this.endpointUrl.slice(0, -1)
        : this.endpointUrl;
      const stripped = base.replace(RPC_PATH, '').replace(QUOTA_SUMMARY_RPC_PATH, '');
      targetBases.push(stripped);
    } else {
      const distinctPorts = Array.from(new Set([this.port, ...this.fallbackPorts]));
      for (const p of distinctPorts) {
        targetBases.push(`http://${this.host}:${p}`);
      }
    }

    const kyInstance = this.fetchFn ? ky.create({ fetch: this.fetchFn }) : ky;
    const unreachableBases = new Set<string>();

    // 1. First attempt RetrieveUserQuotaSummary (exposes both weekly & 5h limits)
    for (const base of targetBases) {
      try {
        const summaryUrl = `${base}${QUOTA_SUMMARY_RPC_PATH}`;
        const response = await kyInstance.post(summaryUrl, {
          headers: {
            'Content-Type': 'application/json',
            'Connect-Protocol-Version': '1',
            'x-codeium-csrf-token': this.csrfToken,
          },
          json: {},
          timeout: this.timeoutMs,
          retry: {
            limit: 0,
          },
        });

        if (response.ok) {
          const rawJson = await response.json();
          const parsed = RetrieveUserQuotaSummaryResponseSchema.safeParse(rawJson);
          if (parsed.success && parsed.data.response?.groups?.length > 0) {
            const remainingCredits = await this.getRemainingCredits();
            const snapshots = aggregateUserQuotaSummary(parsed.data, Date.now(), {
              remainingCredits,
            });
            const summary = snapshots
              .map(
                (s) => `${s.displayName || s.family}: ${(s.remainingFraction * 100).toFixed(1)}%`
              )
              .join(', ');
            this.logger.info('Quota status: %s', summary);
            return snapshots;
          }
        }
      } catch (err: unknown) {
        if (isConnectionRefused(err)) {
          unreachableBases.add(base);
        }
        this.logger.debug(
          'RetrieveUserQuotaSummary probe failed on %s: %s',
          base,
          err instanceof Error ? err.message : String(err)
        );
        // Fall through to GetCascadeModelConfigData
      }
    }

    // 2. Secondary fallback: GetCascadeModelConfigData (skip bases where connection was refused)
    const reachableBases = targetBases.filter((b) => !unreachableBases.has(b));
    let lastError: Error | null = null;
    for (const base of reachableBases) {
      try {
        const cascadeUrl = `${base}${RPC_PATH}`;
        const response = await kyInstance.post(cascadeUrl, {
          headers: {
            'Content-Type': 'application/json',
            'Connect-Protocol-Version': '1',
            'x-codeium-csrf-token': this.csrfToken,
          },
          json: {},
          timeout: this.timeoutMs,
          retry: {
            limit: 0,
          },
        });

        if (!response.ok) {
          const bodyText = await response.text().catch(() => '');
          throw new LanguageServerError(
            `RPC returned HTTP ${response.status}: ${bodyText}`,
            `HTTP_${response.status}`
          );
        }

        const rawJson = await response.json();
        const parsed = LanguageServerResponseSchema.parse(rawJson);
        const remainingCredits = await this.getRemainingCredits();
        const snapshots = aggregateQuotaPools(parsed.clientModelConfigs, Date.now(), {
          remainingCredits,
        });
        const summary = snapshots
          .map((s) => `${s.displayName || s.family}: ${(s.remainingFraction * 100).toFixed(1)}%`)
          .join(', ');
        this.logger.info('Quota status: %s', summary);
        return snapshots;
      } catch (err: unknown) {
        lastError = err instanceof Error ? err : new Error(String(err));
        this.logger.debug('CascadeModelConfig probe failed on %s: %s', base, lastError.message);
      }
    }

    this.logger.debug(
      'Connect-RPC failed across all target ports: %s',
      lastError?.message ?? 'Endpoint unreachable'
    );
    throw lastError || new LanguageServerError('Failed to connect to Language Server RPC');
  }

  /**
   * Executes agy CLI models subcommand as fallback.
   */
  async fallbackToCli(): Promise<QuotaSnapshot[]> {
    // 1. First attempt authoritative agy -p "/usage" (100% parity with Language Server RetrieveUserQuotaSummary)
    try {
      const { stdout: usageStdout } = await this.execFileFn(
        this.agyBinPath,
        ['--output-format', 'json', '-p', '/usage'],
        { timeout: 15000, windowsHide: true }
      );

      const usageJson = extractCliJsonPayload(usageStdout) as any;
      if (usageJson?.command?.name === 'usage' && usageJson?.command?.data?.groups) {
        // Query /credits for exact G1 AI credit balance
        const remainingCredits = await this.getRemainingCredits();

        const groups = usageJson.command.data.groups.map((g: any) => ({
          displayName: g.name,
          description: g.description,
          buckets: (g.buckets || []).map((b: any) => ({
            bucketId: b.id,
            displayName: b.name,
            description: b.description,
            window: b.window,
            remainingFraction: b.remaining_fraction,
            resetTime: b.reset_time,
          })),
        }));

        const transformed = {
          response: {
            groups,
            description: usageJson.command.data.description,
          },
        };

        const parsed = RetrieveUserQuotaSummaryResponseSchema.safeParse(transformed);
        if (parsed.success) {
          const snapshots = aggregateUserQuotaSummary(parsed.data, Date.now(), {
            remainingCredits,
          });
          if (snapshots.length > 0) {
            return snapshots;
          }
        }
      }
    } catch (usageErr: unknown) {
      this.logger.debug(
        'agy -p "/usage" failed: %s; falling back to agy models',
        usageErr instanceof Error ? usageErr.message : String(usageErr)
      );
    }

    const { stdout } = await this.execFileFn(
      this.agyBinPath,
      ['--output-format', 'json', 'models'],
      { timeout: 10000, windowsHide: true }
    );

    let parsedCli: CliModelsResponse;
    try {
      const json = extractCliJsonPayload(stdout);
      parsedCli = CliModelsResponseSchema.parse(json);
    } catch (err: unknown) {
      throw new LanguageServerError(
        `Failed to parse CLI models output: ${err instanceof Error ? err.message : String(err)}`,
        'CLI_PARSE_ERROR'
      );
    }

    const rawModels = parsedCli.command?.data?.models ?? parsedCli.models ?? [];
    if (rawModels.length === 0) {
      throw new LanguageServerError('CLI returned empty models list', 'CLI_EMPTY_MODELS');
    }

    // 1. If we have recent snapshots from previous RPC or provider, update hoursUntilReset
    const cached = this.cachedSnapshotProvider?.() ?? this.lastKnownSnapshots;
    if (cached && cached.length > 0) {
      const now = Date.now();
      const modelsByFamily = new Map<QuotaFamily, string[]>();
      for (const m of rawModels) {
        const resolved = resolveModelFamily({ modelId: m.id, label: m.label || m.id });
        if (!resolved) continue;
        const list = modelsByFamily.get(resolved.family) ?? [];
        list.push(m.label || m.id);
        modelsByFamily.set(resolved.family, list);
      }

      return cached.map((s) => {
        const hoursUntilReset = calculateHoursUntilReset(s.resetTime, now);
        const remainingFraction = hoursUntilReset > 0 ? s.remainingFraction : 1.0;
        const cliModels = modelsByFamily.get(s.family);
        const models =
          s.models && s.models.length > 0
            ? s.models
            : cliModels && cliModels.length > 0
              ? [...cliModels].sort()
              : s.models;

        return {
          ...s,
          remainingFraction,
          hoursUntilReset: Math.max(0, hoursUntilReset),
          models,
        };
      });
    }

    // 2. Synthesize baseline snapshots for detected model families
    const poolsMap = new Map<
      QuotaFamily,
      { family: QuotaFamily; displayName: string; models: string[] }
    >();

    for (const m of rawModels) {
      const resolved = resolveModelFamily({ modelId: m.id, label: m.label || m.id });
      if (!resolved) continue;

      const { family, displayName } = resolved;
      const label = m.label || m.id;

      if (!poolsMap.has(family)) {
        poolsMap.set(family, {
          family,
          displayName,
          models: [label],
        });
      } else {
        poolsMap.get(family)!.models.push(label);
      }
    }

    const now = Date.now();
    const fallbackReset = new Date(now + 24 * 3600 * 1000).toISOString();
    const result: QuotaSnapshot[] = [];

    const order: Record<QuotaFamily, number> = {
      'gemini-flash': 0,
      'gemini-argon': 1,
      claude: 2,
    };

    for (const entry of poolsMap.values()) {
      result.push({
        poolId: entry.family,
        family: entry.family,
        displayName: entry.displayName,
        remainingFraction: 1.0, // CLI does not return fractions; retain full headroom in degraded state
        resetTime: fallbackReset,
        hoursUntilReset: 24,
        models: entry.models.sort(),
      });
    }

    return result.sort((a, b) => order[a.family] - order[b.family]);
  }
}

// Alias class matching QuotaClient contract for direct instantiation
export const QuotaClient = ConnectRpcQuotaClient;
