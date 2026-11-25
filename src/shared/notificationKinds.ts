// Import-free and erasable: the daemon and the notifier registry both read this list.

export interface NotificationKindDescriptor {
  kind: string;
  label: string;
  description: string;
  defaultEnabled: boolean;
}

export const NOTIFICATION_KINDS = [
  {
    kind: 'quota_alert',
    label: 'Quota milestones',
    description: 'Headroom alerts fired at the milestone hours before a pool resets.',
    defaultEnabled: true,
  },
  {
    kind: 'dispatch',
    label: 'Task dispatches',
    description: 'Queued, completed and failed task embeds.',
    defaultEnabled: true,
  },
  {
    kind: 'burn_kick',
    label: 'Pre-reset burn kicks',
    description: 'One notice when a pool enters its pre-reset window and burning starts.',
    defaultEnabled: true,
  },
  {
    kind: 'early_reset',
    label: 'Early reset notices',
    description: 'A pool that reset ahead of its advertised deadline.',
    defaultEnabled: true,
  },
] as const satisfies readonly NotificationKindDescriptor[];

export type NotificationKind = (typeof NOTIFICATION_KINDS)[number]['kind'];

export const NOTIFICATION_KIND_VALUES: readonly NotificationKind[] = NOTIFICATION_KINDS.map(
  (entry) => entry.kind
);

export const DEFAULT_NOTIFICATION_TYPES: Record<NotificationKind, boolean> = Object.fromEntries(
  NOTIFICATION_KINDS.map((entry) => [entry.kind, entry.defaultEnabled])
) as Record<NotificationKind, boolean>;

/** An unset entry inherits the registry default, so a new kind ships enabled. */
export const notificationKindEnabled = (
  types: Partial<Record<NotificationKind, boolean>> | undefined,
  kind: NotificationKind
): boolean => types?.[kind] ?? DEFAULT_NOTIFICATION_TYPES[kind] ?? true;
