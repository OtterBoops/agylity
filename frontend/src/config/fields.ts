import type { FieldDef } from '../components/SettingsForm';

export const MODEL_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'gemini-4-argon', label: 'Gemini 4 Argon' },
  { value: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash' },
  { value: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5' },
  { value: 'claude-opus-5-5', label: 'Claude Opus 5.5' },
  { value: 'gpt-oss-120b', label: 'GPT-OSS 120B' },
];

export const EFFORT_OPTIONS: Array<{
  value: 'low' | 'medium' | 'high';
  label: string;
}> = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
];

type Effort = 'low' | 'medium' | 'high';

const ALL_EFFORTS: Effort[] = ['low', 'medium', 'high'];

/** Bundled effort facts for the pre-load window; the live catalog from /api/models wins. */
const FALLBACK_MODEL_EFFORTS: Record<string, { supported: Effort[]; defaultEffort: Effort }> = {
  'gemini-4-argon': { supported: ALL_EFFORTS, defaultEffort: 'high' },
  'gemini-3.8-flash': { supported: ALL_EFFORTS, defaultEffort: 'medium' },
  'claude-sonnet-5-5': { supported: ALL_EFFORTS, defaultEffort: 'high' },
  'claude-opus-5-5': { supported: ALL_EFFORTS, defaultEffort: 'high' },
  'gpt-oss-120b': { supported: ['medium'], defaultEffort: 'medium' },
};

/** Reads effort rules from the server catalog, so a new model needs no frontend edit. */
export const resolveModelEffort = (
  models: Array<{ id: string; supportedEfforts?: string[]; defaultEffort?: string }>,
  id: string
): { supported: Effort[]; defaultEffort: Effort } => {
  const live = models.find((m) => m.id === id);
  const fallback = FALLBACK_MODEL_EFFORTS[id];
  return {
    supported: live?.supportedEfforts?.length
      ? (live.supportedEfforts as Effort[])
      : (fallback?.supported ?? ALL_EFFORTS),
    defaultEffort:
      (live?.defaultEffort as Effort | undefined) ?? fallback?.defaultEffort ?? 'medium',
  };
};

export const ORCHESTRATOR_FIELDS: FieldDef[] = [
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
    key: 'quotaBurnMaxHours',
    label: 'P2 Quota-Burn reset window (hours)',
    type: 'number',
    placeholder: '2',
    hint: 'Maximum hours remaining before reset to release P2 opportunistic tasks (default: 2h).',
  },
  {
    key: 'quotaBurnMinHeadroomPercent',
    label: 'P2 Quota-Burn minimum headroom (%)',
    type: 'number',
    placeholder: '30',
    hint: 'Minimum remaining pool quota required to release P2 opportunistic tasks (default: 30%).',
  },
  {
    key: 'workerSharedSecret',
    label: 'Fallback shared runner secret (optional)',
    type: 'password',
    colSpan: 2,
    hint: 'Encrypted at rest with AES-256-GCM. Optional fallback token alongside per-runner registration tokens.',
  },
];

export const SENTRY_FIELDS: FieldDef[] = [
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
    placeholder: '24, 12, 3',
    hint: 'Comma-separated hours before reset to trigger warnings.',
  },
  {
    key: 'minDispatchHeadroomPercent',
    label: 'AI safety floor (%)',
    type: 'number',
    hint: 'Block dispatches when quota <= this floor to prevent paid overages (default: 10). Set to 0 if overages do not apply.',
  },
  {
    key: 'quotaAlertThresholdPercent',
    label: 'Alert quota threshold (%)',
    type: 'number',
    hint: 'Only fire milestones if at least this much quota remains unused (default: 25).',
  },
  {
    key: 'antigravityEndpointUrl',
    label: 'Language Server RPC URL',
    type: 'text',
    placeholder: 'http://127.0.0.1:60643',
    hint: 'Custom Antigravity Language Server Connect-RPC URL (optional).',
  },
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
