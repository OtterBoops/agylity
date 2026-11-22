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
    <div class="flex size-full min-h-full items-center justify-center bg-pine-base p-4 selection:bg-pine-iris/20 selection:text-pine-iris sm:p-6">
      <div class="w-full max-w-md rounded-xl border border-pine-highlight bg-pine-surface p-6 sm:p-8">
        <div class="flex items-center justify-between gap-3 border-b border-pine-highlight pb-4">
          <div class="flex min-w-0 items-center gap-2.5">
            <span class="flex size-9 shrink-0 items-center justify-center rounded-lg border border-pine-iris/30 bg-pine-iris/15 text-pine-iris">
              <Icon icon={faShieldHalved} class="size-4.5" />
            </span>
            <div class="min-w-0">
              <h1 class="text-lg font-semibold text-pine-text">Agylity Control Plane</h1>
              <span class="mt-0.5 block text-sm text-pine-subtle">
                Autonomous Sentry &amp; Swarm Coordinator
              </span>
            </div>
          </div>
          <span class="inline-flex shrink-0 items-center gap-1 rounded-sm border border-pine-highlight bg-pine-overlay px-2 py-0.5 font-mono text-xs whitespace-nowrap text-pine-subtle">
            <Icon icon={faLock} class="size-2.5 text-pine-muted" />
            <span>Protected</span>
          </span>
        </div>

        <p class="mt-4 text-sm/snug text-pine-subtle">
          Control-Plane Authentication is active on this instance. Provide your Bearer auth token (
          <code class="rounded-sm bg-pine-sunken px-1 py-0.5 font-mono text-xs text-pine-iris">
            WEB_UI_AUTH_TOKEN
          </code>
          ) to unlock the dashboard, tasks, logs, and configuration.
        </p>

        <form onSubmit={handleSubmit} class="mt-5 flex flex-col gap-4">
          {errorMessage && (
            <div
              role="alert"
              aria-live="assertive"
              class="flex items-start gap-2.5 rounded-lg border border-pine-love/40 bg-pine-love/10 p-3 text-sm text-pine-love"
            >
              <Icon icon={faTriangleExclamation} class="mt-0.5 size-4 shrink-0" />
              <span class="leading-relaxed">{errorMessage}</span>
            </div>
          )}

          <div>
            <label
              htmlFor="gate-auth-token"
              class="mb-1.5 block text-sm font-medium text-pine-text"
            >
              Bearer Auth Token
            </label>
            <div class="relative">
              <span class="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3 text-pine-muted">
                <Icon icon={faKey} class="size-3.5" />
              </span>
              <input
                id="gate-auth-token"
                type={showPassword ? 'text' : 'password'}
                placeholder="Paste WEB_UI_AUTH_TOKEN..."
                class="min-h-11 w-full rounded-lg border border-pine-highlight bg-pine-sunken py-2.5 pr-12 pl-9 font-mono text-sm text-pine-text transition-colors placeholder:text-pine-muted focus:border-pine-iris focus-visible:ring-2 focus-visible:ring-pine-iris/40 focus-visible:outline-hidden"
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
                class="absolute inset-y-0 right-0 flex min-h-11 min-w-11 cursor-pointer items-center justify-center pr-3 text-pine-muted transition-colors hover:text-pine-text focus-visible:ring-2 focus-visible:ring-pine-iris focus-visible:outline-hidden"
                aria-label={showPassword ? 'Hide token' : 'Show token'}
              >
                <Icon icon={showPassword ? faEyeSlash : faEye} class="size-4" />
              </button>
            </div>
          </div>

          <button
            type="submit"
            disabled={isVerifying || !token.trim()}
            class="flex min-h-11 w-full cursor-pointer items-center justify-center gap-2 rounded-lg bg-pine-iris px-4 py-2.5 text-sm font-semibold text-pine-base transition-colors hover:brightness-110 focus-visible:ring-2 focus-visible:ring-pine-iris focus-visible:ring-offset-2 focus-visible:ring-offset-pine-surface focus-visible:outline-hidden disabled:cursor-not-allowed disabled:bg-pine-overlay disabled:text-pine-subtle"
          >
            {isVerifying ? (
              <>
                <Icon icon={faRotate} class="size-4 animate-spin motion-reduce:animate-none" />
                <span>Verifying Token...</span>
              </>
            ) : (
              <>
                <Icon icon={faLock} class="size-4" />
                <span>Unlock Control Plane</span>
              </>
            )}
          </button>
        </form>

        <p class="mt-6 border-t border-pine-highlight pt-4 text-center font-mono text-xs text-pine-subtle">
          Token is stored strictly client-side in your browser's local storage.
        </p>
      </div>
    </div>
  );
};
