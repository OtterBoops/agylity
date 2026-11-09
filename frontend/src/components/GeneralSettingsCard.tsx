import { useEffect, useState } from 'preact/hooks';
import { faClock, faGear } from '@fortawesome/free-solid-svg-icons';
import { Icon } from './Icon';
import { formatTime, useTimeFormat } from '../utils/time';

export const GeneralSettingsCard = () => {
  const [timeFormat, setTimeFormat] = useTimeFormat();
  const [now, setNow] = useState<Date>(() => new Date());

  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  return (
    <div class="rounded-xl border border-pine-highlight bg-pine-surface p-6 shadow-sm">
      <div class="mb-4 flex items-center gap-3">
        <div class="flex size-9 shrink-0 items-center justify-center rounded-lg border border-pine-highlight bg-pine-overlay/40 text-pine-iris">
          <Icon icon={faGear} class="size-4.5" />
        </div>
        <div>
          <h2 class="text-base font-bold text-pine-text">General Settings</h2>
          <p class="text-xs text-pine-subtle">
            Global application display preferences and regional formatting.
          </p>
        </div>
      </div>

      <div class="flex flex-col gap-4 border-t border-pine-highlight pt-4">
        <div class="flex flex-wrap items-center justify-between gap-4 py-1">
          <div class="flex min-w-0 items-start gap-3">
            <div class="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md border border-pine-highlight bg-pine-overlay/60 text-pine-foam">
              <Icon icon={faClock} class="size-4" />
            </div>
            <div>
              <div class="flex flex-wrap items-center gap-2">
                <span class="text-sm font-semibold text-pine-text">Clock Time Format</span>
                <span class="rounded-sm bg-pine-overlay px-2 py-0.5 font-mono text-xs font-semibold whitespace-nowrap text-pine-subtle">
                  Preview: {formatTime(now, { includeSeconds: true, timeFormat })}
                </span>
              </div>
              <p class="mt-0.5 text-xs text-pine-subtle">
                Format timestamps across logs, sentry telemetry, runner heartbeats, and dispatch
                history.
              </p>
            </div>
          </div>

          <div
            role="group"
            aria-label="Clock time format"
            class="flex items-center rounded-lg border border-pine-highlight bg-pine-overlay p-1 shadow-xs"
          >
            <button
              type="button"
              aria-pressed={timeFormat === '12h'}
              onClick={() => setTimeFormat('12h')}
              class={`cursor-pointer rounded-md px-3.5 py-1.5 text-xs font-semibold whitespace-nowrap transition-all focus-visible:ring-2 focus-visible:ring-pine-iris focus-visible:outline-hidden ${
                timeFormat === '12h'
                  ? 'bg-pine-iris text-pine-base shadow-xs'
                  : 'text-pine-subtle hover:text-pine-text'
              }`}
            >
              12-Hour (AM/PM)
            </button>
            <button
              type="button"
              aria-pressed={timeFormat === '24h'}
              onClick={() => setTimeFormat('24h')}
              class={`cursor-pointer rounded-md px-3.5 py-1.5 text-xs font-semibold whitespace-nowrap transition-all focus-visible:ring-2 focus-visible:ring-pine-iris focus-visible:outline-hidden ${
                timeFormat === '24h'
                  ? 'bg-pine-iris text-pine-base shadow-xs'
                  : 'text-pine-subtle hover:text-pine-text'
              }`}
            >
              24-Hour
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
