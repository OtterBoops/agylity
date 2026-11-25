// Zero imports and erasable syntax only: the frontend bundles this file directly, so a zod or
// `node:` dependency here would leak a server concern into the client build.
//
// One title for the dashboard row, the branch slug, the commit subject and the PR title: four
// surfaces that must never disagree, so they all resolve it here.

const ELLIPSIS = '…';

// Exported so a caller can tell the shared default from a task that genuinely carries this title.
export const UNTITLED_TASK_TITLE = 'Untitled task';

// Markdown decoration a prompt usually opens with: headings, bullets, blockquotes and ordered
// list numbering. Stripped repeatedly so `> ## - item` still yields `item`.
const LEADING_MARKERS = /^(?:\s*(?:#{1,6}(?:\s+|$)|[-*+>](?:\s+|$)|\d+[.)](?:\s+|$)))+/;
// A fenced code block is body, not a heading: its info string would otherwise title the task.
const CODE_FENCE = /^\s*```[\w+#.-]*\s*$/;
const LEADING_BOLD_SPAN = /^\*\*([^*]+)\*\*\s*/;
const TRAILING_MARKERS = /[\s*_`]+$/;

const collapseWhitespace = (value: string): string => value.replace(/\s+/g, ' ').trim();

// Clips at a word boundary, reserving one character for the ellipsis so the result never exceeds
// `maxLen`.
const clipToLength = (value: string, maxLen: number): string => {
  if (value.length <= maxLen) return value;
  const budget = Math.max(1, maxLen - ELLIPSIS.length);
  const head = value.slice(0, budget + 1);
  const boundary = head.lastIndexOf(' ');
  const cut = boundary > 0 ? head.slice(0, boundary) : value.slice(0, budget);
  // A cut between the halves of a surrogate pair leaves a code unit that renders as U+FFFD.
  const last = cut.charCodeAt(cut.length - 1);
  const body = last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
  return `${body.replace(/[\s.,;:!?–—-]+$/, '')}${ELLIPSIS}`;
};

const firstMeaningfulLine = (prompt: string): string => {
  let inFence = false;
  for (const rawLine of prompt.split(/\r?\n/)) {
    if (CODE_FENCE.test(rawLine)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const line = collapseWhitespace(
      rawLine
        .replace(LEADING_MARKERS, '')
        .replace(LEADING_BOLD_SPAN, '$1 ')
        .replace(TRAILING_MARKERS, '')
    );
    if (line) return line;
  }
  return '';
};

/**
 * The single source of a task's human title.
 *
 * An explicit title wins; otherwise the prompt's first meaningful line stands in, with its Markdown
 * markers stripped so a dispatch prompt written as `# Fix the parser` titles as `Fix the parser`.
 * `'Untitled task'` is reserved for a task that carries neither.
 */
export const resolveTaskTitle = (
  title: string | null | undefined,
  prompt: string | null | undefined,
  maxLen = 72
): string => {
  const explicit = collapseWhitespace(title ?? '');
  if (explicit) return clipToLength(explicit, maxLen);

  const derived = firstMeaningfulLine(prompt ?? '');
  if (derived) return clipToLength(derived, maxLen);

  return UNTITLED_TASK_TITLE;
};
