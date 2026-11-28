import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');
const SOURCE_ROOTS = ['src', 'frontend/src'];

const listSources = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : listSources(full);
    return /\.(ts|tsx)$/.test(entry.name) ? [full.split(path.sep).join('/')] : [];
  });

const FILES = SOURCE_ROOTS.flatMap((root) => listSources(path.join(ROOT, root)));
const FILE_SET = new Set(FILES);

const resolveSpecifier = (from: string, specifier: string): string | null => {
  if (!specifier.startsWith('.')) return null;
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(from), specifier));
  const candidates = [
    `${base}.ts`,
    `${base}.tsx`,
    `${base}/index.ts`,
    `${base}/index.tsx`,
    base.replace(/\.js$/, '.ts'),
    base.replace(/\.js$/, '.tsx'),
  ];
  return candidates.find((candidate) => FILE_SET.has(candidate)) ?? null;
};

// `import type` and an all-`type` named list are erased at compile time, so they cannot create an
// initialisation cycle; only runtime edges are counted here.
const IMPORT_RE =
  /(?:^|\n)\s*(?:import|export)\s+(type\s+)?([\s\S]*?)\sfrom\s+['"]([^'"]+)['"]|(?:^|\n)\s*import\(\s*['"]([^'"]+)['"]\s*\)/g;

const isTypeOnlyClause = (clause: string): boolean => {
  const trimmed = clause.trim();
  if (trimmed === '' || trimmed.startsWith('*')) return false;
  const named = /\{([\s\S]*)\}/.exec(trimmed);
  if (!named) return false;
  const specifiers = named[1]!
    .split(',')
    .map((specifier) => specifier.trim())
    .filter(Boolean);
  return specifiers.every((specifier) => specifier.startsWith('type '));
};

interface Edge {
  from: string;
  to: string;
}

const runtimeEdges = (): Edge[] => {
  const edges: Edge[] = [];
  for (const file of FILES) {
    const source = readFileSync(file, 'utf-8');
    for (const match of source.matchAll(IMPORT_RE)) {
      const [, explicitType, clause, named, dynamic] = match;
      const specifier = named ?? dynamic;
      if (!specifier) continue;
      const isTypeOnly =
        Boolean(explicitType) || (named !== undefined && isTypeOnlyClause(clause ?? ''));
      if (isTypeOnly) continue;
      const resolved = resolveSpecifier(file, specifier);
      if (resolved) edges.push({ from: file, to: resolved });
    }
  }
  return edges;
};

const findCycle = (edges: Edge[]): string[] | undefined => {
  const adjacency = new Map<string, string[]>();
  for (const { from, to } of edges) adjacency.set(from, [...(adjacency.get(from) ?? []), to]);
  const state = new Map<string, 1 | 2>();
  const stack: string[] = [];
  const walk = (node: string): string[] | undefined => {
    state.set(node, 1);
    stack.push(node);
    for (const next of adjacency.get(node) ?? []) {
      if (state.get(next) === 1) return [...stack.slice(stack.indexOf(next)), next];
      if (!state.get(next)) {
        const found = walk(next);
        if (found) return found;
      }
    }
    stack.pop();
    state.set(node, 2);
    return undefined;
  };
  for (const file of FILES) {
    if (state.get(file)) continue;
    const found = walk(file);
    if (found) return found;
  }
  return undefined;
};

describe('Architecture constraints', () => {
  it('has no runtime import cycles', () => {
    const cycle = findCycle(runtimeEdges());
    assert.ok(cycle === undefined, `cycle: ${cycle?.join(' -> ')}`);
  });

  it('keeps src/shared free of dependencies', () => {
    const edges = runtimeEdges().filter(({ from }) => from.includes('/src/shared/'));
    const outside = edges.filter(({ to }) => !to.includes('/src/shared/'));
    assert.deepEqual(
      outside.map(({ from, to }) => `${from} -> ${to}`),
      []
    );
  });

  it('keeps the frontend out of the backend outside src/shared', () => {
    const edges = runtimeEdges().filter(({ from }) => from.includes('/frontend/src/'));
    const backend = edges.filter(
      ({ to }) => to.includes('/src/') && !to.includes('/frontend/') && !to.includes('/src/shared/')
    );
    assert.deepEqual(
      backend.map(({ from, to }) => `${from} -> ${to}`),
      []
    );
  });
});

// Ambient reads are plumbing or bootstrap, never a knob: a config knob is read through the registry so
// a dashboard override applies. Listing each site makes a new silent bypass fail the suite.
const AMBIENT_ENV_READS: Record<string, readonly string[]> = {
  'src/index.ts': ['NODE_TEST_CONTEXT', 'VITEST'],
  'src/cli/main.ts': ['WEB_UI_AUTH_TOKEN', 'GITHUB_TOKEN', 'AGYLITY_SECRET_KEY'],
  'src/coordinator/catalog.ts': ['REMOTE_AGY_BIN_PATH', 'AGY_BIN_PATH'],
  'src/daemon/daemon.ts': ['DATABASE_PATH', 'QUOTA_STATE_FILE_PATH'],
  'src/logs/logger.ts': ['LOG_LEVEL'],
  'src/runner/executor.ts': ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL'],
  'src/runner/git.ts': ['GITHUB_TOKEN'],
  'src/sentry/client.ts': [
    'DATA_DIR',
    'DATABASE_PATH',
    'ANTIGRAVITY_ENDPOINT_URL',
    'ANTIGRAVITY_LS_PORT',
    'ANTIGRAVITY_CSRF_TOKEN',
    'REMOTE_AGY_BIN_PATH',
    'AGY_BIN_PATH',
  ],
  'src/storage/crypto.ts': ['AGYLITY_SECRET_KEY'],
  'src/web/controllers/health.ts': ['BUILD_CHANNEL', 'BUILD_COMMIT'],
};

const ENV_READ_RE = /process\.env\.([A-Z0-9_]+)/g;

describe('Ambient environment access', () => {
  it('reads no config knob outside the config layer', () => {
    const offenders: string[] = [];
    for (const file of FILES) {
      const relative = file.slice(file.indexOf('/src/') + 1);
      if (relative.startsWith('src/config/')) continue;
      const allowed = new Set(AMBIENT_ENV_READS[relative] ?? []);
      const source = readFileSync(file, 'utf-8');
      for (const match of source.matchAll(ENV_READ_RE)) {
        const name = match[1]!;
        // An assignment writes the environment; only a read can be a second source of truth.
        if (
          source
            .slice(match.index! + match[0].length)
            .trimStart()
            .startsWith('=')
        )
          continue;
        if (!allowed.has(name)) offenders.push(`${relative}: process.env.${name}`);
      }
    }
    assert.deepEqual(offenders, []);
  });
});
