import type { ComponentChildren } from 'preact';

interface SettingsLayoutProps {
  children: ComponentChildren;
}

export const SettingsLayout = ({ children }: SettingsLayoutProps) => (
  <div class="mx-auto flex w-full max-w-5xl flex-col gap-6">
    <div class="flex flex-col gap-6">{children}</div>
  </div>
);
