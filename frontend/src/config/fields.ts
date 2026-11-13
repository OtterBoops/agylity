import type { FieldDef } from '../components/SettingsForm';
import type { ModelCatalogEntry, ReasoningEffort } from '../types';

export const MODEL_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'gemini-4-argon', label: 'Gemini 4 Argon' },
  { value: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash' },
  { value: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5' },
  { value: 'claude-opus-5-5', label: 'Claude Opus 5.5' },
  { value: 'gpt-oss-120b', label: 'GPT-OSS 120B' },
];

export const EFFORT_OPTIONS: Array<{
  value: ReasoningEffort;
  label: string;
}> = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'XHigh' },
];

export const PR_POLICY_OPTIONS: Array<{
  value: 'docs_only' | 'all' | 'none';
  label: string;
}> = [
  { value: 'docs_only', label: 'Documentation only (*.md, docs/)' },
  { value: 'all', label: 'All files (Allow code & doc PRs)' },
  { value: 'none', label: 'None (Disable bot PRs & branch pushes)' },
];

const FALLBACK_CATALOG = MODEL_OPTIONS.map((m) => ({ id: m.value }));

/** Collapses a configured model string (e.g. 'gemini-3.8-flash-high') to a catalog id. */
export const normalizeModelId = (
  raw: string | undefined,
  models: Array<{ id: string }> = [],
  fallback = 'gemini-3.8-flash'
): string => {
  if (!raw) return fallback;
  const pool = models.length > 0 ? models : FALLBACK_CATALOG;
  return pool.find((m) => raw === m.id || raw.startsWith(m.id))?.id ?? raw;
};

const ALL_EFFORTS: ReasoningEffort[] = ['low', 'medium', 'high', 'xhigh'];

/** Bundled effort facts for the pre-load window; the live catalog from /api/models wins. */
const FALLBACK_MODEL_EFFORTS: Record<
  string,
  { supported: ReasoningEffort[]; defaultEffort: ReasoningEffort }
> = {
  'gemini-4-argon': { supported: ALL_EFFORTS, defaultEffort: 'high' },
  'gemini-3.8-flash': { supported: ALL_EFFORTS, defaultEffort: 'medium' },
  'claude-sonnet-5-5': { supported: ALL_EFFORTS, defaultEffort: 'high' },
  'claude-opus-5-5': { supported: ALL_EFFORTS, defaultEffort: 'high' },
  'gpt-oss-120b': { supported: ['medium'], defaultEffort: 'medium' },
};

/** Reads effort rules from the server catalog, so a new model needs no frontend edit. */
export const resolveModelEffort = (
  models: Array<Pick<ModelCatalogEntry, 'id'> & Partial<ModelCatalogEntry>>,
  id: string
): { supported: ReasoningEffort[]; defaultEffort: ReasoningEffort } => {
  const live = models.find((m) => m.id === id);
  const fallback = FALLBACK_MODEL_EFFORTS[id];
  return {
    supported: live?.supportedEfforts?.length
      ? live.supportedEfforts
      : (fallback?.supported ?? ALL_EFFORTS),
    defaultEffort: live?.defaultEffort ?? fallback?.defaultEffort ?? 'medium',
  };
};

export const COORDINATOR_FIELDS: FieldDef[] = [
  {
    key: 'defaultDispatchModel',
    label: 'Default dispatch model',
    type: 'select',
    options: MODEL_OPTIONS,
    hint: 'Explicit model passed via --model when dispatching tasks (prevents accidental Claude drain).',
  },
  {
    key: 'defaultDispatchEffort',
    label: 'Default reasoning effort',
    type: 'select',
    options: EFFORT_OPTIONS,
    hint: 'Reasoning effort level passed to agy --effort.',
  },
  {
    key: 'prPolicy',
    label: 'Pull Request policy',
    type: 'select',
    options: PR_POLICY_OPTIONS,
    hint: 'Restricts autonomous tasks (routines and pre-reset triggers) from opening code PRs. Code issues are filed as GitHub Issues instead.',
  },
  {
    key: 'quotaBurnMaxHours',
    label: 'Routine pre-reset window (hours)',
    type: 'number',
    placeholder: '4',
    hint: 'Maximum hours remaining before pool reset to trigger scheduled maintenance routines (default: 4h).',
  },
  {
    key: 'quotaBurnMinHeadroomPercent',
    label: 'Routine minimum headroom floor (%)',
    type: 'number',
    placeholder: '30',
    hint: 'Minimum remaining pool quota required to trigger scheduled maintenance routines (default: 30%).',
  },
  {
    key: 'minDispatchHeadroomPercent',
    label: 'AI safety floor (%)',
    type: 'number',
    hint: 'Block dispatches when quota <= this floor to prevent paid overages (default: 10). Set to 0 if overages do not apply.',
  },
  {
    key: 'allowOverage',
    label: 'Allow billable overage',
    type: 'boolean',
    hint: 'Whether usage past 0% quota may draw purchased credits. The language server does not report this, so set it to match your account.',
  },
  {
    key: 'runnerSharedSecret',
    label: 'Fallback shared runner secret (optional)',
    type: 'password',
    colSpan: 2,
    hint: 'Encrypted at rest with AES-256-GCM. Optional fallback token alongside per-runner registration tokens.',
  },
];

export const SENTRY_GENERAL_FIELDS: FieldDef[] = [
  {
    key: 'quotaCheckIntervalSeconds',
    label: 'Polling interval (seconds)',
    type: 'number',
    hint: 'How often to check rolling quota (default: 60s, minimum: 30s).',
  },
  {
    key: 'quotaMilestoneHours',
    label: 'Alert milestones (hours before reset)',
    type: 'list',
    placeholder: '48, 24, 12',
    hint: 'Comma-separated hours before reset to trigger warnings.',
  },
  {
    key: 'quotaAlertThresholdPercent',
    label: 'Alert quota threshold (%)',
    type: 'number',
    hint: 'Only fire milestones if at least this much quota remains unused (default: 25).',
  },
];

export const NETWORK_SECURITY_FIELDS: FieldDef[] = [
  {
    key: 'allowedIpRanges',
    label: 'Allowed IP Ranges / CIDRs (Whitelist)',
    type: 'list',
    placeholder: '127.0.0.1, 192.168.0.0/16, 176.12.32.119',
    hint: 'Leave empty to allow all incoming traffic (off by default). When entries are added, all non-whitelisted IPs receive HTTP 403 Forbidden.',
  },
  {
    key: 'trustedProxies',
    label: 'Trust Reverse Proxy Headers (Cloudflare / Caddy)',
    type: 'select',
    options: [
      { value: 'false', label: 'Disabled (Direct socket remoteAddress)' },
      { value: 'true', label: 'Enabled (Trust Cf-Connecting-IP, X-Real-IP, X-Forwarded-For)' },
    ],
    hint: 'Inspects Cf-Connecting-IP, X-Real-IP, and X-Forwarded-For headers to resolve client IP behind reverse proxies.',
  },
];

export const TELEMETRY_OVERRIDE_FIELDS: FieldDef[] = [
  {
    key: 'antigravityEndpointUrl',
    label: 'Language Server RPC URL',
    type: 'text',
    placeholder: 'http://127.0.0.1:60643',
    hint: 'Custom Antigravity Language Server Connect-RPC URL (optional).',
  },
];
