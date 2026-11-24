/** The last `cap` UTF-16 units, nudged off a surrogate pair so the head never renders as U+FFFD. */
export const tailWindow = (text: string, cap: number): string => {
  let start = Math.max(0, text.length - cap);
  if (start > 0) {
    const code = text.charCodeAt(start);
    if (code >= 0xdc00 && code <= 0xdfff) start -= 1;
  }
  return text.slice(start);
};
