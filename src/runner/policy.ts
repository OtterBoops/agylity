import path from 'node:path';
import { PR_POLICY_VALUES, type PrPolicy } from '../shared/contracts.js';

const PR_POLICY_SET: ReadonlySet<string> = new Set(PR_POLICY_VALUES);

// An unrecognised policy string (a typo or a blank compose var) must never read as "no restriction".
export const normalizePrPolicy = (value?: string): PrPolicy | undefined => {
  const normalized = value?.trim().toLowerCase();
  return normalized && PR_POLICY_SET.has(normalized) ? (normalized as PrPolicy) : undefined;
};

// The title already carries a GitHub label-sync prefix (`[GH #12] ...`) when the backlog row came
// from an issue; it is a reference, not part of the branch name.
export const GITHUB_ISSUE_TITLE_PREFIX = /^\s*\[GH\s*#\d+\]\s*/i;

// Never returns 'main' or 'master'.
export const buildContinuationBranchName = (taskId: string, titleOrPrompt: string): string => {
  const shortId =
    taskId
      .replace(/^task-\d+-/, '')
      .replace(/[^a-zA-Z0-9]/g, '')
      .slice(0, 8) || 'cont';

  const words = titleOrPrompt
    .replace(GITHUB_ISSUE_TITLE_PREFIX, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .split('-')
    .filter(Boolean);

  let slug = '';
  for (const word of words) {
    const candidate = slug ? `${slug}-${word}` : word;
    if (candidate.length > 32) break;
    slug = candidate;
  }

  return `agy/${shortId}-${slug || 'work'}`;
};

const DOC_EXTENSIONS = new Set(['.md', '.markdown', '.mdown', '.mkdn', '.txt', '.rst', '.adoc']);

const DOC_SPECIAL_BASENAMES = new Set([
  'license',
  'licence',
  'notice',
  'copying',
  'authors',
  'contributors',
  'changelog',
  'changes',
  'code_of_conduct',
  'contributing',
  'security',
]);

export const isDocumentationFile = (filePath: string): boolean => {
  const normalized = filePath.replace(/\\/g, '/').replace(/^\/+/, '');
  const baseName = path.basename(normalized);
  const ext = path.extname(baseName).toLowerCase();
  const nameWithoutExt = ext
    ? baseName.slice(0, -ext.length).toLowerCase()
    : baseName.toLowerCase();

  // A bare `README`/`LICENSE` with no extension is documentation; a doc extension is handled below.
  if (!ext && (nameWithoutExt.startsWith('readme') || DOC_SPECIAL_BASENAMES.has(nameWithoutExt))) {
    return true;
  }

  if (DOC_EXTENSIONS.has(ext)) {
    return true;
  }

  const lowerPath = normalized.toLowerCase();
  if (lowerPath.startsWith('docs/') || lowerPath.startsWith('doc/')) {
    const docAssetExts = new Set(['.svg', '.png', '.jpg', '.jpeg', '.gif', '.webp']);
    if (docAssetExts.has(ext)) return true;
  }

  return false;
};

export const ALLOWED_TEST_RUNNERS: ReadonlySet<string> = new Set([
  'npm',
  'pnpm',
  'yarn',
  'pytest',
  'cargo',
  'go',
]);
export const INLINE_CODE_FLAGS: ReadonlySet<string> = new Set(['-e', '--eval', '-c']);
