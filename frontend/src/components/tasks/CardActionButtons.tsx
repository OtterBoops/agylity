import { faPencil, faPlay, faTimes, faTrash } from '@fortawesome/free-solid-svg-icons';
import { Icon } from '../Icon';

interface CardActionButtonsProps {
  /** Accessible names for the icon-only actions, e.g. the routine's title. */
  entityLabel: string;
  busy: boolean;
  /** Delete is destructive and irreversible here, so the bin needs a second press. */
  confirmingDelete: boolean;
  onTrigger?: () => void;
  /** Undefined hides the edit affordance (a settled work item is read-only). */
  onEdit?: () => void;
  onAskDelete: () => void;
  onConfirmDelete: () => void;
  onCancelDelete: () => void;
}

/** Trigger / edit / two-step delete, so both schedule cards share one action cluster. */
export const CardActionButtons = ({
  entityLabel,
  busy,
  confirmingDelete,
  onTrigger,
  onEdit,
  onAskDelete,
  onConfirmDelete,
  onCancelDelete,
}: CardActionButtonsProps) => (
  <div class="flex shrink-0 items-center gap-1.5">
    {onTrigger && (
      <button
        type="button"
        onClick={onTrigger}
        disabled={busy}
        class="inline-flex size-7 cursor-pointer items-center justify-center rounded-sm border border-pine-iris/30 bg-pine-iris/10 text-pine-iris transition-colors hover:bg-pine-iris hover:text-pine-base disabled:opacity-50"
        title="Trigger immediate execution with preference chain"
        aria-label={`Trigger ${entityLabel}`}
      >
        <Icon icon={faPlay} class="size-3" />
      </button>
    )}
    {onEdit && (
      <button
        type="button"
        onClick={onEdit}
        disabled={busy}
        class="inline-flex size-7 cursor-pointer items-center justify-center rounded-sm border border-pine-highlight bg-pine-overlay/50 text-pine-subtle transition-colors hover:border-pine-foam/40 hover:text-pine-foam disabled:opacity-50"
        title="Edit"
        aria-label={`Edit ${entityLabel}`}
      >
        <Icon icon={faPencil} class="size-3" />
      </button>
    )}
    {confirmingDelete ? (
      <>
        <button
          type="button"
          onClick={onConfirmDelete}
          disabled={busy}
          class="cursor-pointer rounded-sm border border-pine-love/50 bg-pine-love/15 px-2 py-1 text-xs font-bold whitespace-nowrap text-pine-love"
        >
          Delete?
        </button>
        <button
          type="button"
          onClick={onCancelDelete}
          class="inline-flex size-7 cursor-pointer items-center justify-center rounded-sm border border-pine-highlight text-pine-muted hover:text-pine-text"
          aria-label="Cancel delete"
        >
          <Icon icon={faTimes} class="size-3.5" />
        </button>
      </>
    ) : (
      <button
        type="button"
        onClick={onAskDelete}
        disabled={busy}
        class="inline-flex size-7 cursor-pointer items-center justify-center rounded-sm border border-pine-love/30 bg-pine-love/10 text-pine-love transition-colors hover:bg-pine-love hover:text-pine-base disabled:opacity-50"
        title="Delete"
        aria-label={`Delete ${entityLabel}`}
      >
        <Icon icon={faTrash} class="size-3" />
      </button>
    )}
  </div>
);
