/** Probe-source label and dot colour, shared by the sidebar and the inspector. */
export const describeProbe = (source: string | undefined): { label: string; color: string } => {
  if (source === 'connect_rpc') return { label: 'Live Connect-RPC', color: 'bg-pine-pine' };
  if (source === 'cli' || source === 'cli_fallback')
    return { label: 'Antigravity CLI', color: 'bg-pine-pine' };
  if (source === 'auth_required') return { label: 'Auth Required', color: 'bg-pine-love' };
  return { label: 'Offline', color: 'bg-pine-love' };
};
