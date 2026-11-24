// Pull-request policies in the order the settings form renders them. The policy values themselves
// live in `contracts.ts`; this module adds the operator-facing copy so the settings form, the task
// composer and the execution inspector cannot label the same choice differently.

import { PR_POLICY_VALUES, type PrPolicy } from './contracts.js';

interface PrPolicyOption {
  value: PrPolicy;
  /** Select label: what the policy allows, in operator terms. */
  label: string;
  /** Same choice in a detail row, where the parenthetical explanation does not fit. */
  shortLabel: string;
  /** One-line explanation shown under the field once the policy is selected. */
  hint: string;
}

// Keyed by the contract's own union, so a new policy fails to compile until it has copy here.
const PR_POLICY_COPY: Record<PrPolicy, Omit<PrPolicyOption, 'value'>> = {
  all: {
    label: 'All files (Allow code & doc PRs)',
    shortLabel: 'All files',
    hint: 'all files — code and doc changes open a PR',
  },
  docs_only: {
    label: 'Documentation only (*.md, docs/)',
    shortLabel: 'Documentation only',
    hint: 'PRs allowed for docs only — code changes ship as an issue',
  },
  issues_only: {
    label: 'Issues only (No PRs or code changes)',
    shortLabel: 'Issues only',
    hint: 'issues only — no code changes or PRs; file GitHub Issues',
  },
  none: {
    label: 'None (Disable autonomous PRs & branch pushes)',
    shortLabel: 'None',
    hint: 'none — no pull requests, no branch pushes',
  },
};

export const PR_POLICIES: readonly PrPolicyOption[] = PR_POLICY_VALUES.map((value) => ({
  value,
  ...PR_POLICY_COPY[value],
}));

export const PR_POLICY_HINTS: Record<PrPolicy, string> = Object.fromEntries(
  PR_POLICIES.map((policy) => [policy.value, policy.hint])
) as Record<PrPolicy, string>;

export const PR_POLICY_SHORT_LABELS: Record<PrPolicy, string> = Object.fromEntries(
  PR_POLICIES.map((policy) => [policy.value, policy.shortLabel])
) as Record<PrPolicy, string>;
