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
  private cachedSnapshotProvider?: () => QuotaSnapshot[];
  private lastKnownSnapshots: QuotaSnapshot[] = [];
  private minRefreshIntervalMs: number;
  private lastFetchedAt: number = 0;
  private activeProvider: 'rpc' | 'cli' | 'unknown' = 'unknown';
  private nextRpcProbeAt: number = 0;
  private fetchFn?: typeof fetch;
  private logger: Logger;
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
        this.fallbackPorts = [...discovered.ports, ...this.fallbackPorts];
      } else if (discovered.port && discovered.port > 1) {
        this.port = discovered.port;
        this.fallbackPorts = [discovered.port, ...this.fallbackPorts];
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

  public updateConfig(config: {
    antigravityEndpointUrl?: string;
    antigravityCsrfToken?: string;
    antigravityLsPort?: number;
  }): void {
    if (config.antigravityEndpointUrl !== undefined) {
      this.endpointUrl = config.antigravityEndpointUrl;
    }
    if (config.antigravityCsrfToken !== undefined) {
      this.csrfToken = config.antigravityCsrfToken;
    }
    if (config.antigravityLsPort !== undefined) {
      this.port = config.antigravityLsPort;
      this.fallbackPorts = [config.antigravityLsPort, ...this.fallbackPorts];
    }
    // Invalidate cached snapshots and reset active provider so next fetch immediately uses updated endpoint
    this.lastFetchedAt = 0;
    this.activeProvider = 'unknown';
    this.nextRpcProbeAt = 0;
    this.logger.info(
      'Updated Language Server config (endpoint: %s, port: %d)',
      this.endpointUrl ?? 'dynamic',
      this.port
    );
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
            const snapshots = aggregateUserQuotaSummary(parsed.data);
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
        const snapshots = aggregateQuotaPools(parsed.clientModelConfigs);
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
    const { stdout } = await this.execFileFn(
      this.agyBinPath,
      ['--output-format', 'json', 'models'],
      { timeout: 10000, windowsHide: true }
    );

    let parsedCli: CliModelsResponse;
    try {
      const json = JSON.parse(stdout);
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
      return cached.map((s) => ({
        ...s,
        hoursUntilReset: calculateHoursUntilReset(s.resetTime, now),
      }));
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
      claude: 0,
      'gemini-argon': 1,
      'gemini-flash': 2,
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
