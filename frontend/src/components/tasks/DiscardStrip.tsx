interface DiscardStripProps {
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export const DiscardStrip = ({
  message = 'Discard unsaved changes?',
  confirmLabel = 'Discard',
  cancelLabel = 'Keep editing',
  onConfirm,
  onCancel,
}: DiscardStripProps) => (
  <div
    role="alert"
    class="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-pine-gold/40 bg-pine-gold/10 px-3 py-2"
  >
    <span class="text-xs font-semibold text-pine-gold">{message}</span>
    <div class="flex items-center gap-2">
      <button
        type="button"
        onClick={onCancel}
        class="min-h-9 cursor-pointer rounded-lg border border-pine-highlight bg-pine-overlay px-3 text-xs font-semibold text-pine-text transition-colors hover:bg-pine-highlight"
      >
        {cancelLabel}
      </button>
      <button
        type="button"
        onClick={onConfirm}
        class="min-h-9 cursor-pointer rounded-lg border border-pine-love/40 bg-pine-love/15 px-3 text-xs font-semibold text-pine-love transition-colors hover:bg-pine-love hover:text-pine-base"
      >
        {confirmLabel}
      </button>
    </div>
  </div>
);
