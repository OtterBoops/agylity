import type { TaskStatus } from '../types';

type Tone = 'good' | 'bad' | 'busy' | 'neutral';

/** One badge palette, so the same tone never renders differently across views. */
export const toneBadgeClass = (tone: Tone): string =>
  tone === 'good'
    ? 'border-pine-pine/40 bg-pine-pine/15 text-pine-foam'
    : tone === 'bad'
      ? 'border-pine-love/40 bg-pine-love/15 text-pine-love'
      : tone === 'busy'
        ? 'border-pine-gold/40 bg-pine-gold/15 text-pine-gold'
        : 'border-pine-highlight bg-pine-overlay/60 text-pine-subtle';

export const taskStatusBadgeClass = (status: TaskStatus | string): string =>
  status === 'executing'
    ? `animate-pulse ${toneBadgeClass('busy')}`
    : status === 'completed'
      ? toneBadgeClass('good')
      : status === 'failed' || status === 'aborted'
        ? toneBadgeClass('bad')
        : toneBadgeClass('neutral');

/** Dispatch outcome is a success flag, not a task status, but shares the palette. */
export const dispatchOutcomeBadgeClass = (success: boolean): string =>
  toneBadgeClass(success ? 'good' : 'bad');

export const dispatchOutcomeLabel = (success: boolean): string => (success ? 'Done' : 'Failed');

export const workerStatusBadgeClass = (status: string): string =>
  status === 'busy'
    ? toneBadgeClass('busy')
    : status === 'offline'
      ? toneBadgeClass('bad')
      : toneBadgeClass('good');
