import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AgyStreamFormatter } from '../../src/runner/agyStream.js';
import { parseAgyTelemetry } from '../../src/runner/executor.js';

// Captured from a real `agy --output-format stream-json` run.
const EVENTS = [
  {
    event: 'init',
    conversation_id: '5d935187',
    init: { model: 'gemini-3.8-flash', tools: ['run_command'] },
  },
  {
    event: 'step_update',
    step_update: {
      conversation_id: '5d935187',
      step_index: 0,
      state: 'DONE',
      step_type: 'user_input',
    },
  },
  {
    event: 'step_update',
    step_update: {
      conversation_id: '5d935187',
      step_index: 1,
      state: 'DONE',
      step_type: 'agent_response',
      duration_seconds: 4.142968,
      usage: {
        input_tokens: 15750,
        output_tokens: 284,
        thinking_tokens: 245,
        total_tokens: 16034,
      },
    },
  },
  {
    event: 'step_update',
    step_update: {
      conversation_id: '5d935187',
      step_index: 2,
      state: 'ACTIVE',
      step_type: 'tool',
      tool_name: 'run_command',
      tool_info: { name: 'run_command', parameters: { CommandLine: 'Get-ChildItem .' } },
    },
  },
  {
    event: 'step_update',
    step_update: {
      conversation_id: '5d935187',
      step_index: 2,
      state: 'DONE',
      step_type: 'tool',
      tool_name: 'run_command',
      duration_seconds: 4.182344,
      tool_info: { name: 'run_command', output: 'Command exited with code 0.' },
    },
  },
  {
    event: 'step_update',
    step_update: {
      conversation_id: '5d935187',
      step_index: 3,
      state: 'ACTIVE',
      step_type: 'agent_response',
      text_delta: 'done',
    },
  },
  {
    event: 'step_update',
    step_update: {
      conversation_id: '5d935187',
      step_index: 3,
      state: 'DONE',
      step_type: 'agent_response',
      text_delta: '\n',
      duration_seconds: 1.62,
    },
  },
  {
    event: 'result',
    result: {
      conversation_id: '5d935187',
      status: 'SUCCESS',
      response: 'done\n',
      duration_seconds: 9.8864705,
      num_turns: 1,
      usage: {
        input_tokens: 19399,
        output_tokens: 285,
        thinking_tokens: 245,
        cache_read_tokens: 13709,
        total_tokens: 19684,
      },
    },
  },
];

const NDJSON = EVENTS.map((event) => JSON.stringify(event)).join('\n');

describe('Runner: agy stream-json progress', () => {
  it('renders one progress line per tool call and keeps the final response as the deliverable', () => {
    const formatter = new AgyStreamFormatter();
    let emitted = '';
    // Replay in 7-character chunks: a line straddling two reads must not be dropped or doubled.
    for (let offset = 0; offset < NDJSON.length; offset += 7) {
      emitted += formatter.feed(NDJSON.slice(offset, offset + 7));
    }

    assert.equal(emitted.includes('"event"'), false);
    assert.equal(emitted.includes('[tool] run_command: Get-ChildItem .\n'), true);
    assert.equal(emitted.includes('[tool] run_command done (4.2s)\n'), true);
    assert.equal(emitted.includes('done\n'), true);
    assert.equal(formatter.text, 'done');
  });

  it('unwraps the result event for the run telemetry', () => {
    const telemetry = parseAgyTelemetry(NDJSON);

    assert.equal(telemetry.conversationId, '5d935187');
    assert.equal(telemetry.totalTokens, 19684);
    assert.equal(telemetry.inputTokens, 19399);
    assert.equal(telemetry.outputTokens, 285);
    assert.equal(telemetry.thinkingTokens, 245);
    assert.equal(telemetry.numTurns, 1);
  });

  it('caps unbounded non-JSON {-prefixed partial lines and ignores indented partial JSON in text', () => {
    const formatter = new AgyStreamFormatter();
    formatter.feed(`${JSON.stringify({ event: 'init', conversation_id: 'c1' })}\n`);
    formatter.feed(
      `${JSON.stringify({
        event: 'step_update',
        step_update: {
          step_index: 1,
          state: 'DONE',
          step_type: 'agent_response',
          text_delta: 'ok',
        },
      })}\n`
    );

    // Indented incomplete JSON must not leak into `text` and must not parse before newline.
    formatter.feed('   {"event":"step_update","partial":true');
    assert.equal(formatter.text, 'ok');

    // Exceeding the 256 KB partial cap drops the malformed `{`-prefixed line instead of growing unbounded.
    formatter.feed('x'.repeat(260 * 1024));
    assert.equal(formatter.text, 'ok');
  });

  it('preserves surrogate pairs when textBuffer rolls past the 64 KB cap', () => {
    const formatter = new AgyStreamFormatter();
    formatter.feed(`${JSON.stringify({ event: 'init', conversation_id: 'c1' })}\n`);
    // Fill with 2-code-unit emoji so a raw .slice(-65536) at an odd offset would split a surrogate pair.
    const chunk = 'a' + '🚀'.repeat(40_000);
    formatter.feed(
      `${JSON.stringify({
        event: 'step_update',
        step_update: {
          step_index: 1,
          state: 'DONE',
          step_type: 'agent_response',
          text_delta: chunk,
        },
      })}\n`
    );

    const text = formatter.text;
    assert.ok(text.length > 0);
    const firstCode = text.charCodeAt(0);
    assert.equal(
      firstCode >= 0xdc00 && firstCode <= 0xdfff,
      false,
      'textBuffer must never start with a lone low surrogate'
    );
  });
});
