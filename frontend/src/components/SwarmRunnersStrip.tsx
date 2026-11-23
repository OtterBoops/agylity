import type { SwarmRunnerRecord } from '../types';
import { formatTime, useTimeFormat } from '../utils/time';
import { MissingCredentialsBadge } from './tasks/MissingCredentialsBadge';
import { TableHeadRow, TableRow, TableShell, TH } from './TableShell';

interface SwarmRunnersStripProps {
  runners: SwarmRunnerRecord[];
  credentialsAvailable: boolean;
  coordinatorEnabled: boolean;
  runnersError?: string | null;
}

const runnerStatus = (runner: SwarmRunnerRecord): { label: string; tone: string } => {
  if (runner.status === 'busy') return { label: 'Busy', tone: 'text-pine-gold' };
  if (runner.status === 'offline') return { label: 'Offline', tone: 'text-pine-muted' };
  return { label: 'Idle', tone: 'text-pine-foam' };
};

export const SwarmRunnersStrip = ({
  runners,
  credentialsAvailable,
  coordinatorEnabled,
  runnersError = null,
}: SwarmRunnersStripProps) => {
  const [timeFormat] = useTimeFormat();
  if (!coordinatorEnabled) return null;

  if (runnersError) {
    return (
      <p class="rounded-lg border border-pine-love/40 bg-pine-love/10 px-3 py-2 text-xs text-pine-love">
        Could not load runners: {runnersError}
      </p>
    );
  }

  if (runners.length === 0) {
    return (
      <a
        href="/settings#coordinator"
        class="flex items-center justify-between gap-3 rounded-xl border border-pine-highlight bg-pine-surface px-3 py-2 text-xs text-pine-subtle transition-colors hover:border-pine-iris/50 hover:text-pine-text"
      >
        <span>0 runners online</span>
        <span class="text-pine-iris">Connect Runner -&gt;</span>
      </a>
    );
  }

  return (
    <TableShell>
      <table class="w-full table-fixed text-left">
        <colgroup>
          <col class="w-[26%]" />
          <col class="w-[14%]" />
          <col class="w-[14%]" />
          <col class="w-[22%]" />
          <col class="w-[24%]" />
        </colgroup>
        <thead>
          <TableHeadRow>
            <TH>Runner</TH>
            <TH>Status</TH>
            <TH>Active task</TH>
            <TH>Host</TH>
            <TH>Last seen</TH>
          </TableHeadRow>
        </thead>
        <tbody>
          {runners.map((runner) => {
            const status = runnerStatus(runner);
            const missingCredentials = !credentialsAvailable && runner.status === 'idle';
            return (
              <TableRow key={runner.runnerId}>
                <td class="truncate px-2.5 text-sm text-pine-text">{runner.name}</td>
                <td class="px-2.5 text-xs whitespace-nowrap uppercase">
                  {missingCredentials ? (
                    <MissingCredentialsBadge />
                  ) : (
                    <span class={status.tone}>{status.label}</span>
                  )}
                </td>
                <td class="truncate px-2.5 font-mono text-xs text-pine-subtle">
                  {runner.activeTaskId ? (
                    <a
                      href={`/tasks?tab=executions&id=${encodeURIComponent(runner.activeTaskId)}`}
                      class="text-pine-iris hover:underline"
                    >
                      {runner.activeTaskId.slice(-6)}
                    </a>
                  ) : (
                    '-'
                  )}
                </td>
                <td class="truncate px-2.5 font-mono text-xs text-pine-subtle">
                  {runner.systemInfo?.hostname ?? runner.systemInfo?.platform ?? '-'}
                </td>
                <td class="truncate px-2.5 font-mono text-xs text-pine-subtle">
                  {runner.lastSeenAt ? formatTime(runner.lastSeenAt, { timeFormat }) : '-'}
                </td>
              </TableRow>
            );
          })}
        </tbody>
      </table>
    </TableShell>
  );
};
