import type { ComponentChildren } from 'preact';
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { faTimes } from '@fortawesome/free-solid-svg-icons';
import { Icon } from './Icon';
import { dialogBackdropClickHandler } from '../utils/dialog';
import { DiscardStrip } from './tasks/DiscardStrip';

export interface SlideOverDrawerHandle {
  open: () => void;
  close: () => void;
  requestClose: () => void;
}

interface SlideOverDrawerProps {
  token: string;
  label: string;
  ariaLabel?: string;
  width?: 'composer' | 'inspector';
  dirty?: boolean;
  api?: { current: SlideOverDrawerHandle | null };
  footer?: ComponentChildren;
  onClosed: () => void;
  children: ComponentChildren;
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export const SlideOverDrawer = ({
  token,
  label,
  ariaLabel,
  width = 'inspector',
  dirty = false,
  api,
  footer,
  onClosed,
  children,
}: SlideOverDrawerProps) => {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const closeTimerRef = useRef<number | null>(null);
  const [discardArmed, setDiscardArmed] = useState(false);
  const [closing, setClosing] = useState(false);

  const finishClose = useCallback(() => {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
    const dialog = dialogRef.current;
    // dialog.close() is what returns focus to the element that opened the panel.
    if (dialog?.open) dialog.close();
  }, []);

  const close = useCallback(() => {
    const dialog = dialogRef.current;
    if (!dialog?.open || closing) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      finishClose();
      return;
    }
    setClosing(true);
    closeTimerRef.current = window.setTimeout(finishClose, 220);
  }, [closing, finishClose]);

  useEffect(() => {
    return () => {
      if (closeTimerRef.current !== null) {
        window.clearTimeout(closeTimerRef.current);
      }
    };
  }, []);

  const requestClose = useCallback(() => {
    // First attempt arms the discard prompt; the second one actually discards.
    if (dirty && !discardArmed) {
      setDiscardArmed(true);
      return;
    }
    close();
  }, [dirty, discardArmed, close]);

  const open = useCallback(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  useEffect(() => {
    open();
  }, [open]);

  useEffect(() => {
    if (!api) return;
    api.current = { open, close, requestClose };
    return () => {
      api.current = null;
    };
  }, [api, open, close, requestClose]);

  useEffect(() => {
    if (!dirty) setDiscardArmed(false);
  }, [dirty]);

  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    body.scrollTop = 0;
    const frame = requestAnimationFrame(() => {
      body.scrollTop = 0;
      const target =
        body.querySelector<HTMLElement>('[data-drawer-focus]') ??
        body.querySelector<HTMLElement>(FOCUSABLE) ??
        body;
      target.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [token]);

  return (
    <dialog
      ref={dialogRef}
      aria-label={ariaLabel ?? label}
      aria-modal="true"
      onClose={() => {
        setClosing(false);
        onClosed();
      }}
      onTransitionEnd={(event) => {
        if (closing && event.target === dialogRef.current) {
          finishClose();
        }
      }}
      onCancel={(event) => {
        // Esc belongs to the guard: a dirty panel needs a second Esc to actually discard.
        event.preventDefault();
        requestClose();
      }}
      onKeyDown={(event) => {
        // A dialog's cancel event is not cancelable in current Chrome; the keydown is.
        if (event.key !== 'Escape') return;
        if ((event.target as Element | null)?.closest('dialog') !== dialogRef.current) return;
        event.preventDefault();
        event.stopPropagation();
        requestClose();
      }}
      onClick={dialogBackdropClickHandler(dialogRef, requestClose)}
      class={`fixed inset-y-0 right-0 left-auto m-0 h-dvh max-h-none w-full max-w-none overflow-hidden rounded-none border-l border-pine-highlight bg-pine-surface p-0 text-pine-text transition-transform duration-200 ease-out backdrop:bg-black/50 backdrop:transition-opacity backdrop:duration-200 motion-reduce:transition-none motion-reduce:backdrop:duration-0 starting:translate-x-full backdrop:starting:opacity-0 ${
        closing ? 'translate-x-full backdrop:opacity-0' : 'translate-x-0'
      } ${width === 'composer' ? 'md:max-w-2xl' : 'md:max-w-3xl'}`}
    >
      <div ref={bodyRef} tabIndex={-1} class="flex h-full flex-col overflow-y-auto outline-hidden">
        <header class="sticky top-0 z-10 flex items-center justify-between gap-3 border-b border-pine-highlight bg-pine-surface px-4 py-3">
          <h2 class="font-mono text-xs tracking-wider text-pine-subtle uppercase">{label}</h2>
          <button
            type="button"
            onClick={requestClose}
            aria-label={`Close ${label.toLowerCase()}`}
            class="inline-flex min-h-11 min-w-11 cursor-pointer items-center justify-center rounded-lg text-pine-muted transition-colors hover:bg-pine-overlay hover:text-pine-text focus-visible:ring-2 focus-visible:ring-pine-iris focus-visible:outline-hidden"
          >
            <Icon icon={faTimes} class="size-4" />
          </button>
        </header>

        <div class="flex min-w-0 flex-1 flex-col gap-4 p-4">{children}</div>

        {(footer || discardArmed) && (
          <footer class="sticky bottom-0 z-10 mt-auto flex flex-col gap-2 border-t border-pine-highlight bg-pine-surface px-4 py-3">
            {footer}
            {discardArmed && (
              <DiscardStrip onConfirm={close} onCancel={() => setDiscardArmed(false)} />
            )}
          </footer>
        )}
      </div>
    </dialog>
  );
};
