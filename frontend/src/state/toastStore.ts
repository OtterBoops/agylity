import { createStore, useStore } from './store';

export type ToastTone = 'error' | 'success';

export interface Toast {
  id: number;
  tone: ToastTone;
  title: string;
  message?: string;
}

const TOAST_TTL_MS = 10_000;
const MAX_TOASTS = 3;

let nextId = 1;
const toastStore = createStore<Toast[]>([]);
const timers = new Map<number, ReturnType<typeof setTimeout>>();

export const dismissToast = (id: number): void => {
  const timer = timers.get(id);
  if (timer) {
    clearTimeout(timer);
    timers.delete(id);
  }
  toastStore.setState((toasts) => toasts.filter((toast) => toast.id !== id));
};

// An interaction that fails must say so where the user clicked, and stay readable long enough to
// be copied; the stack is capped so a retry loop cannot bury the page in toasts.
// An error toast is also the log entry: routing it through console.error keeps the browser
// console truthful without every call site remembering to log.
export const pushToast = (toast: Omit<Toast, 'id'>): number => {
  if (toast.tone === 'error') {
    console.error('[agylity]', toast.title, ...(toast.message ? [toast.message] : []));
  }
  const id = nextId++;
  toastStore.setState((toasts) => [...toasts, { ...toast, id }].slice(-MAX_TOASTS));
  timers.set(
    id,
    setTimeout(() => dismissToast(id), TOAST_TTL_MS)
  );
  return id;
};

export const pushSuccessToast = (title: string, message?: string): number =>
  pushToast({ tone: 'success', title, message });

export const pushErrorToast = (title: string, message?: string): number =>
  pushToast({ tone: 'error', title, message });

export const useToasts = (): Toast[] => useStore(toastStore);
