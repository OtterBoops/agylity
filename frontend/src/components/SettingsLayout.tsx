import type { ComponentChildren } from 'preact';
import { faBell, faCodeBranch, faNetworkWired, faSliders } from '@fortawesome/free-solid-svg-icons';
import { Link } from 'preact-router/match';
import { Icon } from './Icon';

export type SettingsTab = 'coordinator' | 'repositories' | 'notifications' | 'advanced';

interface SettingsLayoutProps {
  activeTab: SettingsTab;
  coordinatorEnabled?: boolean;
  children: ComponentChildren;
}

export const SettingsLayout = ({
  activeTab,
  coordinatorEnabled = false,
  children,
}: SettingsLayoutProps) => {
  const tabs = [
    {
      id: 'coordinator' as SettingsTab,
      label: 'Coordinator',
      href: '/settings/coordinator',
      icon: faNetworkWired,
      badge: coordinatorEnabled ? 'Active' : undefined,
    },
    ...(coordinatorEnabled
      ? [
          {
            id: 'repositories' as SettingsTab,
            label: 'Repositories',
            href: '/settings/repositories',
            icon: faCodeBranch,
          },
        ]
      : []),
    {
      id: 'notifications' as SettingsTab,
      label: 'Notifications',
      href: '/settings/notifications',
      icon: faBell,
    },
    {
      id: 'advanced' as SettingsTab,
      label: 'Advanced & Sentry',
      href: '/settings/advanced',
      icon: faSliders,
    },
  ];

  return (
    <div class="mx-auto flex w-full max-w-5xl flex-col gap-6">
      <div class="flex flex-col gap-3 border-b border-pine-highlight/60 pb-3">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h1 class="text-xl font-bold text-pine-text sm:text-2xl">
              Settings &amp; Configuration
            </h1>
            <p class="mt-0.5 text-xs text-pine-subtle">
              Manage coordinator runners, repository bindings, notification targets, and quota
              safeguards.
            </p>
          </div>
        </div>

        <nav
          class="flex items-center gap-1.5 overflow-x-auto pb-1"
          aria-label="Settings categories"
        >
          {tabs.map((tab) => {
            const isActive = activeTab === tab.id;
            return (
              <Link
                key={tab.id}
                href={tab.href}
                class={`flex items-center gap-2 rounded-lg px-3.5 py-2 text-xs font-semibold whitespace-nowrap transition-colors ${
                  isActive
                    ? 'bg-pine-iris text-pine-base shadow-xs'
                    : 'text-pine-subtle hover:bg-pine-overlay/60 hover:text-pine-text'
                }`}
              >
                <Icon icon={tab.icon} class="size-3.5" />
                <span>{tab.label}</span>
                {tab.badge && (
                  <span
                    class={`rounded-sm px-1.5 py-0.5 text-xs font-bold uppercase ${
                      isActive ? 'bg-pine-base/20 text-pine-base' : 'bg-pine-foam/15 text-pine-foam'
                    }`}
                  >
                    {tab.badge}
                  </span>
                )}
              </Link>
            );
          })}
        </nav>
      </div>

      <div class="flex flex-col gap-6">{children}</div>
    </div>
  );
};
