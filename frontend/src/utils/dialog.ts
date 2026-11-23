import { useEffect } from 'preact/hooks';

interface ScrollLockSnapshot {
  scrollX: number;
  scrollY: number;
  htmlOverflow: string;
  bodyOverflow: string;
  bodyPosition: string;
  bodyTop: string;
  bodyLeft: string;
  bodyRight: string;
}

let lockCount = 0;
let snapshot: ScrollLockSnapshot | null = null;

function lockBackgroundScroll(): void {
  if (typeof document === 'undefined' || typeof window === 'undefined') return;
  if (lockCount === 0) {
    const html = document.documentElement;
    const body = document.body;
    const scrollX = window.scrollX;
    const scrollY = window.scrollY;
    snapshot = {
      scrollX,
      scrollY,
      htmlOverflow: html.style.overflow,
      bodyOverflow: body.style.overflow,
      bodyPosition: body.style.position,
      bodyTop: body.style.top,
      bodyLeft: body.style.left,
      bodyRight: body.style.right,
    };
    html.style.overflow = 'hidden';
    body.style.overflow = 'hidden';
    body.style.position = 'fixed';
    body.style.top = scrollY ? `-${scrollY}px` : '0px';
    body.style.left = '0';
    body.style.right = '0';
  }
  lockCount += 1;
}

function unlockBackgroundScroll(): void {
  if (typeof document === 'undefined' || typeof window === 'undefined') return;
  if (lockCount === 0) return;
  lockCount -= 1;
  if (lockCount === 0 && snapshot) {
    const html = document.documentElement;
    const body = document.body;
    const {
      scrollX,
      scrollY,
      htmlOverflow,
      bodyOverflow,
      bodyPosition,
      bodyTop,
      bodyLeft,
      bodyRight,
    } = snapshot;
    snapshot = null;
    html.style.overflow = htmlOverflow;
    body.style.overflow = bodyOverflow;
    body.style.position = bodyPosition;
    body.style.top = bodyTop;
    body.style.left = bodyLeft;
    body.style.right = bodyRight;
    if (scrollX !== 0 || scrollY !== 0) {
      window.scrollTo(scrollX, scrollY);
    }
  }
}

/**
 * Locks document scroll while a modal `<dialog>` is open, preserving mobile scroll position
 * and ref-counting nested or overlapping dialogs.
 */
export const useDialogScrollLock = (open: boolean): void => {
  useEffect(() => {
    if (!open) return;
    lockBackgroundScroll();
    return () => {
      unlockBackgroundScroll();
    };
  }, [open]);
};

export const dialogBackdropClickHandler =
  (ref: { current: HTMLDialogElement | null }, onOutside: () => void) =>
  (e: MouseEvent): void => {
    if (!ref.current) return;
    if (e.detail === 0) return;
    const rect = ref.current.getBoundingClientRect();
    const isInDialog =
      rect.top <= e.clientY &&
      e.clientY <= rect.top + rect.height &&
      rect.left <= e.clientX &&
      e.clientX <= rect.left + rect.width;
    if (!isInDialog) onOutside();
  };
