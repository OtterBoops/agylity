import type { ComponentChildren } from 'preact';

interface SettingsLayoutProps {
  children: ComponentChildren;
}

export const SettingsLayout = ({ children }: SettingsLayoutProps) => (
  <div class="mx-auto flex w-full max-w-5xl flex-col gap-6">
    <div class="flex flex-col gap-3 border-b border-pine-highlight/60 pb-3">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 class="text-xl font-bold text-pine-text sm:text-2xl">Settings &amp; Configuration</h2>
          <p class="mt-0.5 text-xs text-pine-subtle">
            Manage coordinator runners, repository bindings, notification targets, and quota
            safeguards.
          </p>
        </div>
      </div>
    </div>

    <div class="flex flex-col gap-6">{children}</div>
  </div>
);
