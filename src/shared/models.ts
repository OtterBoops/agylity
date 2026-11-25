// Zero imports and erasable syntax only: the frontend bundles this file directly, so a zod or
// node dependency here would leak a server concern into the client build.

export type ReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh';

export type PoolGroup = 'gemini' | 'claude';

export const ALL_EFFORTS: readonly ReasoningEffort[] = ['low', 'medium', 'high', 'xhigh'];

// Every pool group the build knows about, in display order. The quota grid renders one cell per
// group, so a plan that lacks one still shows it rather than leaving a hole in the row.
export const POOL_GROUPS: readonly PoolGroup[] = ['gemini', 'claude'];

export const POOL_GROUP_LABELS: Record<PoolGroup, string> = {
  gemini: 'Gemini Models',
  claude: 'Claude and GPT models',
};

// Card titles name the bucket, so they use the short label alone: "Gemini pool", "Claude pool".
export const POOL_GROUP_SHORT_LABELS: Record<PoolGroup, string> = {
  gemini: 'Gemini',
  claude: 'Claude',
};

export const DEFAULT_DISPATCH_MODEL = 'gemini-4-hydrogen';

export const DEFAULT_DISPATCH_EFFORT: ReasoningEffort = 'medium';

// Pool groups that were merged or renamed after shipping. A pool id is either the group id or
// `<group>:<slug>`, so only the prefix carries the group name and only the prefix may be rewritten.
// Order matters: when a legacy database still holds several of these, the first one listed claims
// the merged id and the later duplicates collapse into it.
export const LEGACY_POOL_GROUPS: Readonly<Record<string, PoolGroup>> = {
  'gemini-hydrogen': 'gemini',
  'gemini-flash': 'gemini',
  hydrogen: 'gemini',
  flash: 'gemini',
  'gemini-argon': 'gemini',
  argon: 'gemini',
  // Claude pools written before the two ids were merged into one group.
  sonnet: 'claude',
  '3p': 'claude',
};

export const upgradePoolGroupId = (poolId: string): string => {
  for (const [legacy, poolGroup] of Object.entries(LEGACY_POOL_GROUPS)) {
    if (poolId === legacy || poolId.startsWith(`${legacy}:`)) {
      return `${poolGroup}${poolId.slice(legacy.length)}`;
    }
  }
  return poolId;
};

export const LEGACY_POOL_GROUP_IDS: readonly string[] = Object.keys(LEGACY_POOL_GROUPS);

export interface AgyModelCatalogEntry {
  id: string;
  label: string;
  poolGroup: PoolGroup;
  defaultEffort: ReasoningEffort;
  supportedEfforts?: readonly ReasoningEffort[];
  defaultForGroup?: boolean;
}

export const CANONICAL_AGY_MODELS: readonly AgyModelCatalogEntry[] = [
  {
    id: 'gemini-3.8-flash',
    label: 'Gemini 3.8 Flash',
    poolGroup: 'gemini',
    defaultEffort: 'medium',
    supportedEfforts: ['low', 'medium', 'high'],
  },
  {
    id: 'gemini-4-hydrogen',
    label: 'Gemini 4 Hydrogen',
    poolGroup: 'gemini',
    defaultEffort: 'medium',
    supportedEfforts: ['low', 'medium', 'high', 'xhigh'],
    defaultForGroup: true,
  },
  {
    id: 'gemini-4-neon',
    label: 'Gemini 4 Neon',
    poolGroup: 'gemini',
    defaultEffort: 'medium',
    supportedEfforts: ['low', 'medium', 'high', 'xhigh'],
  },
  {
    id: 'gemini-4-carbon',
    label: 'Gemini 4 Carbon',
    poolGroup: 'gemini',
    defaultEffort: 'high',
    supportedEfforts: ['low', 'medium', 'high'],
  },
  {
    id: 'gemini-4-argon',
    label: 'Gemini 4 Argon',
    poolGroup: 'gemini',
    defaultEffort: 'high',
    supportedEfforts: ['low', 'medium', 'high'],
  },
  // Orchestrator routes carry no effort variants, and agy bills them to the pool they name.
  {
    id: 'gemini-pro-orchestrator-neon',
    label: 'Orchestrator (Neon)',
    poolGroup: 'gemini',
    defaultEffort: 'medium',
    supportedEfforts: [],
  },
  {
    id: 'gemini-pro-orchestrator',
    label: 'Orchestrator (Carbon)',
    poolGroup: 'gemini',
    defaultEffort: 'medium',
    supportedEfforts: [],
  },
  {
    id: 'gemini-pro-orchestrator-argon',
    label: 'Orchestrator (Argon)',
    poolGroup: 'gemini',
    defaultEffort: 'medium',
    supportedEfforts: [],
  },
  {
    id: 'claude-sonnet-5-5',
    label: 'Claude Sonnet 5.5',
    poolGroup: 'claude',
    defaultEffort: 'high',
    supportedEfforts: ['low', 'medium', 'high'],
    defaultForGroup: true,
  },
  {
    id: 'claude-opus-5-5',
    label: 'Claude Opus 5.5',
    poolGroup: 'claude',
    defaultEffort: 'high',
    supportedEfforts: ['low', 'medium', 'high'],
  },
  {
    id: 'gpt-oss-120b',
    label: 'GPT-OSS 120B',
    poolGroup: 'claude',
    defaultEffort: 'medium',
    supportedEfforts: ['medium'],
  },
] as const;

// Orchestrator routes expose no effort variants, so `agy` rejects `--effort` for them.
export const isOrchestratorModelId = (modelId: string | undefined): boolean =>
  /orchestrator/i.test((modelId ?? '').trim());

// False means the flag must be omitted: a guessed `--effort` fails the whole agy invocation.
export const modelSupportsEffort = (
  modelId: string | undefined,
  supportedEfforts?: readonly ReasoningEffort[] | null
): boolean => {
  const id = (modelId ?? '').trim().toLowerCase();
  if (isOrchestratorModelId(id)) return false;
  if (supportedEfforts) return supportedEfforts.length > 0;
  const declared = CANONICAL_AGY_MODELS.find((entry) => entry.id === id)?.supportedEfforts;
  return declared ? declared.length > 0 : true;
};
