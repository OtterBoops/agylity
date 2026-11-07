import { useState } from 'preact/hooks';
import {
  faLock,
  faKey,
  faEye,
  faEyeSlash,
  faShieldHalved,
  faTriangleExclamation,
  faRotate,
} from '@fortawesome/free-solid-svg-icons';
import { verifyAuthToken } from '../api';
import { Icon } from './Icon';

interface ControlPlaneGateProps {
  onAuthenticated: () => void;
}

export const ControlPlaneGate = ({ onAuthenticated }: ControlPlaneGateProps) => {
  const [token, setToken] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [isVerifying, setIsVerifying] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const handleSubmit = async (e: Event) => {
    e.preventDefault();
    const clean = token.trim();
    if (!clean) {
      setErrorMessage('Please enter your WEB_UI_AUTH_TOKEN');
      return;
    }

    setIsVerifying(true);
    setErrorMessage(null);

    const result = await verifyAuthToken(clean);
    setIsVerifying(false);

    if (result.success) {
      onAuthenticated();
    } else {
      setErrorMessage(result.error || 'Authentication failed');
    }
  };

  return (
    <div class="flex min-h-dvh w-full items-center justify-center bg-pine-base p-4 selection:bg-pine-iris/20 selection:text-pine-iris sm:p-6">
      <div class="w-full max-w-md rounded-2xl border border-pine-highlight bg-pine-surface p-6 shadow-2xl sm:p-8">
        <div class="flex items-center justify-between border-b border-pine-highlight/60 pb-4">
          <div class="flex items-center gap-2.5">
            <span class="flex size-9 items-center justify-center rounded-xl bg-pine-iris/15 text-pine-iris">
              <Icon icon={faShieldHalved} class="size-4.5" />
            </span>
            <div>
              <h1 class="text-base font-bold text-pine-text sm:text-lg">Agylity Control Plane</h1>
              <span class="text-[11px] text-pine-subtle">
                Autonomous Sentry & Swarm Coordinator
              </span>
            </div>
          </div>
          <span class="inline-flex items-center gap-1 rounded-md border border-pine-iris/30 bg-pine-iris/10 px-2 py-0.5 font-mono text-[11px] font-medium whitespace-nowrap text-pine-iris">
            <Icon icon={faLock} class="size-2.5" />
            <span>Protected</span>
          </span>
        </div>

        <div class="mt-4">
          <p class="text-xs/relaxed text-pine-subtle">
            Control-Plane Authentication is active on this instance. Provide your Bearer auth token
            (
            <code class="rounded-sm bg-pine-overlay px-1 py-0.5 font-mono text-pine-iris">
              WEB_UI_AUTH_TOKEN
            </code>
            ) to unlock the dashboard, tasks, logs, and configuration.
          </p>
        </div>

        <form onSubmit={handleSubmit} class="mt-5 space-y-4">
          {errorMessage && (
            <div class="flex items-start gap-2.5 rounded-xl border border-pine-love/30 bg-pine-love/10 p-3 text-xs text-pine-love">
              <Icon icon={faTriangleExclamation} class="mt-0.5 size-3.5 shrink-0" />
              <span class="leading-relaxed">{errorMessage}</span>
            </div>
          )}

          <div>
            <label class="mb-1.5 block text-xs font-semibold text-pine-subtle">
              Bearer Auth Token
            </label>
            <div class="relative">
              <span class="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3 text-pine-muted">
                <Icon icon={faKey} class="size-3.5" />
              </span>
              <input
                type={showPassword ? 'text' : 'password'}
                placeholder="Paste WEB_UI_AUTH_TOKEN..."
                class="w-full rounded-xl border border-pine-highlight bg-pine-overlay py-2.5 pr-10 pl-9 text-sm text-pine-text placeholder-pine-muted transition-colors focus:border-pine-iris focus:outline-none"
                value={token}
                onInput={(e) => {
                  setToken((e.target as HTMLInputElement).value);
                  if (errorMessage) setErrorMessage(null);
                }}
                disabled={isVerifying}
                autoFocus
                required
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                class="absolute inset-y-0 right-0 flex cursor-pointer items-center pr-3 text-pine-muted transition-colors hover:text-pine-text"
                aria-label={showPassword ? 'Hide token' : 'Show token'}
                tabIndex={-1}
              >
                <Icon icon={showPassword ? faEyeSlash : faEye} class="size-3.5" />
              </button>
            </div>
          </div>

          <button
            type="submit"
            disabled={isVerifying || !token.trim()}
            class="flex w-full cursor-pointer items-center justify-center gap-2 rounded-xl bg-pine-iris px-4 py-2.5 text-sm font-semibold text-pine-base shadow-sm transition-all hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isVerifying ? (
              <>
                <Icon icon={faRotate} class="size-3.5 animate-spin" />
                <span>Verifying Token...</span>
              </>
            ) : (
              <>
                <Icon icon={faLock} class="size-3.5" />
                <span>Unlock Control Plane</span>
              </>
            )}
          </button>
        </form>

        <div class="mt-6 border-t border-pine-highlight/40 pt-4 text-center">
          <p class="font-mono text-[11px] text-pine-muted">
            Token is stored strictly client-side in your browser's local storage.
          </p>
        </div>
      </div>
    </div>
  );
};
