import {
  CONFIG_DOC_GROUPS,
  CONFIG_REGISTRY,
  type ConfigDocGroup,
  type ConfigRegistryEntry,
} from './schema.js';

// Both files are generated from CONFIG_REGISTRY: the reference table in `docs/configuration.md` and
// `.env.example`. Hand-editing either is drift, and the unit test re-renders them and fails.

export const CONFIG_REFERENCE_START = '<!-- config-reference:start -->';
export const CONFIG_REFERENCE_END = '<!-- config-reference:end -->';

const ROW_WIDTH = 96;

const escapeCell = (value: string): string => value.replace(/\|/g, '\\|');

const renderTable = (rows: string[][]): string => {
  const widths = (rows[0] ?? []).map((_, column) =>
    Math.max(3, ...rows.map((row) => (row[column] ?? '').length))
  );
  const renderRow = (row: string[]): string =>
    `| ${widths.map((width, index) => (row[index] ?? '').padEnd(width)).join(' | ')} |`;
  const [header, ...body] = rows;
  return [
    renderRow(header ?? []),
    renderRow(widths.map((width) => '-'.repeat(width))),
    ...body.map(renderRow),
  ].join('\n');
};

const documented = (): ConfigRegistryEntry[] => CONFIG_REGISTRY.filter((entry) => !entry.hidden);

const variableOf = (entry: ConfigRegistryEntry): string => entry.env ?? entry.key ?? '';

/** The env reference table, ordered by `CONFIG_DOC_GROUPS` and grouped with a heading row. */
export const renderConfigReferenceTable = (): string => {
  const rows: string[][] = [['Variable', 'Type', 'Default', 'Description']];
  for (const group of CONFIG_DOC_GROUPS) {
    const entries = documented().filter((entry) => entry.group === group.id);
    if (entries.length === 0) continue;
    rows.push([`**${group.label}**`, '', '', '']);
    for (const entry of entries) {
      rows.push([
        `\`${variableOf(entry)}\``,
        `\`${entry.type}\``,
        entry.defaultLabel === '—' ? '—' : `\`${entry.defaultLabel}\``,
        escapeCell(entry.description),
      ]);
    }
  }
  return renderTable(rows);
};

const wrap = (text: string, width: number): string[] => {
  const lines: string[] = [];
  let current = '';
  for (const word of text.split(' ')) {
    if (current === '') {
      current = word;
    } else if (`${current} ${word}`.length <= width) {
      current = `${current} ${word}`;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current !== '') lines.push(current);
  return lines;
};

const exampleValueOf = (entry: ConfigRegistryEntry): string => {
  if (entry.exampleValue !== undefined) return entry.exampleValue;
  const value = (entry as { value?: unknown }).value;
  if (entry.defaultLabel === '—') return '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return entry.defaultLabel;
};

const GROUP_INTROS: Record<ConfigDocGroup, string> = {
  notifications:
    'These settings pick the remote destinations only; every event reaches stdout and the Logs buffer regardless.',
  sentry:
    'The sentry polls the Antigravity language server and alerts on quota milestones. The language server is discovered from a local process unless an endpoint is given here.',
  coordinator:
    'Task continuation and runner execution. With the coordinator disabled Agylity runs purely as a quota sentry and binds no execution sockets.',
  security:
    'Secrets encryption and control-plane access. A non-loopback WEB_UI_HOST without WEB_UI_AUTH_TOKEN refuses to start rather than expose an unauthenticated control plane.',
  web: 'The native node:http dashboard. Disabled by default: zero listeners, zero web modules loaded.',
  logging: 'Terminal output and the in-memory log ring buffer that streams to the dashboard.',
  storage: 'Process paths read directly from the environment, never from a SQLite override.',
  runner:
    'Runner nodes only. Everything here is read straight from the process environment by src/runner-cli.ts, src/runner/git.ts and src/runner/executor.ts rather than through src/config/schema.ts, so none of it can be set as a dashboard override. ALLOW_TOKENLESS_RUNNER is the exception: the coordinator reads it as a schema-driven key (see the coordinator section) and a runner reads its own environment.',
};

const HEADER = `# ==============================================================================
# agylity - Environment Configuration Template
# ==============================================================================
# Copy this file to .env and customize values for your deployment.
# Values defined here serve as Level 2 fallback precedence:
# Resolved Config = SQLite UI Overrides ?? Environment Variables (.env) ?? Built-in Defaults
#
# Generated from CONFIG_REGISTRY in src/config/schema.ts by \`npm run docs:config\`.
# ==============================================================================`;

const ENTRY_RULE = '# ' + '-'.repeat(78);

const renderEntry = (entry: ConfigRegistryEntry): string => {
  const lines = [...wrap(entry.description, ROW_WIDTH - 2).map((line) => `# ${line}`)];
  if (entry.defaultLabel !== '—') lines.push(`# Default: ${entry.defaultLabel}`);
  const assignment = `${variableOf(entry)}=${exampleValueOf(entry)}`;
  lines.push(entry.example === 'set' ? assignment : `# ${assignment}`);
  return lines.join('\n');
};

/** The whole `.env.example`, one section per `CONFIG_DOC_GROUPS` entry. */
export const renderEnvExample = (): string => {
  const sections = CONFIG_DOC_GROUPS.map((group, index) => {
    const entries = documented().filter(
      (entry) => entry.group === group.id && entry.env !== undefined
    );
    if (entries.length === 0) return '';
    return [
      ENTRY_RULE,
      `# ${index + 1}. ${group.label}`,
      ENTRY_RULE,
      ...wrap(GROUP_INTROS[group.id], ROW_WIDTH - 2).map((line) => `# ${line}`),
      '',
      ...entries.map((entry) => `${renderEntry(entry)}\n`),
    ].join('\n');
  }).filter(Boolean);
  return [HEADER, '', ...sections].join('\n') + '\n';
};

/** Replaces the generated block in `docs/configuration.md`, failing loudly if the markers were moved. */
export const applyConfigReference = (doc: string): string => {
  const start = doc.indexOf(CONFIG_REFERENCE_START);
  const end = doc.indexOf(CONFIG_REFERENCE_END);
  if (start === -1 || end === -1 || end < start) {
    throw new Error(
      `docs/configuration.md is missing the ${CONFIG_REFERENCE_START} / ${CONFIG_REFERENCE_END} markers`
    );
  }
  return (
    doc.slice(0, start + CONFIG_REFERENCE_START.length) +
    '\n\n' +
    renderConfigReferenceTable() +
    '\n\n' +
    doc.slice(end)
  );
};
