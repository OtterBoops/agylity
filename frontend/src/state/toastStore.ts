import { useEffect, useState } from 'preact/hooks';

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
let toasts: Toast[] = [];
const listeners = new Set<(next: Toast[]) => void>();
const timers = new Map<number, ReturnType<typeof setTimeout>>();

const publish = (): void => {
  for (const listener of listeners) {
    try {
      listener(toasts);
    } catch (err) {
      console.error('[agylity] toast listener error:', err);
    }
  }
};

export const dismissToast = (id: number): void => {
  const timer = timers.get(id);
  if (timer) {
    clearTimeout(timer);
    timers.delete(id);
  }
  toasts = toasts.filter((toast) => toast.id !== id);
  publish();
};

// An interaction that fails must say so where the user clicked, and stay readable long enough to
// be copied; the stack is capped so a retry loop cannot bury the page in toasts.
export const pushToast = (toast: Omit<Toast, 'id'>): number => {
  const id = nextId++;
  toasts = [...toasts, { ...toast, id }].slice(-MAX_TOASTS);
  timers.set(
    id,
    setTimeout(() => dismissToast(id), TOAST_TTL_MS)
  );
  publish();
  return id;
};

export const pushErrorToast = (title: string, message?: string): number =>
  pushToast({ tone: 'error', title, message });

export const useToasts = (): Toast[] => {
  const [current, setCurrent] = useState<Toast[]>(toasts);
  useEffect(() => {
    const listener = (next: Toast[]) => setCurrent(next);
    listeners.add(listener);
    setCurrent(toasts);
    return () => {
      listeners.delete(listener);
    };
  }, []);
  return current;
};
