// Zero imports and erasable syntax only: the frontend bundles this file directly, so a zod or
// node dependency here would leak a server concern into the client build.

export type ReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh';

export type QuotaFamily = 'claude' | 'gemini-argon' | 'gemini-flash';

export const ALL_EFFORTS: readonly ReasoningEffort[] = ['low', 'medium', 'high', 'xhigh'];

export const DEFAULT_DISPATCH_MODEL = 'gemini-4-hydrogen';

export interface AgyModelCatalogEntry {
  id: string;
  label: string;
  family: QuotaFamily;
  defaultEffort: ReasoningEffort;
  supportedEfforts?: readonly ReasoningEffort[];
  defaultForFamily?: boolean;
}

export const CANONICAL_AGY_MODELS: readonly AgyModelCatalogEntry[] = [
  {
    id: 'gemini-3.8-flash',
    label: 'Gemini 3.8 Flash',
    family: 'gemini-flash',
    defaultEffort: 'medium',
    supportedEfforts: ['low', 'medium', 'high'],
  },
  {
    id: 'gemini-4-hydrogen',
    label: 'Gemini 4 Hydrogen',
    family: 'gemini-flash',
    defaultEffort: 'medium',
    supportedEfforts: ['low', 'medium', 'high', 'xhigh'],
    defaultForFamily: true,
  },
  {
    id: 'gemini-4-argon',
    label: 'Gemini 4 Argon',
    family: 'gemini-argon',
    defaultEffort: 'high',
    supportedEfforts: ['low', 'medium', 'high'],
    defaultForFamily: true,
  },
  {
    id: 'claude-sonnet-5-5',
    label: 'Claude Sonnet 5.5',
    family: 'claude',
    defaultEffort: 'high',
    supportedEfforts: ['low', 'medium', 'high'],
    defaultForFamily: true,
  },
  {
    id: 'claude-opus-5-5',
    label: 'Claude Opus 5.5',
    family: 'claude',
    defaultEffort: 'high',
    supportedEfforts: ['low', 'medium', 'high'],
  },
  {
    id: 'gpt-oss-120b',
    label: 'GPT-OSS 120B',
    family: 'claude',
    defaultEffort: 'medium',
    supportedEfforts: ['medium'],
  },
] as const;
