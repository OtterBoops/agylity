import { execFile as nodeExecFile } from 'node:child_process';
import { promisify } from 'node:util';

export const defaultExecFileAsync = promisify(nodeExecFile);

export type ExecFileAsyncFn = (
  file: string,
  args: readonly string[],
  options: Record<string, unknown>
) => Promise<{ stdout: string; stderr: string }>;

export interface DiscoveredLanguageServer {
  port?: number;
  ports?: number[];
  csrfToken?: string;
  isHttps?: boolean;
}

export async function discoverWindowsLanguageServer(
  execFileFn: ExecFileAsyncFn
): Promise<DiscoveredLanguageServer | null> {
  const psScript = `
    $proc = Get-Process -Name 'language_server' -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($proc) {
      $cmd = (Get-CimInstance Win32_Process -Filter "ProcessId = $($proc.Id)" -ErrorAction SilentlyContinue).CommandLine
      $ports = (Get-NetTCPConnection -OwningProcess $proc.Id -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalAddress -eq '127.0.0.1' } | Select-Object -ExpandProperty LocalPort)
      Write-Output "CMD:$cmd"
      Write-Output "PORTS:$($ports -join ',')"
    }
  `;

  const { stdout } = await execFileFn(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', psScript],
    { timeout: 4000, windowsHide: true }
  );

  const csrfMatch = /--csrf_token(?:\s+|=)["']?([^\s"']+)["']?/i.exec(stdout);
  const portMatch = /--https_server_port(?:\s+|=)(\d+)/i.exec(stdout);
  const portsMatch = /PORTS:([0-9,]+)/i.exec(stdout);

  const csrfToken = csrfMatch ? csrfMatch[1] : undefined;
  const rawPorts =
    portsMatch && portsMatch[1]
      ? portsMatch[1]
          .split(',')
          .map(Number)
          .filter((n) => !Number.isNaN(n) && n > 0)
      : [];

  const httpsPort = portMatch ? Number(portMatch[1]) : undefined;
  let port = rawPorts.length > 0 ? Math.max(...rawPorts) : undefined;
  if (!port && httpsPort && httpsPort > 0) {
    port = httpsPort + 1;
  }

  if (csrfToken || port || rawPorts.length > 0) {
    return { port, ports: rawPorts, csrfToken, isHttps: false };
  }
  return null;
}

export async function discoverUnixLanguageServer(
  execFileFn: ExecFileAsyncFn
): Promise<DiscoveredLanguageServer | null> {
  const { stdout } = await execFileFn('pgrep', ['-a', 'language_server'], {
    timeout: 3000,
  });
  const csrfMatch = /--csrf_token(?:\s+|=)["']?([^\s"']+)["']?/i.exec(stdout);
  const portMatch = /--https_server_port(?:\s+|=)(\d+)/i.exec(stdout);
  const portsMatch = /PORTS:([0-9,]+)/i.exec(stdout);
  const pidMatch = /^(\d+)/m.exec(stdout.trim());
  const csrfToken = csrfMatch ? csrfMatch[1] : undefined;
  const httpsPort = portMatch ? Number(portMatch[1]) : undefined;
  let port = httpsPort && httpsPort > 0 ? httpsPort + 1 : undefined;

  const rawPorts: number[] =
    portsMatch && portsMatch[1]
      ? portsMatch[1]
          .split(',')
          .map(Number)
          .filter((n) => !Number.isNaN(n) && n > 0)
      : [];

  if (pidMatch && pidMatch[1]) {
    const pid = pidMatch[1];
    try {
      const { stdout: ssOut } = await execFileFn('ss', ['-tlpn'], { timeout: 2000 });
      for (const line of ssOut.split('\n')) {
        if (line.includes(`pid=${pid}`)) {
          const p = /(?:127\.0\.0\.1|:::|0\.0\.0\.0):(\d+)/.exec(line);
          if (p && p[1]) rawPorts.push(Number(p[1]));
        }
      }
    } catch {
      try {
        const { stdout: lsofOut } = await execFileFn(
          'lsof',
          ['-nP', '-iTCP', '-sTCP:LISTEN', '-p', pid],
          { timeout: 2000 }
        );
        for (const line of lsofOut.split('\n')) {
          const p = /:(\d+)\s+\(LISTEN\)/.exec(line);
          if (p && p[1]) rawPorts.push(Number(p[1]));
        }
      } catch {
        // Socket lookup is best-effort
      }
    }
  }

  if (rawPorts.length > 0) {
    port = Math.max(...rawPorts);
  }

  if (csrfToken || port || rawPorts.length > 0) {
    return { port, ports: rawPorts, csrfToken, isHttps: false };
  }
  return null;
}

export const discoverLocalLanguageServer = async (
  execFileFn: ExecFileAsyncFn = defaultExecFileAsync
): Promise<DiscoveredLanguageServer | null> => {
  try {
    if (process.platform === 'win32') {
      return await discoverWindowsLanguageServer(execFileFn);
    }
    return await discoverUnixLanguageServer(execFileFn);
  } catch {
    // Process discovery is best-effort
    return null;
  }
};
