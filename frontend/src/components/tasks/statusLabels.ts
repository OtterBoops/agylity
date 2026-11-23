import type { TaskStatus } from '../../types';
import { taskStatusBadgeClass, toneBadgeClass } from '../../utils/status';

const STATUS_LABELS: Record<TaskStatus, string> = {
  queued: 'Queued',
  claimed: 'Claimed',
  executing: 'Executing',
  completed: 'Completed',
  no_changes: 'No Changes',
  failed: 'Failed',
  aborted: 'Aborted',
};

export const statusLabel = (status: string): string =>
  STATUS_LABELS[status as TaskStatus] ?? status.replace(/_/g, ' ');

export const STATUS_BUCKETS = [
  { id: 'all', label: 'All', statuses: null },
  { id: 'inflight', label: 'In Flight', statuses: ['queued', 'claimed', 'executing'] },
  { id: 'completed', label: 'Completed', statuses: ['completed', 'no_changes'] },
  { id: 'failed', label: 'Failed', statuses: ['failed', 'aborted'] },
] as const;

export type StatusBucketId = (typeof STATUS_BUCKETS)[number]['id'];

// Issue-only runs finish as `completed` with no PR, so the UI derives its own status from the payload.
export interface TaskDisplayStatusInput {
  status: string;
  prUrl?: string | null;
  issueUrls?: readonly string[] | null;
}

export const isIssueFiledTask = (task: TaskDisplayStatusInput): boolean =>
  task.status === 'completed' && !task.prUrl && (task.issueUrls?.length ?? 0) > 0;

export const taskDisplayStatusLabel = (task: TaskDisplayStatusInput): string => {
  const count = isIssueFiledTask(task) ? (task.issueUrls?.length ?? 0) : 0;
  if (count > 1) return 'Issues Filed';
  if (count === 1) return 'Issue Filed';
  return statusLabel(task.status);
};

export const taskDisplayBadgeClass = (task: TaskDisplayStatusInput): string =>
  isIssueFiledTask(task) ? toneBadgeClass('issue') : taskStatusBadgeClass(task.status);

export const taskDisplayDotTextClass = (task: TaskDisplayStatusInput): string =>
  taskDisplayBadgeClass(task)
    .split(/\s+/)
    .find((token) => token.startsWith('text-')) ?? 'text-pine-subtle';

export const statusMatchesBucket = (status: string, bucket: StatusBucketId): boolean => {
  const entry = STATUS_BUCKETS.find((candidate) => candidate.id === bucket);
  if (!entry || entry.statuses === null) return true;
  return (entry.statuses as readonly string[]).includes(status);
};
