import type { FieldDef } from '../components/SettingsForm';

export const MODEL_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'gemini-4-argon-high', label: 'Gemini 4 Argon (High)' },
  { value: 'gemini-4-argon-medium', label: 'Gemini 4 Argon (Medium)' },
  { value: 'gemini-4-argon-low', label: 'Gemini 4 Argon (Low)' },
  { value: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash (High)' },
  { value: 'gemini-3.8-flash-medium', label: 'Gemini 3.8 Flash (Medium)' },
  { value: 'gemini-3.8-flash-low', label: 'Gemini 3.8 Flash (Low)' },
  { value: 'claude-sonnet-5-5-high', label: 'Claude Sonnet 5.5 (High)' },
  { value: 'claude-sonnet-5-5-medium', label: 'Claude Sonnet 5.5 (Medium)' },
  { value: 'claude-sonnet-5-5-low', label: 'Claude Sonnet 5.5 (Low)' },
  { value: 'claude-opus-5-5-high', label: 'Claude Opus 5.5 (High)' },
  { value: 'claude-opus-5-5-medium', label: 'Claude Opus 5.5 (Medium)' },
  { value: 'claude-opus-5-5-low', label: 'Claude Opus 5.5 (Low)' },
  { value: 'gpt-oss-120b-medium', label: 'GPT-OSS 120B (Medium)' },
];

export const EFFORT_OPTIONS: Array<{
  value: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  label: string;
}> = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'X-High' },
  { value: 'max', label: 'Max' },
];

export const WORKER_MODE_OPTIONS: Array<{ value: 'headless' | 'visible' | 'any'; label: string }> =
  [
    { value: 'headless', label: 'Headless (Unattended Docker / Server)' },
    { value: 'visible', label: 'Visible (Supervised Desktop Terminal)' },
    { value: 'any', label: 'Any Available Runner' },
  ];

export const PRIORITY_OPTIONS: Array<{ value: 'P0' | 'P1' | 'P2'; label: string; desc: string }> = [
  {
    value: 'P0',
    label: 'P0 — Critical Fast-Track',
    desc: 'Preempts lower tiers; immediate runner execution',
  },
  {
    value: 'P1',
    label: 'P1 — Standard Workflow',
    desc: 'Default priority for routine continuation tasks',
  },
  {
    value: 'P2',
    label: 'P2 — Quota-Burn Opportunistic',
    desc: 'Released when pool reset is imminent with surplus headroom',
  },
];

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
    key: 'defaultWorkerMode',
    label: 'Default runner target mode',
    type: 'select',
    options: WORKER_MODE_OPTIONS,
    hint: 'Target runner class for newly queued continuation tasks.',
  },
  {
    key: 'workerSharedSecret',
    label: 'Fallback shared runner secret (optional)',
    type: 'password',
    hint: 'Encrypted at rest with AES-256-GCM. Optional fallback token alongside per-runner registration tokens.',
  },
  {
    key: 'agyBinPath',
    label: 'Antigravity CLI binary path',
    type: 'text',
    placeholder: 'agy',
    hint: 'Executable name or path for official Antigravity CLI on runners.',
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
    key: 'antigravityLsPort',
    label: 'Language Server Port',
    type: 'number',
    placeholder: '60643',
    hint: 'Primary Language Server port (default: 60643, fallback: 60642).',
  },
  {
    key: 'antigravityCsrfToken',
    label: 'CSRF Token (x-codeium-csrf-token)',
    type: 'password',
    hint: 'Encrypted at rest with AES-256-GCM. Connect-RPC authentication token.',
  },
  {
    key: 'quotaStateFilePath',
    label: 'State persistence file path',
    type: 'text',
    placeholder: 'data/state.json',
    hint: 'State file for milestone alert deduplication.',
  },
];
