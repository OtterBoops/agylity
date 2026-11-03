/** Closes a native <dialog> when the click lands on the backdrop rather than inside it. */
export const dialogBackdropClickHandler =
  (ref: { current: HTMLDialogElement | null }, onOutside: () => void) =>
  (e: MouseEvent): void => {
    if (!ref.current) return;
    const rect = ref.current.getBoundingClientRect();
    const isInDialog =
      rect.top <= e.clientY &&
      e.clientY <= rect.top + rect.height &&
      rect.left <= e.clientX &&
      e.clientX <= rect.left + rect.width;
    if (!isInDialog) onOutside();
  };
