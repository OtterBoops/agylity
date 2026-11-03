import { useEffect, useRef, useState } from 'preact/hooks';
import {
  faKey,
  faLock,
  faXmark,
  faRightFromBracket,
  faCheck,
  faRotate,
  faTriangleExclamation,
} from '@fortawesome/free-solid-svg-icons';
import { getAuthToken, setAuthToken, verifyAuthToken } from '../api';
import { Icon } from './Icon';

interface SessionModalProps {
  isOpen: boolean;
  onClose: () => void;
  onLock: () => void;
  onTokenUpdated: () => void;
}

export const SessionModal = ({ isOpen, onClose, onLock, onTokenUpdated }: SessionModalProps) => {
  const [token, setToken] = useState('');
  const [isUpdating, setIsUpdating] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    };
  }, []);

  useEffect(() => {
    if (isOpen) {
      setToken(getAuthToken() || '');
      setErrorMessage(null);
      setSuccessMessage(null);
    }
  }, [isOpen]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (isOpen) {
      if (!dialog.open) dialog.showModal();
    } else {
      if (dialog.open) dialog.close();
    }
  }, [isOpen]);

  const handleUpdate = async (e: Event) => {
    e.preventDefault();
    const clean = token.trim();
    if (!clean) {
      setErrorMessage('Bearer token cannot be empty');
      return;
    }

    setIsUpdating(true);
    setErrorMessage(null);
    setSuccessMessage(null);

    const result = await verifyAuthToken(clean);
    setIsUpdating(false);

    if (result.success) {
      setSuccessMessage('Token verified and updated successfully');
      if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
      closeTimerRef.current = setTimeout(() => {
        onTokenUpdated();
        onClose();
      }, 1000);
    } else {
      setErrorMessage(result.error || 'Verification failed');
    }
  };

  const handleLockSession = () => {
    setAuthToken(null);
    onClose();
    onLock();
  };

  return (
    <dialog
      ref={dialogRef}
      class="m-auto w-[calc(100%-2rem)] max-w-md rounded-2xl border border-pine-highlight bg-pine-surface p-0 shadow-2xl transition-all backdrop:bg-black/70 backdrop:backdrop-blur-xs"
      onClick={(e) => {
        if (e.target === dialogRef.current) onClose();
      }}
    >
      <div class="flex flex-col gap-4 p-5 sm:p-6">
        <div class="flex items-center justify-between border-b border-pine-highlight/60 pb-3">
          <div class="flex items-center gap-2.5">
            <span class="text-pine-iris">
              <Icon icon={faLock} />
            </span>
            <h2 class="text-base font-semibold text-pine-text">Control-Plane Session</h2>
          </div>
          <button
            type="button"
            class="cursor-pointer text-pine-subtle transition-colors hover:text-pine-text"
            onClick={onClose}
            aria-label="Close"
          >
            <Icon icon={faXmark} />
          </button>
        </div>

        <div class="rounded-xl border border-pine-pine/30 bg-pine-pine/10 p-3 text-xs text-pine-foam">
          <div class="flex items-center gap-2">
            <Icon icon={faCheck} class="size-3.5" />
            <span class="font-semibold">Session Authenticated</span>
          </div>
          <p class="mt-1 text-[11px] text-pine-subtle">
            Your browser is currently authenticated with a Bearer token.
          </p>
        </div>

        {errorMessage && (
          <div class="flex items-start gap-2.5 rounded-xl border border-pine-love/30 bg-pine-love/10 p-3 text-xs text-pine-love">
            <Icon icon={faTriangleExclamation} class="mt-0.5 size-3.5 shrink-0" />
            <span>{errorMessage}</span>
          </div>
        )}

        {successMessage && (
          <div class="flex items-center gap-2 rounded-xl border border-pine-pine/30 bg-pine-pine/10 p-3 text-xs text-pine-foam">
            <Icon icon={faCheck} class="size-3.5" />
            <span>{successMessage}</span>
          </div>
        )}

        <form onSubmit={handleUpdate} class="flex flex-col gap-3">
          <div>
            <label class="mb-1 block text-xs font-medium text-pine-subtle">
              Update Bearer Token
            </label>
            <div class="relative">
              <input
                type="password"
                placeholder="Enter new WEB_UI_AUTH_TOKEN..."
                class="w-full rounded-xl border border-pine-highlight bg-pine-overlay px-3 py-2 pr-9 text-sm text-pine-text placeholder-pine-muted focus:border-pine-iris focus:outline-none"
                value={token}
                onInput={(e) => {
                  setToken((e.target as HTMLInputElement).value);
                  if (errorMessage) setErrorMessage(null);
                }}
                disabled={isUpdating}
              />
              <span class="absolute top-2.5 right-3 text-pine-muted">
                <Icon icon={faKey} />
              </span>
            </div>
          </div>

          <div class="flex items-center justify-between gap-3 pt-2">
            <button
              type="button"
              onClick={handleLockSession}
              class="flex cursor-pointer items-center gap-1.5 rounded-xl border border-pine-love/40 bg-pine-love/10 px-3 py-2 text-xs font-medium text-pine-love transition-colors hover:bg-pine-love/20"
              title="Lock control plane and clear token from local storage"
            >
              <Icon icon={faRightFromBracket} class="size-3" />
              <span>Lock Session</span>
            </button>

            <button
              type="submit"
              disabled={isUpdating || !token.trim()}
              class="flex cursor-pointer items-center gap-1.5 rounded-xl bg-pine-iris px-4 py-2 text-xs font-semibold text-pine-base transition-colors hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isUpdating && <Icon icon={faRotate} class="size-3 animate-spin" />}
              <span>Update Token</span>
            </button>
          </div>
        </form>
      </div>
    </dialog>
  );
};
