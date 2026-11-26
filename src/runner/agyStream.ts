import { tailWindow } from '../shared/text.js';

type Json = Record<string, unknown>;

const PARAM_PREVIEW_LIMIT = 160;
const TEXT_CAP = 65536;
const PARTIAL_EMIT_BYTES = 2048;
const MAX_JSON_PARTIAL_BYTES = 256 * 1024;

const finiteNumber = (value: unknown): number | undefined => {
  if (value === null || value === undefined || value === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const asRecord = (value: unknown): Json | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : undefined;

const compactParams = (parameters: unknown): string => {
  const record = asRecord(parameters);
  if (!record) return '';
  for (const value of Object.values(record)) {
    if (typeof value === 'string' && value.trim() !== '') {
      const single = value.replace(/\s+/g, ' ').trim();
      return single.length > PARAM_PREVIEW_LIMIT
        ? `${single.slice(0, PARAM_PREVIEW_LIMIT)}…`
        : single;
    }
  }
  try {
    const encoded = JSON.stringify(record);
    return encoded.length > PARAM_PREVIEW_LIMIT
      ? `${encoded.slice(0, PARAM_PREVIEW_LIMIT)}…`
      : encoded;
  } catch {
    return '';
  }
};

const durationLabel = (seconds: number | undefined): string =>
  seconds === undefined
    ? ''
    : ` (${seconds < 60 ? `${seconds.toFixed(1)}s` : `${Math.round(seconds)}s`})`;

// One `agy` NDJSON line in, one progress line out: the pane must read like a run, not like JSON.
export class AgyStreamFormatter {
  private partial = '';
  private textBuffer = '';
  private stepText = '';
  private finalResponse = '';
  private sawEvent = false;

  feed(chunk: string): string {
    this.partial += chunk;
    const lines = this.partial.split(/\r?\n/);
    this.partial = lines.pop() ?? '';
    let emitted = '';
    for (const line of lines) emitted += this.consume(line);
    const looksJson = this.partial.trimStart().startsWith('{');
    // Plain text (a rejected flag, a warning) has no newline to wait for, so long runs flush early.
    if (!looksJson && this.partial.length >= PARTIAL_EMIT_BYTES) {
      this.textBuffer = tailWindow(this.textBuffer + this.partial, TEXT_CAP);
      emitted += this.partial;
      this.partial = '';
    } else if (looksJson && this.partial.length > MAX_JSON_PARTIAL_BYTES) {
      // Cap `{`-prefixed lines with no newline so a malformed stream cannot grow memory unbounded.
      this.partial = '';
    }
    return emitted;
  }

  /** Consumes a trailing buffered line when the stream closes without a final newline. */
  flush(): string {
    if (!this.partial) return '';
    const trailing = this.partial;
    this.partial = '';
    return this.consume(trailing);
  }

  private consume(rawLine: string): string {
    const line = rawLine.trim();
    if (!line.startsWith('{')) return line ? `${line}\n` : '';
    let event: Json;
    try {
      event = JSON.parse(line) as Json;
    } catch {
      return '';
    }
    this.sawEvent = true;
    const kind = String(event.event ?? '');
    if (kind === 'init') return '';

    if (kind === 'result') {
      const result = asRecord(event.result);
      if (result && typeof result.response === 'string') this.finalResponse = result.response;
      return '';
    }

    const update = asRecord(event.step_update ?? event);
    if (!update) return '';

    const state = String(update.state ?? '');
    const stepType = String(update.step_type ?? '');

    if (stepType === 'tool') {
      const name = String(update.tool_name ?? asRecord(update.tool_info)?.name ?? 'tool');
      if (state === 'ACTIVE') {
        const info = asRecord(update.tool_info);
        const detail = compactParams(info?.parameters);
        return this.emit(`[tool] ${name}${detail ? `: ${detail}` : ''}`);
      }
      return this.emit(
        `[tool] ${name} done${durationLabel(finiteNumber(update.duration_seconds))}`
      );
    }

    if (stepType === 'agent_response') {
      const delta = typeof update.text_delta === 'string' ? update.text_delta : '';
      if (delta) this.stepText += delta;
      if (state === 'DONE') {
        const step = this.stepText.trim();
        this.stepText = '';
        if (step) return this.emit(step);
      }
      return '';
    }

    return '';
  }

  private emit(line: string): string {
    const rendered = `${line}\n`;
    this.textBuffer = tailWindow(this.textBuffer + rendered, TEXT_CAP);
    return rendered;
  }

  /** Everything the run said, for the PR body and the status report. */
  get text(): string {
    // A stream that closed without a trailing newline may still hold its final event in `partial`.
    if (this.partial.trimStart().startsWith('{')) {
      try {
        JSON.parse(this.partial);
        this.flush();
      } catch {}
    }
    if (!this.sawEvent) return '';
    const tail = this.partial.trimStart().startsWith('{') ? '' : this.partial.trim();
    return (this.finalResponse.trim() || `${this.textBuffer}${tail ? `${tail}\n` : ''}`).trim();
  }
}
