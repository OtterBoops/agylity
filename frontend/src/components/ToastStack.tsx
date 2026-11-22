import { faClipboard, faXmark } from '@fortawesome/free-solid-svg-icons';
import { useState } from 'preact/hooks';
import { Icon } from './Icon';
import { dismissToast, useToasts, type Toast } from '../state/toastStore';

const ToastCard = ({ toast }: { toast: Toast }) => {
  const [copied, setCopied] = useState(false);
  const isError = toast.tone === 'error';

  const copy = async (): Promise<void> => {
    const text = toast.message ? `${toast.title}\n${toast.message}` : toast.title;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div
      role={isError ? 'alert' : 'status'}
      class={`pointer-events-auto w-full max-w-sm rounded-xl border p-3 shadow-lg ${
        isError
          ? 'border-pine-love/50 bg-pine-surface text-pine-love'
          : 'border-pine-pine/50 bg-pine-surface text-pine-foam'
      }`}
    >
      <div class="flex items-start justify-between gap-3">
        <span class="text-sm font-semibold">{toast.title}</span>
        <button
          type="button"
          class="shrink-0 cursor-pointer rounded-md p-1 text-pine-subtle transition-colors hover:text-pine-text focus-visible:ring-2 focus-visible:ring-pine-iris focus-visible:outline-hidden"
          aria-label="Dismiss notification"
          onClick={() => dismissToast(toast.id)}
        >
          <Icon icon={faXmark} class="size-3" />
        </button>
      </div>
      {toast.message && (
        <p class="mt-1 font-mono text-xs wrap-break-word text-pine-subtle">{toast.message}</p>
      )}
      <div class="mt-2 flex justify-end">
        <button
          type="button"
          class="flex cursor-pointer items-center gap-1.5 rounded-md border border-pine-highlight px-2 py-1 text-xs font-semibold text-pine-subtle transition-colors hover:text-pine-text focus-visible:ring-2 focus-visible:ring-pine-iris focus-visible:outline-hidden"
          onClick={copy}
        >
          <Icon icon={faClipboard} class="size-3" />
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
    </div>
  );
};

export const ToastStack = () => {
  const toasts = useToasts();
  if (toasts.length === 0) return null;
  return (
    <div class="pointer-events-none fixed right-4 bottom-4 z-50 flex w-[calc(100%-2rem)] flex-col items-end gap-2 sm:w-96">
      {toasts.map((toast) => (
        <ToastCard key={toast.id} toast={toast} />
      ))}
    </div>
  );
};
