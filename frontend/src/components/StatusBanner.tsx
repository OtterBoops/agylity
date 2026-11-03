import type { ToastState } from '../types';

interface StatusBannerProps {
  status: ToastState;
}

export const StatusBanner = ({ status }: StatusBannerProps) => (
  <div
    role="status"
    aria-live="polite"
    class={`rounded-lg border p-3 text-xs font-medium ${
      status.type === 'success'
        ? 'border-pine-pine bg-pine-pine/20 text-pine-foam'
        : 'border-pine-love bg-pine-love/20 text-pine-love'
    }`}
  >
    {status.message}
  </div>
);
