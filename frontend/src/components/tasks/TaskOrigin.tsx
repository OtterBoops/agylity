import type { BacklogTaskRecord, RoutineTaskRecord, SwarmTask } from '../../types';

export interface TaskOriginLists {
  backlog: BacklogTaskRecord[] | null;
  routines: RoutineTaskRecord[] | null;
}

export const UNRESOLVED_ORIGINS: TaskOriginLists = { backlog: null, routines: null };

type OriginKind = 'backlog' | 'routine' | 'external';

interface OriginDescriptor {
  kind: OriginKind;
  label: string;
  noun: string;
  originId?: string;
  deleted: boolean;
}

const BACKLOG_PREFIX = 'backlog:';
const ROUTINE_PREFIXES = ['routine:', 'standing-task:'];

const stripPrefix = (requestedBy: string, prefix: string): string | undefined =>
  requestedBy.startsWith(prefix) ? requestedBy.slice(prefix.length) : undefined;

const isMissing = (
  records: ReadonlyArray<{ id: string }> | null,
  originId: string | undefined
): boolean =>
  records !== null && (originId === undefined || !records.some((r) => r.id === originId));

export const describeTaskOrigin = (task: SwarmTask, lists: TaskOriginLists): OriginDescriptor => {
  const requestedBy = task.requestedBy ?? '';

  if (task.tier === 'backlog' || requestedBy.startsWith(BACKLOG_PREFIX)) {
    const originId = task.originId || stripPrefix(requestedBy, BACKLOG_PREFIX);
    const label = task.originNumber
      ? `Backlog: Task #${task.originNumber}`
      : task.originTitle
        ? `Backlog: ${task.originTitle}`
        : 'Backlog: Task';
    return {
      kind: 'backlog',
      label,
      noun: 'backlog task',
      originId,
      deleted: isMissing(lists.backlog, originId),
    };
  }

  const routinePrefix = ROUTINE_PREFIXES.find((prefix) => requestedBy.startsWith(prefix));
  if (task.tier === 'routine' || routinePrefix !== undefined) {
    const originId =
      task.originId || (routinePrefix ? stripPrefix(requestedBy, routinePrefix) : undefined);
    const label = task.originTitle
      ? `Routine: ${task.originTitle}`
      : task.originNumber
        ? `Routine #${task.originNumber}`
        : 'Routine';
    return {
      kind: 'routine',
      label,
      noun: 'routine',
      originId,
      deleted: isMissing(lists.routines, originId),
    };
  }

  return { kind: 'external', label: task.requestedBy || 'web-ui', noun: '', deleted: false };
};

const LABEL_CLASS = 'inline-block max-w-36 truncate align-bottom';

interface TaskOriginLabelProps {
  task: SwarmTask;
  lists: TaskOriginLists;
  onOpen: (originId: string) => void;
}

export const TaskOriginLabel = ({ task, lists, onOpen }: TaskOriginLabelProps) => {
  const origin = describeTaskOrigin(task, lists);

  if (origin.deleted) {
    return (
      <span
        class={`${LABEL_CLASS} font-medium text-pine-subtle`}
        title={`Origin ${origin.noun} was deleted`}
      >
        {origin.label} <span class="text-xs font-normal text-pine-muted">(deleted)</span>
      </span>
    );
  }

  if (origin.kind === 'external' || !origin.originId) {
    return (
      <span class={`${LABEL_CLASS} text-pine-subtle`} title={origin.label}>
        {origin.label}
      </span>
    );
  }

  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onOpen(origin.originId!);
      }}
      class={`${LABEL_CLASS} cursor-pointer text-left font-medium text-pine-iris hover:underline`}
      title={origin.label}
    >
      {origin.label}
    </button>
  );
};
