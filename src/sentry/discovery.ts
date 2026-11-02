import { execFile as nodeExecFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const promisifiedExecFile = promisify(nodeExecFile);

export type ExecFileAsyncFn = (
  file: string,
  args: readonly string[],
  options?: Record<string, unknown>
) => Promise<{ stdout: string; stderr: string }>;

export const defaultExecFileAsync: ExecFileAsyncFn = (
  file: string,
  args: readonly string[],
  options?: Record<string, unknown>
): Promise<{ stdout: string; stderr: string }> => {
  return promisifiedExecFile(file, args as string[], {
    windowsHide: true,
    ...options,
  }) as Promise<{ stdout: string; stderr: string }>;
};

export interface DiscoveredLanguageServer {
  port?: number;
  ports?: number[];
  csrfToken?: string;
  isHttps?: boolean;
}

export const discoverWindowsLanguageServer = async (
  execFileFn: ExecFileAsyncFn
): Promise<DiscoveredLanguageServer | null> => {
  let commandLine = '';
  const rawPorts: number[] = [];

  // 1. Silent WMI query via GUI subsystem (wscript.exe) to strictly prevent console window allocation in Windows 11
  try {
    const { stdout: tasklistOut } = await execFileFn(
      'tasklist',
      ['/fi', 'imagename eq language_server.exe', '/fo', 'csv', '/nh'],
      { windowsHide: true, timeout: 3000 }
    );
    const pidMatch = /"language_server\.exe","(\d+)"/i.exec(tasklistOut);
    if (pidMatch && pidMatch[1]) {
      const pid = pidMatch[1];

      // Netstat to find listening loopback ports for the PID
      try {
        const { stdout: netstatOut } = await execFileFn('netstat', ['-ano', '-p', 'tcp'], {
          windowsHide: true,
          timeout: 3000,
        });
        for (const line of netstatOut.split('\n')) {
          if (line.includes('LISTENING') && line.includes(pid)) {
            const m = /127\.0\.0\.1:(\d+)/.exec(line);
            if (m && m[1]) rawPorts.push(Number(m[1]));
          }
        }
      } catch {
        // Netstat lookup is best effort
      }

      // Query CommandLine via wscript.exe (GUI subsystem executable: zero console window)
      const tmpVbs = path.join(
        os.tmpdir(),
        `agylity_wmi_${Date.now()}_${Math.random().toString(36).slice(2)}.vbs`
      );
      const tmpOut = path.join(
        os.tmpdir(),
        `agylity_cmd_${Date.now()}_${Math.random().toString(36).slice(2)}.txt`
      );
      try {
        const vbsContent = [
          'Set fso = CreateObject("Scripting.FileSystemObject")',
          'Set wmi = GetObject("winmgmts:")',
          `Set procs = wmi.ExecQuery("Select CommandLine from Win32_Process where ProcessId = ${pid}")`,
          'For Each p in procs',
          `  fso.CreateTextFile("${tmpOut.replace(/\\/g, '\\\\')}", True).Write(p.CommandLine)`,
          '  Exit For',
          'Next',
        ].join('\r\n');

        await fs.promises.writeFile(tmpVbs, vbsContent, 'utf8');
        await execFileFn('wscript.exe', ['//nologo', tmpVbs], {
          timeout: 3000,
          windowsHide: true,
        });
        if (fs.existsSync(tmpOut)) {
          commandLine = await fs.promises.readFile(tmpOut, 'utf8');
        }
      } finally {
        try {
          await fs.promises.unlink(tmpVbs);
        } catch {}
        try {
          await fs.promises.unlink(tmpOut);
        } catch {}
      }
    }
  } catch {
    // Fallback if tasklist/wscript is unavailable
  }

  // Fallback to powershell only if silent discovery returned nothing
  if (!commandLine && rawPorts.length === 0) {
    const psScript = `
    $proc = Get-Process -Name 'language_server' -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($proc) {
      $cmd = (Get-CimInstance Win32_Process -Filter "ProcessId = $($proc.Id)" -ErrorAction SilentlyContinue).CommandLine
      $ports = (Get-NetTCPConnection -OwningProcess $proc.Id -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalAddress -eq '127.0.0.1' } | Select-Object -ExpandProperty LocalPort)
      Write-Output "CMD:$cmd"
      Write-Output "PORTS:$($ports -join ',')"
    }
  `;
    try {
      const res = await execFileFn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', psScript],
        { timeout: 4000, windowsHide: true }
      );
      commandLine = res.stdout;
      const portsMatch = /PORTS:([0-9,]+)/i.exec(res.stdout);
      if (portsMatch && portsMatch[1]) {
        rawPorts.push(
          ...portsMatch[1]
            .split(',')
            .map(Number)
            .filter((n) => !Number.isNaN(n) && n > 0)
        );
      }
    } catch {
      // Best-effort
    }
  }

  const csrfMatch = /--csrf_token(?:\s+|=)["']?([^\s"']+)["']?/i.exec(commandLine);
  const portMatch = /--https_server_port(?:\s+|=)(\d+)/i.exec(commandLine);
  const portsMatch = /PORTS:([0-9,]+)/i.exec(commandLine);

  const csrfToken = csrfMatch ? csrfMatch[1] : undefined;
  if (portsMatch && portsMatch[1]) {
    rawPorts.push(
      ...portsMatch[1]
        .split(',')
        .map(Number)
        .filter((n) => !Number.isNaN(n) && n > 0)
    );
  }

  const httpsPort = portMatch ? Number(portMatch[1]) : undefined;
  let port = rawPorts.length > 0 ? Math.max(...rawPorts) : undefined;
  if (!port && httpsPort && httpsPort > 0) {
    port = httpsPort + 1;
  }

  if (csrfToken || port || rawPorts.length > 0) {
    return { port, ports: rawPorts, csrfToken, isHttps: false };
  }
  return null;
};

export const discoverUnixLanguageServer = async (
  execFileFn: ExecFileAsyncFn
): Promise<DiscoveredLanguageServer | null> => {
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
};

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
