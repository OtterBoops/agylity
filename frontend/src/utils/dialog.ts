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
