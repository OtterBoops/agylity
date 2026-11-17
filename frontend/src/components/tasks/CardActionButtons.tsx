import { faPencil, faPlay, faTimes, faTrash } from '@fortawesome/free-solid-svg-icons';
import { Icon } from '../Icon';

interface CardActionButtonsProps {
  entityLabel: string;
  busy: boolean;
  confirmingDelete: boolean;
  onTrigger?: () => void;
  onEdit?: () => void;
  onAskDelete: () => void;
  onConfirmDelete: () => void;
  onCancelDelete: () => void;
}

/** Each press stops at the button: the card root underneath opens the editor on click. */
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
        onClick={(event) => {
          event.stopPropagation();
          onTrigger();
        }}
        disabled={busy}
        class="inline-flex size-11 cursor-pointer items-center justify-center rounded-sm border border-pine-foam/30 bg-pine-foam/10 text-pine-foam transition-colors hover:bg-pine-foam hover:text-pine-base disabled:opacity-50 sm:size-7"
        title="Trigger immediate execution with preference chain"
        aria-label={`Trigger ${entityLabel}`}
      >
        <Icon icon={faPlay} class="size-3" />
      </button>
    )}
    {onEdit && (
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          onEdit();
        }}
        disabled={busy}
        class="inline-flex size-11 cursor-pointer items-center justify-center rounded-sm border border-pine-highlight bg-pine-overlay text-pine-subtle transition-colors hover:bg-pine-highlight hover:text-pine-text disabled:opacity-50 sm:size-7"
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
          onClick={(event) => {
            event.stopPropagation();
            onConfirmDelete();
          }}
          disabled={busy}
          class="inline-flex min-h-11 cursor-pointer items-center rounded-sm border border-pine-love/50 bg-pine-love/15 px-2 text-xs font-bold whitespace-nowrap text-pine-love sm:min-h-7"
        >
          Delete?
        </button>
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onCancelDelete();
          }}
          class="inline-flex size-11 cursor-pointer items-center justify-center rounded-sm border border-pine-highlight text-pine-muted hover:text-pine-text sm:size-7"
          aria-label="Cancel delete"
        >
          <Icon icon={faTimes} class="size-3.5" />
        </button>
      </>
    ) : (
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          onAskDelete();
        }}
        disabled={busy}
        class="inline-flex size-11 cursor-pointer items-center justify-center rounded-sm border border-pine-love/30 bg-pine-love/10 text-pine-love transition-colors hover:bg-pine-love hover:text-pine-base disabled:opacity-50 sm:size-7"
        title="Delete"
        aria-label={`Delete ${entityLabel}`}
      >
        <Icon icon={faTrash} class="size-3" />
      </button>
    )}
  </div>
);
