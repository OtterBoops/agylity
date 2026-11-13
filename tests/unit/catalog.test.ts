import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import ky from 'ky';
import { makeTempDir } from '../e2e/harness/index.js';
import { ConfigStore } from '../../src/config/store.js';
import { startWebServer, closeWebServer } from '../../src/web/server.js';
import {
  baseModelId,
  effortSuffixOf,
  groupAgyModels,
  parseAgyModelsOutput,
  DynamicModelCatalog,
} from '../../src/coordinator/catalog.js';
import {
  ALL_EFFORTS,
  CANONICAL_AGY_MODELS,
  DEFAULT_MODEL_BY_FAMILY,
  ReasoningEffortSchema,
  resolveConcreteModelId,
  resolveReasoningEffortForModel,
} from '../../src/coordinator/models.js';
import { resolveModelFamily } from '../../src/sentry/models.js';

const jsonEnvelope = (models: Array<{ id: string; label?: string }>): string =>
  JSON.stringify({
    conversation_id: '',
    status: 'SUCCESS',
    command: { name: 'models', data: { models } },
  });

// Shape captured from a real `agy --output-format json models` run.
const LIVE_MODELS = [
  { id: 'gemini-4-argon-medium', label: 'Gemini 4 Argon (Medium)' },
  { id: 'gemini-4-argon-high', label: 'Gemini 4 Argon (High)' },
  { id: 'gemini-4-argon-low', label: 'Gemini 4 Argon (Low)' },
  { id: 'gemini-4-hydrogen-high', label: 'Gemini 4 Hydrogen (High)' },
  { id: 'gemini-4-hydrogen-xhigh', label: 'Gemini 4 Hydrogen (XHigh)' },
  { id: 'gemini-4-hydrogen-medium', label: 'Gemini 4 Hydrogen (Medium)' },
  { id: 'gemini-4-hydrogen-low', label: 'Gemini 4 Hydrogen (Low)' },
  { id: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash (High)' },
  { id: 'gemini-3.8-flash-medium', label: 'Gemini 3.8 Flash (Medium)' },
  { id: 'gemini-3.8-flash-low', label: 'Gemini 3.8 Flash (Low)' },
  { id: 'claude-opus-5-5-low', label: 'Claude Opus 5.5 (Low)' },
  { id: 'claude-opus-5-5-medium', label: 'Claude Opus 5.5 (Medium)' },
  { id: 'claude-opus-5-5-high', label: 'Claude Opus 5.5 (High)' },
  { id: 'claude-sonnet-5-5-low', label: 'Claude Sonnet 5.5 (Low)' },
  { id: 'claude-sonnet-5-5-medium', label: 'Claude Sonnet 5.5 (Medium)' },
  { id: 'claude-sonnet-5-5-high', label: 'Claude Sonnet 5.5 (High)' },
  { id: 'gpt-oss-120b-medium', label: 'GPT-OSS 120B (Medium)' },
];

describe('Dynamic Model Catalog: agy models parsing, grouping & pool attribution', () => {
  describe('1. Suffix parsing', () => {
    it('strips an effort suffix without mangling a dotted model version', () => {
      assert.equal(baseModelId('gemini-4-hydrogen-xhigh'), 'gemini-4-hydrogen');
      assert.equal(baseModelId('gemini-3.8-flash-medium'), 'gemini-3.8-flash');
      assert.equal(baseModelId('claude-opus-5-5-low'), 'claude-opus-5-5');
      assert.equal(baseModelId('gpt-oss-120b-medium'), 'gpt-oss-120b');
      assert.equal(baseModelId('gemini-4-argon'), 'gemini-4-argon');
    });

    it('reads xhigh as its own suffix, not as high', () => {
      assert.equal(effortSuffixOf('gemini-4-hydrogen-xhigh'), 'xhigh');
      assert.equal(effortSuffixOf('gemini-4-hydrogen-high'), 'high');
      assert.equal(effortSuffixOf('gemini-4-hydrogen'), undefined);
    });

    it('treats xhigh as a valid reasoning effort everywhere', () => {
      assert.ok(ALL_EFFORTS.includes('xhigh'));
      assert.equal(ReasoningEffortSchema.parse('xhigh'), 'xhigh');
    });
  });

  describe('2. Output parsing', () => {
    it('reads the command.data.models envelope, ignoring a leading status banner', () => {
      const stdout = `Fetching available models...\n${jsonEnvelope(LIVE_MODELS)}`;
      const parsed = parseAgyModelsOutput(stdout);
      assert.equal(parsed.length, LIVE_MODELS.length);
      assert.equal(parsed[0]?.id, 'gemini-4-argon-medium');
    });

    it('accepts a bare models array and drops entries without an id', () => {
      const parsed = parseAgyModelsOutput(
        JSON.stringify({ models: [{ id: 'gemini-4-argon-high' }, { label: 'no id' }, {}] })
      );
      assert.deepEqual(parsed, [{ id: 'gemini-4-argon-high', label: undefined }]);
    });

    it('returns an empty list for unparsable output instead of throwing', () => {
      assert.deepEqual(parseAgyModelsOutput('not json at all'), []);
      assert.deepEqual(parseAgyModelsOutput(''), []);
    });
  });

  describe('3. Grouping by base model id', () => {
    const grouped = groupAgyModels(LIVE_MODELS);
    const byId = new Map(grouped.models.map((m) => [m.id, m]));

    it('collapses effort variants into one entry per base model', () => {
      assert.deepEqual(grouped.models.map((m) => m.id).sort(), [
        'claude-opus-5-5',
        'claude-sonnet-5-5',
        'gemini-3.8-flash',
        'gemini-4-argon',
        'gemini-4-hydrogen',
        'gpt-oss-120b',
      ]);
    });

    it('derives a display label without the effort qualifier', () => {
      assert.equal(byId.get('gemini-4-hydrogen')?.label, 'Gemini 4 Hydrogen');
      assert.equal(byId.get('gemini-3.8-flash')?.label, 'Gemini 3.8 Flash');
    });

    it('derives supportedEfforts from the advertised suffixes, including xhigh', () => {
      assert.deepEqual(byId.get('gemini-4-hydrogen')?.supportedEfforts, [
        'low',
        'medium',
        'high',
        'xhigh',
      ]);
      assert.deepEqual(byId.get('gemini-3.8-flash')?.supportedEfforts, ['low', 'medium', 'high']);
      assert.deepEqual(byId.get('gpt-oss-120b')?.supportedEfforts, ['medium']);
    });

    it("preserves a known model's declared default effort through the live catalog", () => {
      // gemini-4-argon and claude-sonnet-5-5 are canonical 'high'; a live probe must not downshift them.
      assert.equal(byId.get('gemini-4-argon')?.defaultEffort, 'high');
      assert.equal(byId.get('claude-sonnet-5-5')?.defaultEffort, 'high');
      assert.equal(byId.get('gemini-3.8-flash')?.defaultEffort, 'medium');
    });

    it('defaults a model this build has never seen to medium', () => {
      assert.equal(byId.get('gemini-4-hydrogen')?.defaultEffort, 'medium');
      assert.equal(byId.get('gpt-oss-120b')?.defaultEffort, 'medium');
    });

    it('keeps gemini-3.8-flash as the gemini-flash pool default despite Hydrogen existing', () => {
      const flashDefaults = grouped.models.filter(
        (m) => m.family === 'gemini-flash' && m.defaultForFamily
      );
      assert.deepEqual(
        flashDefaults.map((m) => m.id),
        ['gemini-3.8-flash']
      );
      assert.equal(DEFAULT_MODEL_BY_FAMILY['gemini-flash'], 'gemini-3.8-flash');
    });

    it('marks exactly one default per family', () => {
      const byFamily = new Map<string, string[]>();
      for (const m of grouped.models) {
        if (!m.defaultForFamily) continue;
        byFamily.set(m.family, [...(byFamily.get(m.family) ?? []), m.id]);
      }
      for (const [family, ids] of byFamily) {
        assert.equal(ids.length, 1, `${family} must have one default, got ${ids.join(', ')}`);
      }
    });

    it('confines xhigh to models that advertise it', () => {
      for (const m of grouped.models) {
        if (m.id === 'gemini-4-hydrogen') continue;
        assert.ok(
          !m.supportedEfforts?.includes('xhigh'),
          `${m.id} must not offer xhigh without advertising it`
        );
      }
    });
  });

  describe('4. Family resolution for new codenames', () => {
    it('maps gemini-4-hydrogen into the gemini-flash pool', () => {
      assert.equal(resolveModelFamily({ modelId: 'gemini-4-hydrogen' })?.family, 'gemini-flash');
      assert.equal(
        resolveModelFamily({ modelId: 'gemini-4-hydrogen', label: 'Gemini 4 Hydrogen' })?.family,
        'gemini-flash'
      );
    });

    it('does not misclassify gemini-pro-orchestrator-g1-pro as gemini-flash', () => {
      const resolved = resolveModelFamily({ modelId: 'gemini-pro-orchestrator-g1-pro' });
      assert.notEqual(resolved?.family, 'gemini-flash');
      assert.equal(resolved?.family, 'gemini-argon');
    });

    it('still resolves every previously-known family', () => {
      assert.equal(resolveModelFamily({ modelId: 'gemini-4-argon-high' })?.family, 'gemini-argon');
      assert.equal(
        resolveModelFamily({ modelId: 'gemini-3.8-flash-high' })?.family,
        'gemini-flash'
      );
      assert.equal(resolveModelFamily({ modelId: 'claude-sonnet-5-5-high' })?.family, 'claude');
      assert.equal(resolveModelFamily({ modelId: 'unknown-model-xyz' }), null);
    });

    it('reports a pool-less codename as unattributed rather than guessing', () => {
      const grouped = groupAgyModels([
        { id: 'gemini-4-hydrogen-high' },
        { id: 'totally-unknown-model-high' },
      ]);
      assert.deepEqual(grouped.unattributed, ['totally-unknown-model']);
      assert.deepEqual(
        grouped.models.map((m) => m.id),
        ['gemini-4-hydrogen']
      );
    });

    it('keeps no pool-less entry in the catalog, so dispatch eligibility fails closed', () => {
      const grouped = groupAgyModels([{ id: 'mystery-model-xhigh' }]);
      assert.deepEqual(grouped.models, []);
    });
  });

  describe('5. Effort resolution with xhigh', () => {
    it('grants xhigh only where the canonical entry declares it', () => {
      assert.equal(resolveReasoningEffortForModel('gemini-4-hydrogen', 'xhigh'), 'xhigh');
      assert.equal(resolveReasoningEffortForModel('gemini-3.8-flash', 'xhigh'), 'medium');
    });

    it('clamps an xhigh id suffix onto the base model for eligibility', () => {
      assert.equal(resolveConcreteModelId('gemini-4-hydrogen-xhigh'), 'gemini-4-hydrogen');
    });
  });

  describe('6. Stale-while-revalidate provider', () => {
    const makeCatalog = (
      exec: () => Promise<{ stdout: string; stderr: string }>,
      ttlMs = 60_000
    ): DynamicModelCatalog =>
      new DynamicModelCatalog({
        execFileFn: async () => exec(),
        ttlMs,
        logger: {
          debug: () => {},
          info: () => {},
          warn: () => {},
          error: () => {},
          child: () => ({}) as never,
        } as never,
      });

    it('serves the bundled canonical catalog before any probe resolves', () => {
      const provider = makeCatalog(async () => ({ stdout: jsonEnvelope(LIVE_MODELS), stderr: '' }));
      const initial = provider.getModels();
      assert.deepEqual(
        initial.map((m) => m.id),
        CANONICAL_AGY_MODELS.map((m) => m.id)
      );
    });

    it('publishes the live catalog after a refresh', async () => {
      const provider = makeCatalog(async () => ({ stdout: jsonEnvelope(LIVE_MODELS), stderr: '' }));
      await provider.refreshModels();
      const ids = provider.getModels().map((m) => m.id);
      assert.ok(ids.includes('gemini-4-hydrogen'));
    });

    it('keeps the last good catalog when the CLI is offline or unauthenticated', async () => {
      let call = 0;
      const provider = makeCatalog(async () => {
        call += 1;
        if (call === 1) return { stdout: jsonEnvelope(LIVE_MODELS), stderr: '' };
        throw new Error('Please sign in to view available models');
      });

      await provider.refreshModels();
      const good = provider.getModels().map((m) => m.id);
      await provider.refreshModels();
      assert.deepEqual(
        provider.getModels().map((m) => m.id),
        good
      );
    });

    it('keeps the last good catalog when the CLI returns an empty list', async () => {
      let call = 0;
      const provider = makeCatalog(async () => {
        call += 1;
        return {
          stdout: call === 1 ? jsonEnvelope(LIVE_MODELS) : jsonEnvelope([]),
          stderr: '',
        };
      });

      await provider.refreshModels();
      const good = provider.getModels().map((m) => m.id);
      await provider.refreshModels();
      assert.deepEqual(
        provider.getModels().map((m) => m.id),
        good
      );
    });

    it('surfaces unattributed codenames so the UI can report them', async () => {
      const provider = makeCatalog(async () => ({
        stdout: jsonEnvelope([...LIVE_MODELS, { id: 'mystery-model-high' }]),
        stderr: '',
      }));
      await provider.refreshModels();
      assert.deepEqual(provider.getUnattributedModels(), ['mystery-model']);
    });

    it('backs off after a failed probe instead of spawning one subprocess per request', async () => {
      let calls = 0;
      const provider = makeCatalog(async () => {
        calls += 1;
        throw new Error('agy: command not found');
      });

      await provider.refreshModels();
      const afterFailure = calls;
      // Every request now hits the backoff window rather than the CLI.
      provider.getModels();
      provider.getModels();
      provider.getModels();
      assert.equal(calls, afterFailure);
    });

    it('does not re-probe while a fresh catalog is cached', () => {
      let calls = 0;
      const provider = makeCatalog(async () => {
        calls += 1;
        return { stdout: jsonEnvelope(LIVE_MODELS), stderr: '' };
      });
      provider.getModels();
      provider.getModels();
      // getModels fires at most one background revalidation per instance.
      assert.ok(calls <= 1, `expected at most one probe, got ${calls}`);
    });
  });
});

describe('GET /api/models: dynamic catalog annotation', () => {
  const withServer = async (
    run: (ctx: { baseUrl: string; store: ConfigStore }) => Promise<void>
  ): Promise<void> => {
    const { dir, cleanup } = makeTempDir('catalog_web_');
    const store = new ConfigStore(path.join(dir, 'test.db'), {});
    const provider = new DynamicModelCatalog({
      execFileFn: async () => ({ stdout: jsonEnvelope(LIVE_MODELS), stderr: '' }),
    });
    await provider.refreshModels();

    const { server, port } = await startWebServer({
      configStore: store,
      host: '127.0.0.1',
      port: 0,
      modelCatalog: provider,
    });

    try {
      await run({ baseUrl: `http://127.0.0.1:${port}`, store });
    } finally {
      await closeWebServer(server);
      store.close();
      cleanup();
    }
  };

  it('returns models the CLI reports but this build never bundled', async () => {
    await withServer(async ({ baseUrl }) => {
      const body: any = await ky.get(`${baseUrl}/api/models`).json();
      const hydrogen = body.models.find((m: any) => m.id === 'gemini-4-hydrogen');
      assert.ok(hydrogen, 'dynamic catalog must expose Gemini 4 Hydrogen');
      assert.equal(hydrogen.label, 'Gemini 4 Hydrogen');
      assert.equal(hydrogen.family, 'gemini-flash');
      assert.ok(hydrogen.supportedEfforts.includes('xhigh'));
    });
  });

  it('keeps gemini-3.8-flash as the advertised gemini-flash default', async () => {
    await withServer(async ({ baseUrl }) => {
      const body: any = await ky.get(`${baseUrl}/api/models`).json();
      assert.equal(body.defaultModel, 'gemini-3.8-flash');
      const flashDefaults = body.models.filter(
        (m: any) => m.family === 'gemini-flash' && m.defaultForFamily
      );
      assert.deepEqual(
        flashDefaults.map((m: any) => m.id),
        ['gemini-3.8-flash']
      );
    });
  });

  it('annotates every catalog entry with headroom fields even with no telemetry', async () => {
    await withServer(async ({ baseUrl }) => {
      const body: any = await ky.get(`${baseUrl}/api/models`).json();
      for (const model of body.models) {
        assert.ok('effectiveHeadroomPercent' in model);
        assert.ok('belowSafetyFloor' in model);
        // No pools means headroom is unknown, not zero — the dispatch gate locks separately.
        assert.equal(model.effectiveHeadroomPercent, null);
      }
    });
  });

  it('reports unattributed codenames so they are visible rather than silently dropped', async () => {
    await withServer(async ({ baseUrl }) => {
      const body: any = await ky.get(`${baseUrl}/api/models`).json();
      assert.deepEqual(body.unattributedModels, []);
    });
  });
});
