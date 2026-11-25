import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type ExecFileAsyncFn = (
  file: string,
  args: readonly string[],
  options?: Record<string, unknown>
) => Promise<{ stdout: string; stderr: string }>;

type ExecFileFailure = Error & {
  code?: number | string | null;
  signal?: string | null;
  killed?: boolean;
  stdout?: string;
  stderr?: string;
};

// execFile kills only the direct child on timeout, so `agy`'s own children keep running against the
// checkout; spawning detached (POSIX) or taskkill /T (Windows) takes the whole tree down.
export const defaultExecFileAsync: ExecFileAsyncFn = (
  file: string,
  args: readonly string[],
  options?: Record<string, unknown>
): Promise<{ stdout: string; stderr: string }> => {
  const callerEnv = (options?.env as Record<string, string> | undefined) ?? {};
  const timeoutMs = typeof options?.timeout === 'number' ? options.timeout : 0;
  const maxBuffer = typeof options?.maxBuffer === 'number' ? options.maxBuffer : 1024 * 1024;
  const signal = options?.signal as AbortSignal | undefined;
  const cwd = options?.cwd as string | undefined;

  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(file, args as string[], {
      cwd,
      windowsHide: true,
      detached: process.platform !== 'win32',
      env: {
        ...process.env,
        ...callerEnv,
        ...(process.platform === 'win32' ? { AGY_CLI_DISABLE_AUTO_UPDATE: 'true' } : {}),
      },
    });

    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let size = 0;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;

    const killTree = (): void => {
      if (!child.pid) return;
      if (process.platform === 'win32') {
        const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
          windowsHide: true,
          stdio: 'ignore',
        });
        killer.on('error', () => child.kill('SIGKILL'));
      } else {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          child.kill('SIGKILL');
        }
      }
    };

    const settle = (error: ExecFileFailure | null): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      const stdout = Buffer.concat(out).toString('utf8');
      const stderr = Buffer.concat(err).toString('utf8');
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    };

    const onAbort = (): void => {
      killTree();
      const abortError = new Error('The operation was aborted') as ExecFileFailure;
      abortError.name = 'AbortError';
      settle(abortError);
    };

    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        killTree();
        const timeoutError = new Error(
          `Command timed out after ${timeoutMs}ms: ${file}`
        ) as ExecFileFailure;
        timeoutError.killed = true;
        timeoutError.code = 'ETIMEDOUT';
        settle(timeoutError);
      }, timeoutMs);
    }

    const capture = (chunk: Buffer, sink: Buffer[]): void => {
      if (settled) return;
      size += chunk.length;
      if (size > maxBuffer) {
        killTree();
        const overflow = new Error(`Command output exceeded ${maxBuffer} bytes: ${file}`);
        overflow.name = 'RangeError';
        (overflow as ExecFileFailure).code = 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
        settle(overflow as ExecFileFailure);
        return;
      }
      sink.push(chunk);
    };

    child.stdout?.on('data', (chunk: Buffer) => {
      capture(chunk, out);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      capture(chunk, err);
    });

    child.on('error', (spawnError: NodeJS.ErrnoException) => {
      const failure = new Error(spawnError.message) as ExecFileFailure;
      failure.code = spawnError.code;
      settle(failure);
    });

    child.on('close', (exitCode, exitSignal) => {
      if (exitCode === 0) {
        settle(null);
        return;
      }
      const failure = new Error(`Command failed: ${file} ${args.join(' ')}`) as ExecFileFailure;
      failure.code = exitCode;
      failure.signal = exitSignal;
      settle(failure);
    });
  });
};

export interface DiscoveredLanguageServer {
  port?: number;
  ports?: number[];
  csrfToken?: string;
}

const CSRF_TOKEN_RE = /--csrf_token(?:\s+|=)["']?([^\s"']+)["']?/i;
const HTTPS_PORT_RE = /--https_server_port(?:\s+|=)(\d+)/i;
const PORTS_LIST_RE = /PORTS:([0-9,]+)/i;

const portsFromList = (text: string): number[] => {
  const match = PORTS_LIST_RE.exec(text);
  return match?.[1]
    ? match[1]
        .split(',')
        .map(Number)
        .filter((n) => !Number.isNaN(n) && n > 0)
    : [];
};

export const parseWindowsNetstatPorts = (netstatOut: string, pid: string): number[] => {
  const ports: number[] = [];
  for (const line of netstatOut.split('\n')) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 5) continue;
    const proto = cols[0] ?? '';
    const localAddr = cols[1] ?? '';
    const state = cols[3] ?? '';
    const rowPid = cols[4] ?? '';
    if (proto.toUpperCase() !== 'TCP' || state.toUpperCase() !== 'LISTENING') continue;
    if (rowPid !== pid) continue;
    const m = /^(?:127\.0\.0\.1|\[::1\]):(\d+)$/.exec(localAddr);
    if (m && m[1]) ports.push(Number(m[1]));
  }
  return ports;
};

export const discoverWindowsLanguageServer = async (
  execFileFn: ExecFileAsyncFn
): Promise<DiscoveredLanguageServer | null> => {
  let commandLine = '';
  const rawPorts: number[] = [];

  // The WMI query runs through the GUI subsystem (wscript.exe) to prevent a console window allocation on Windows 11.
  try {
    const { stdout: tasklistOut } = await execFileFn(
      'tasklist',
      ['/fi', 'imagename eq language_server.exe', '/fo', 'csv', '/nh'],
      { windowsHide: true, timeout: 3000 }
    );
    const pidMatch = /"language_server\.exe","(\d+)"/i.exec(tasklistOut);
    if (pidMatch && pidMatch[1]) {
      const pid = pidMatch[1];

      try {
        const { stdout: netstatOut } = await execFileFn('netstat', ['-ano', '-p', 'tcp'], {
          windowsHide: true,
          timeout: 3000,
        });
        rawPorts.push(...parseWindowsNetstatPorts(netstatOut, pid));
      } catch {}

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
  } catch {}

  if (!CSRF_TOKEN_RE.test(commandLine)) {
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
      rawPorts.push(...portsFromList(res.stdout));
    } catch {}
  }

  const csrfMatch = CSRF_TOKEN_RE.exec(commandLine);
  const portMatch = HTTPS_PORT_RE.exec(commandLine);

  const csrfToken = csrfMatch ? csrfMatch[1] : undefined;
  rawPorts.push(...portsFromList(commandLine));

  const httpsPort = portMatch ? Number(portMatch[1]) : undefined;
  let port = rawPorts.length > 0 ? Math.max(...rawPorts) : undefined;
  if (!port && httpsPort && httpsPort > 0) {
    port = httpsPort + 1;
  }

  if (csrfToken || port || rawPorts.length > 0) {
    return { port, ports: rawPorts, csrfToken };
  }
  return null;
};

const discoverUnixLanguageServer = async (
  execFileFn: ExecFileAsyncFn
): Promise<DiscoveredLanguageServer | null> => {
  const { stdout } = await execFileFn('pgrep', ['-a', 'language_server'], {
    timeout: 3000,
  });
  const csrfMatch = CSRF_TOKEN_RE.exec(stdout);
  const portMatch = HTTPS_PORT_RE.exec(stdout);
  const pidMatch = /^(\d+)/m.exec(stdout.trim());
  const csrfToken = csrfMatch ? csrfMatch[1] : undefined;
  const httpsPort = portMatch ? Number(portMatch[1]) : undefined;
  let port = httpsPort && httpsPort > 0 ? httpsPort + 1 : undefined;

  const rawPorts: number[] = portsFromList(stdout);

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
      } catch {}
    }
  }

  if (rawPorts.length > 0) {
    port = Math.max(...rawPorts);
  }

  if (csrfToken || port || rawPorts.length > 0) {
    return { port, ports: rawPorts, csrfToken };
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
    return null;
  }
};
