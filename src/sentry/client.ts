import { execFile as nodeExecFile } from 'node:child_process';
import { promisify } from 'node:util';
import ky from 'ky';
import { z } from 'zod';
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

const defaultExecFileAsync = promisify(nodeExecFile);

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

// Process Discovery Helper

export interface DiscoveredLanguageServer {
  port?: number;
  ports?: number[];
  csrfToken?: string;
  isHttps?: boolean;
}

export const discoverLocalLanguageServer = async (
  execFileFn = defaultExecFileAsync
): Promise<DiscoveredLanguageServer | null> => {
  try {
    if (process.platform === 'win32') {
      const psScript = `
        $proc = Get-Process -Name 'language_server' -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($proc) {
          $cmd = (Get-CimInstance Win32_Process -Filter "ProcessId = $($proc.Id)" -ErrorAction SilentlyContinue).CommandLine
          $ports = (Get-NetTCPConnection -OwningProcess $proc.Id -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalAddress -eq '127.0.0.1' } | Select-Object -ExpandProperty LocalPort)
          Write-Output "CMD:$cmd"
          Write-Output "PORTS:$($ports -join ',')"
        }
      `;

      const { stdout } = await execFileFn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', psScript],
        { timeout: 4000, windowsHide: true }
      );

      const csrfMatch = /--csrf_token(?:\s+|=)["']?([^\s"']+)["']?/i.exec(stdout);
      const portMatch = /--https_server_port(?:\s+|=)(\d+)/i.exec(stdout);
      const portsMatch = /PORTS:([0-9,]+)/i.exec(stdout);

      const csrfToken = csrfMatch ? csrfMatch[1] : undefined;
      const rawPorts =
        portsMatch && portsMatch[1]
          ? portsMatch[1]
              .split(',')
              .map(Number)
              .filter((n) => !Number.isNaN(n) && n > 0)
          : [];

      const httpsPort = portMatch ? Number(portMatch[1]) : undefined;
      let port = rawPorts.length > 0 ? Math.max(...rawPorts) : undefined;
      if (!port && httpsPort && httpsPort > 0) {
        port = httpsPort + 1;
      }

      if (csrfToken || port || rawPorts.length > 0) {
        return { port, ports: rawPorts, csrfToken, isHttps: false };
      }
    } else {
      const { stdout } = await execFileFn('pgrep', ['-a', 'language_server'], {
        timeout: 3000,
      });
      const csrfMatch = /--csrf_token(?:\s+|=)["']?([^\s"']+)["']?/i.exec(stdout);
      const portMatch = /--https_server_port(?:\s+|=)(\d+)/i.exec(stdout);
      const portsMatch = /PORTS:([0-9,]+)/i.exec(stdout);
      const pidMatch = /^(\d+)/m.exec(stdout.trim());
      const csrfToken = csrfMatch ? csrfMatch[1] : undefined;
      const httpsPort = portMatch ? Number(portMatch[1]) : undefined;
      let port = httpsPort && httpsPort > 0 ? httpsPort + 1 : undefined;

      const rawPorts: number[] =
        portsMatch && portsMatch[1]
          ? portsMatch[1]
              .split(',')
              .map(Number)
              .filter((n) => !Number.isNaN(n) && n > 0)
          : [];

      if (pidMatch && pidMatch[1]) {
        const pid = pidMatch[1];
        try {
          const { stdout: ssOut } = await execFileFn('ss', ['-tlpn'], { timeout: 2000 });
          for (const line of ssOut.split('\n')) {
            if (line.includes(`pid=${pid}`)) {
              const p = /(?:127\.0\.0\.1|:::|0\.0\.0\.0):(\d+)/.exec(line);
              if (p && p[1]) rawPorts.push(Number(p[1]));
            }
          }
        } catch {
          try {
            const { stdout: lsofOut } = await execFileFn(
              'lsof',
              ['-nP', '-iTCP', '-sTCP:LISTEN', '-p', pid],
              { timeout: 2000 }
            );
            for (const line of lsofOut.split('\n')) {
              const p = /:(\d+)\s+\(LISTEN\)/.exec(line);
              if (p && p[1]) rawPorts.push(Number(p[1]));
            }
          } catch {
            // Socket lookup is best-effort
          }
        }
      }

      if (rawPorts.length > 0) {
        port = Math.max(...rawPorts);
      }

      if (csrfToken || port || rawPorts.length > 0) {
        return { port, ports: rawPorts, csrfToken, isHttps: false };
      }
    }
  } catch {
    // Process discovery is best-effort
  }
  return null;
};

// Connect-RPC Client Implementation

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
  private fetchFn?: typeof fetch;
  private execFileFn: (
    file: string,
    args: readonly string[],
    options: Record<string, unknown>
  ) => Promise<{ stdout: string; stderr: string }>;

  constructor(options: ConnectRpcQuotaClientOptions & { minRefreshIntervalMs?: number } = {}) {
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
      try {
        const cliSnapshots = await this.fallbackToCli();
        if (cliSnapshots && cliSnapshots.length > 0) {
          return cliSnapshots;
        }
      } catch (cliErr: unknown) {
        const cliError = cliErr instanceof Error ? cliErr : new Error(String(cliErr));
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
    // Invalidate cached snapshots so next fetch immediately uses updated endpoint
    this.lastFetchedAt = 0;
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
            return aggregateUserQuotaSummary(parsed.data);
          }
        }
      } catch {
        // Fall through to GetCascadeModelConfigData
      }
    }

    // 2. Secondary fallback: GetCascadeModelConfigData
    let lastError: Error | null = null;
    for (const base of targetBases) {
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
        return snapshots;
      } catch (err: unknown) {
        lastError = err instanceof Error ? err : new Error(String(err));
      }
    }

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
