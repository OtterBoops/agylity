import {
  ALL_EFFORTS,
  CANONICAL_AGY_MODELS,
  CATALOG_BY_ID,
  DEFAULT_MODEL_BY_FAMILY,
  type AgyModelCatalogEntry,
  type ReasoningEffort,
} from './models.js';
import { extractCliJsonPayload } from '../sentry/client.js';
import { defaultExecFileAsync, type ExecFileAsyncFn } from '../sentry/discovery.js';
import { resolveModelFamily } from '../sentry/models.js';
import { logger, type Logger } from '../logs/logger.js';

export interface AgyRawModel {
  id: string;
  label?: string;
}

/** Longest alternative first so `-xhigh` is not matched as `-high`. */
const EFFORT_SUFFIX_RE = /-(xhigh|low|medium|high)$/i;
const LABEL_EFFORT_SUFFIX_RE = /\s*\((xhigh|low|medium|high)\)\s*$/i;

const isReasoningEffort = (value: string): value is ReasoningEffort =>
  (ALL_EFFORTS as readonly string[]).includes(value);

/** `gemini-4-hydrogen-xhigh` -> `gemini-4-hydrogen`; an id with no effort suffix is returned as-is. */
export const baseModelId = (id: string): string => id.trim().replace(EFFORT_SUFFIX_RE, '');

export const effortSuffixOf = (id: string): ReasoningEffort | undefined => {
  const match = EFFORT_SUFFIX_RE.exec(id.trim());
  const suffix = match?.[1]?.toLowerCase();
  return suffix && isReasoningEffort(suffix) ? suffix : undefined;
};

/** `Gemini 4 Hydrogen (XHigh)` -> `Gemini 4 Hydrogen`; falls back to the base id. */
const baseModelLabel = (label: string | undefined, id: string): string => {
  const stripped = (label ?? '').trim().replace(LABEL_EFFORT_SUFFIX_RE, '').trim();
  return stripped !== '' ? stripped : baseModelId(id);
};

/**
 * A model this build already knows keeps its declared default, so a live catalog cannot
 * quietly downshift an established model's reasoning level.
 */
const defaultEffortFor = (id: string, supported: readonly ReasoningEffort[]): ReasoningEffort => {
  const declared = CATALOG_BY_ID.get(id)?.defaultEffort;
  if (declared && supported.includes(declared)) return declared;
  if (supported.includes('medium')) return 'medium';
  if (supported.includes('high')) return 'high';
  return supported[0] ?? 'medium';
};

export interface GroupedModelCatalog {
  models: AgyModelCatalogEntry[];
  /** Codewords the family resolver cannot attribute to a pool; excluded so dispatch stays locked. */
  unattributed: string[];
}

/**
 * Groups `agy --output-format json models` entries into one catalog entry per base model id,
 * deriving supported efforts from the suffixes the CLI actually advertises.
 */
export const groupAgyModels = (raw: readonly AgyRawModel[]): GroupedModelCatalog => {
  const groups = new Map<
    string,
    { label: string; family: ReturnType<typeof resolveModelFamily>; efforts: Set<ReasoningEffort> }
  >();
  const unattributed: string[] = [];

  for (const item of raw) {
    const id = typeof item?.id === 'string' ? item.id.trim() : '';
    if (id === '') continue;

    const base = baseModelId(id);
    const family = resolveModelFamily({ modelId: base, label: baseModelLabel(item.label, id) });
    if (!family) {
      if (!unattributed.includes(base)) unattributed.push(base);
      continue;
    }

    const effort = effortSuffixOf(id);
    const existing = groups.get(base);
    if (existing) {
      if (effort) existing.efforts.add(effort);
    } else {
      groups.set(base, {
        label: baseModelLabel(item.label, id),
        family,
        efforts: new Set(effort ? [effort] : []),
      });
    }
  }

  const models: AgyModelCatalogEntry[] = [];
  for (const [id, group] of groups) {
    const supported = ALL_EFFORTS.filter((e) => group.efforts.has(e));
    models.push({
      id,
      label: group.label,
      family: group.family!.family,
      defaultEffort: defaultEffortFor(id, supported.length > 0 ? supported : ALL_EFFORTS),
      supportedEfforts: supported.length > 0 ? supported : ALL_EFFORTS,
    });
  }

  return { models: applyFamilyDefaults(models), unattributed };
};

/**
 * Exactly one entry per family is that pool's dispatch default. The canonical default wins when
 * the CLI still advertises it, so gemini-flash stays on gemini-3.8-flash.
 */
const applyFamilyDefaults = (models: AgyModelCatalogEntry[]): AgyModelCatalogEntry[] => {
  const families = Object.keys(DEFAULT_MODEL_BY_FAMILY) as Array<
    keyof typeof DEFAULT_MODEL_BY_FAMILY
  >;

  for (const family of families) {
    const candidates = models.filter((m) => m.family === family);
    if (candidates.length === 0) continue;
    const chosen = candidates.some((m) => m.id === DEFAULT_MODEL_BY_FAMILY[family])
      ? DEFAULT_MODEL_BY_FAMILY[family]
      : candidates[0]!.id;
    for (const candidate of candidates) {
      candidate.defaultForFamily = candidate.id === chosen;
    }
  }
  return models;
};

export const parseAgyModelsOutput = (stdout: string): AgyRawModel[] => {
  let payload: any;
  try {
    payload = extractCliJsonPayload(stdout);
  } catch {
    // A banner-only or non-JSON response is an offline/unauthenticated CLI, not a parse error.
    return [];
  }
  const list = payload?.command?.data?.models ?? payload?.models;
  if (!Array.isArray(list)) return [];
  return list
    .filter((m: any): m is AgyRawModel => typeof m?.id === 'string' && m.id.trim() !== '')
    .map((m: any) => ({ id: m.id, label: typeof m.label === 'string' ? m.label : undefined }));
};

export interface ModelCatalogProvider {
  /** Non-blocking: serves the cached catalog and revalidates in the background when stale. */
  getModels(): AgyModelCatalogEntry[];
  refreshModels(): Promise<AgyModelCatalogEntry[]>;
  getUnattributedModels(): string[];
}

export interface DynamicModelCatalogOptions {
  agyBinPath?: string;
  execFileFn?: ExecFileAsyncFn;
  ttlMs?: number;
  timeoutMs?: number;
  logger?: Logger;
  initialCatalog?: readonly AgyModelCatalogEntry[];
}

/**
 * Stale-while-revalidate cache over the CLI's own model list, so the dashboard can show models
 * that shipped after this build without a blocking probe on the request path.
 */
export class DynamicModelCatalog implements ModelCatalogProvider {
  private static readonly DEFAULT_TTL_MS = 5 * 60 * 1000;
  private static readonly DEFAULT_TIMEOUT_MS = 15000;
  // An offline or signed-out CLI still answers requests for the catalog, so a failed probe must
  // pause retries instead of spawning one subprocess per request.
  private static readonly FAILURE_BACKOFF_MS = 60 * 1000;

  private readonly agyBinPath: string;
  private readonly execFileFn: ExecFileAsyncFn;
  private readonly ttlMs: number;
  private readonly timeoutMs: number;
  private readonly log: Logger;
  private cached: AgyModelCatalogEntry[];
  private unattributed: string[] = [];
  private lastFetchedAt = 0;
  private nextAttemptAt = 0;
  private inFlight: Promise<AgyModelCatalogEntry[]> | null = null;

  constructor(options: DynamicModelCatalogOptions = {}) {
    this.agyBinPath =
      options.agyBinPath ?? process.env.REMOTE_AGY_BIN_PATH ?? process.env.AGY_BIN_PATH ?? 'agy';
    this.execFileFn = options.execFileFn ?? defaultExecFileAsync;
    this.ttlMs = options.ttlMs ?? DynamicModelCatalog.DEFAULT_TTL_MS;
    this.timeoutMs = options.timeoutMs ?? DynamicModelCatalog.DEFAULT_TIMEOUT_MS;
    this.log = options.logger ?? logger.child('catalog');
    this.cached = [...(options.initialCatalog ?? CANONICAL_AGY_MODELS)];
  }

  public getModels(): AgyModelCatalogEntry[] {
    const now = Date.now();
    if (now >= this.nextAttemptAt && now - this.lastFetchedAt >= this.ttlMs) {
      void this.refreshModels();
    }
    return this.cached;
  }

  public getUnattributedModels(): string[] {
    return this.unattributed;
  }

  public async refreshModels(): Promise<AgyModelCatalogEntry[]> {
    if (this.inFlight) return this.inFlight;

    this.inFlight = this.query()
      .catch((err: unknown) => {
        // Offline or unauthenticated: keep serving the last known catalog rather than an empty one.
        this.nextAttemptAt = Date.now() + DynamicModelCatalog.FAILURE_BACKOFF_MS;
        this.log.debug(
          'Model catalog refresh failed, serving %d cached entries: %s',
          this.cached.length,
          err instanceof Error ? err.message : String(err)
        );
        return this.cached;
      })
      .finally(() => {
        this.inFlight = null;
      });

    return this.inFlight;
  }

  private async query(): Promise<AgyModelCatalogEntry[]> {
    const { stdout } = await this.execFileFn(
      this.agyBinPath,
      ['--output-format', 'json', 'models'],
      { timeout: this.timeoutMs, windowsHide: true }
    );

    const grouped = groupAgyModels(parseAgyModelsOutput(stdout));
    this.lastFetchedAt = Date.now();
    this.nextAttemptAt = 0;
    this.unattributed = grouped.unattributed;

    if (grouped.unattributed.length > 0) {
      this.log.warn(
        'Model catalog: no quota pool for %s; excluded so dispatch stays locked',
        grouped.unattributed.join(', ')
      );
    }

    if (grouped.models.length === 0) {
      // An empty or unparsable list must not wipe a working catalog.
      return this.cached;
    }

    this.cached = grouped.models;
    return this.cached;
  }
}
