import type { TaskStatus } from '../../types';

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

export const statusMatchesBucket = (status: string, bucket: StatusBucketId): boolean => {
  const entry = STATUS_BUCKETS.find((candidate) => candidate.id === bucket);
  if (!entry || entry.statuses === null) return true;
  return (entry.statuses as readonly string[]).includes(status);
};
