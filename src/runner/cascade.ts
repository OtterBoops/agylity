import { tailWindow } from '../shared/text.js';

export interface TaskExecutionTelemetry {
  conversationId?: string;
  numTurns?: number;
  totalTokens?: number;
  thinkingTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
}

export const finiteNumber = (value: unknown): number | undefined => {
  if (value === null || value === undefined || value === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

// Tolerates non-JSON lines: `agy` interleaves human-readable output with the NDJSON telemetry.
export const parseAgyTelemetry = (stdout?: string): TaskExecutionTelemetry => {
  if (!stdout || !stdout.trim()) return {};
  const telemetry: TaskExecutionTelemetry = {};

  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) continue;
    try {
      const parsed = JSON.parse(trimmed) as Record<string, any>;
      // `stream-json` wraps each payload one level down; a plain JSON line is its own payload.
      const payload: Record<string, any> =
        (parsed.result as Record<string, any>) ??
        (parsed.step_update as Record<string, any>) ??
        parsed;
      // Only the final result carries the run's aggregate usage, so it outranks a step's numbers.
      const aggregated = parsed.event === 'result';
      const take = (key: keyof TaskExecutionTelemetry, value: unknown): void => {
        const numeric = finiteNumber(value);
        if (numeric === undefined) return;
        if (aggregated || telemetry[key] === undefined) {
          (telemetry as Record<string, unknown>)[key] = numeric;
        }
      };

      if (!telemetry.conversationId && typeof payload.conversation_id === 'string') {
        telemetry.conversationId = payload.conversation_id;
      }
      take('numTurns', payload.num_turns ?? payload.turns);

      const usage = (payload.usage ?? payload.token_usage) as Record<string, any> | undefined;
      if (usage && typeof usage === 'object') {
        take('inputTokens', usage.input_tokens);
        take('outputTokens', usage.output_tokens);
        take('thinkingTokens', usage.thinking_tokens);
        take('totalTokens', usage.total_tokens);
      }
      take('totalTokens', payload.total_tokens);
    } catch {}
  }

  if (telemetry.totalTokens === undefined && telemetry.inputTokens !== undefined) {
    telemetry.totalTokens = (telemetry.inputTokens || 0) + (telemetry.outputTokens || 0);
  }

  return telemetry;
};

export const isCapacityExhaustedOutput = (text: string | undefined): boolean => {
  if (!text) return false;
  const normalized = text.toLowerCase().replace(/[_-]+/g, ' ');
  if (/(^|[^0-9])429([^0-9]|$)/.test(normalized)) return true;
  return (
    normalized.includes('model capacity exhausted') ||
    normalized.includes('resource exhausted') ||
    normalized.includes('capacity exhausted') ||
    normalized.includes('too many requests') ||
    normalized.includes('overloaded')
  );
};

export const FLAG_REJECTION_RE =
  /unknown flag|flag provided but not defined|unknown shorthand|invalid argument/i;
export const AGY_USAGE_ERROR_MAX_BYTES = 1024;

export const scanAgyStdout = (stdout: string): { sawStreamEvent: boolean; status: string } => {
  let sawStreamEvent = false;
  const status: string[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    let parsed: Record<string, any>;
    try {
      parsed = JSON.parse(trimmed) as Record<string, any>;
    } catch {
      continue;
    }
    if (typeof parsed.event !== 'string') continue;
    sawStreamEvent = true;
    if (parsed.event !== 'result' || !parsed.result || typeof parsed.result !== 'object') continue;
    for (const key of ['status', 'error', 'state']) {
      const value = parsed.result[key];
      if (typeof value === 'string') status.push(value);
    }
  }
  return { sawStreamEvent, status: status.join('\n') };
};

export const capacityFailureSurface = (err: any): string => {
  const stdout = typeof err?.stdout === 'string' ? err.stdout : '';
  const stderr = typeof err?.stderr === 'string' ? err.stderr : '';
  const { sawStreamEvent, status } = scanAgyStdout(stdout);
  // Stream-json stdout is the agent's own narration; only its final result status is the CLI's.
  return [stderr, sawStreamEvent ? status : stdout].filter(Boolean).join('\n');
};

export interface CapacityContinuationContext {
  failedModel: string;
  statusShort: string;
  diffStat: string;
  tail: string;
  originalPrompt: string;
}

export const buildCapacityContinuationPrompt = (ctx: CapacityContinuationContext): string =>
  [
    '[CONTINUATION CONTEXT]',
    `A previous attempt with model ${ctx.failedModel} was interrupted by upstream capacity exhaustion after making partial progress. Do not redo completed work; finish the remaining work.`,
    '',
    'Current git status:',
    ctx.statusShort || '(clean)',
    '',
    'Diff summary:',
    ctx.diffStat || '(no diff)',
    '',
    'Tail of the interrupted output:',
    tailWindow(ctx.tail, 2000),
    '',
    'Original task:',
    ctx.originalPrompt,
  ].join('\n');

export const hasTelemetryValues = (telemetry: TaskExecutionTelemetry): boolean =>
  telemetry.numTurns !== undefined ||
  telemetry.totalTokens !== undefined ||
  telemetry.thinkingTokens !== undefined;

export const sumAgyTelemetry = (attempts: TaskExecutionTelemetry[]): TaskExecutionTelemetry => {
  const sumOf = (key: 'numTurns' | 'totalTokens' | 'thinkingTokens'): number | undefined => {
    const values = attempts
      .map((attempt) => attempt[key])
      .filter((value): value is number => typeof value === 'number');
    return values.length > 0 ? values.reduce((total, value) => total + value, 0) : undefined;
  };
  return {
    numTurns: sumOf('numTurns'),
    totalTokens: sumOf('totalTokens'),
    thinkingTokens: sumOf('thinkingTokens'),
  };
};
