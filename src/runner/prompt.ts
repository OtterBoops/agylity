import type { CascadeHop } from '../coordinator/models.js';
import type { SwarmTask } from '../coordinator/queue.js';
import { type PrPolicy } from '../shared/contracts.js';
import { tailWindow } from '../shared/text.js';

// Every policy states its own directive: an empty suffix would let the model choose a default that
// no gate then enforces.
const PR_POLICY_DIRECTIVES: Record<PrPolicy, string> = {
  all: '\n\n[Policy: Implement the requested changes on this branch, run the relevant checks, and commit your changes with a concise, descriptive commit message (referencing #<issue> if fixing an issue). Do NOT add Co-authored-by trailers, override git author/committer identity, push, or open a pull request yourself.]',
  docs_only:
    '\n\n[Policy: Documentation only — modify documentation files only (do NOT modify source code or other non-documentation files) and commit your changes with a concise, descriptive commit message. Do NOT add Co-authored-by trailers, override git author/committer identity, push, or open a pull request yourself.]',
  issues_only:
    '\n\n[Policy: Issues Only — Do NOT modify repository files, push branches, or open pull requests. Report findings and proposed fixes as GitHub Issues only.]',
  none: '\n\n[Policy: Read-only analysis — do NOT modify repository files, push branches, or open pull requests; report findings in your final response.]',
};

// The footer the prompt asks the agent to append, which marks an issue as this fleet's deliverable.
export const AGYLITY_FOOTER_MARKER = 'Dispatched via Agylity';
// A prompt that already ends with that footer block must not get a second one appended to its PR.
export const AGYLITY_FOOTER_TAIL_RE = new RegExp(
  `---\\s*\\n\\*${AGYLITY_FOOTER_MARKER}[^\\n]*\\*\\s*$`,
  'i'
);
/** The Agylity footer, written once because `AGYLITY_FOOTER_TAIL_RE` recognises it in a PR body. */
export const agylityFooter = (tierLabel: string, model: string, effortNote: string): string =>
  `*Dispatched via Agylity (${tierLabel}) with \`${model}\`${effortNote} — please review carefully.*`;

const ROUTINE_PR_BODY_CAP = 4000;

/**
 * Routine prompts are multi-branch meta-instructions rather than a description of the diff, so a
 * routine PR opens with the agent's own summary instead of dumping its instructions.
 */
export const buildPullRequestBody = (
  task: Pick<SwarmTask, 'tier' | 'prompt'>,
  title: string,
  capturedOutput: string
): string => {
  if (task.tier !== 'routine') return task.prompt;
  const trimmed = capturedOutput.trim();
  if (!trimmed) return title;
  if (trimmed.length <= ROUTINE_PR_BODY_CAP) return trimmed;
  return `…\n${tailWindow(trimmed, ROUTINE_PR_BODY_CAP).trimStart()}`;
};

export const buildPrompt = (
  task: SwarmTask,
  prPolicy: PrPolicy,
  tierLabel: string,
  effort: CascadeHop['effort'] | undefined
): { prompt: string; policySuffix: string; attributionSuffix: string } => {
  const policySuffix = PR_POLICY_DIRECTIVES[prPolicy];
  const effortNote = effort ? ` (${effort} reasoning)` : '';
  const attributionSuffix = `\n\n[Instruction: If you create or edit any GitHub PR or Issue description directly, keep it minimal: simply append a footer: "---\n${agylityFooter(tierLabel, task.model, effortNote)}". Never mention runner hostnames, internal server paths, or worker IDs.]`;
  return {
    prompt: `${task.prompt}${policySuffix}${attributionSuffix}`,
    policySuffix,
    attributionSuffix,
  };
};
