import { faCheck, faCopy, faDownload, faPause, faPlay } from '@fortawesome/free-solid-svg-icons';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { LogEntry, LogLevel } from '../types';
import { getLogs } from '../api';
import { Icon } from '../components/Icon';
import { formatTime, useTimeFormat } from '../utils/time';

const MAX_LINES = 1000;

const LEVEL_STYLE: Record<LogLevel, string> = {
  debug: 'text-pine-subtle',
  info: 'text-pine-foam',
  warn: 'text-pine-gold',
  error: 'text-pine-love',
};

export const LogsView = () => {
  const [timeFormat] = useTimeFormat();
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [enabled, setEnabled] = useState(true);
  const [query, setQuery] = useState('');
  const [paused, setPaused] = useState(false);
  const [copied, setCopied] = useState(false);
  const lastId = useRef(0);
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (paused) return;
    let cancelled = false;

    const poll = () => {
      if (document.hidden) return;
      getLogs(lastId.current, 'debug')
        .then((data) => {
          if (cancelled) return;
          setEnabled(data.enabled);
          if (data.latestId !== undefined && data.latestId < lastId.current) {
            // Daemon restarted: auto-reset ring buffer pointer and state
            lastId.current = 0;
            setEntries(data.entries.slice(-MAX_LINES));
            if (data.entries.length > 0) {
              lastId.current = data.entries[data.entries.length - 1]!.id;
            }
            return;
          }
          if (data.entries.length > 0) {
            lastId.current = data.entries[data.entries.length - 1]!.id;
            setEntries((prev) => {
              const existingIds = new Set(prev.map((e) => e.id));
              const newEntries = data.entries.filter((e) => !existingIds.has(e.id));
              return [...prev, ...newEntries].slice(-MAX_LINES);
            });
          }
        })
        .catch(() => {
          // transient network error; next tick retries
        });
    };

    poll();
    const timer = setInterval(poll, 2000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [paused]);

  const q = query.trim().toLowerCase();

  const visible = useMemo(() => {
    return entries.filter((e) => !q || e.message.toLowerCase().includes(q));
  }, [entries, q]);

  useEffect(() => {
    if (!paused && !q && scroller.current) {
      const isNearBottom =
        scroller.current.scrollHeight - scroller.current.scrollTop - scroller.current.clientHeight <
        50;
      if (isNearBottom) {
        scroller.current.scrollTop = scroller.current.scrollHeight;
      }
    }
  }, [entries.length, paused, q]);

  const handleCopyLogs = async () => {
    if (visible.length === 0) return;
    const formatted = visible
      .map(
        (e) => `[${new Date(e.ts).toISOString()}] [${e.level.toUpperCase().padEnd(5)}] ${e.message}`
      )
      .join('\n');
    try {
      await navigator.clipboard.writeText(formatted);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // fallback
    }
  };

  const handleDownloadLogs = () => {
    if (visible.length === 0) return;
    const formatted = visible
      .map(
        (e) => `[${new Date(e.ts).toISOString()}] [${e.level.toUpperCase().padEnd(5)}] ${e.message}`
      )
      .join('\n');
    const blob = new Blob([formatted], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `agylity-${new Date().toISOString().slice(0, 10)}.log`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return (
    <div class="flex min-h-0 flex-1 flex-col gap-4">
      {/* Top Filter Bar */}
      <div class="flex flex-wrap items-center gap-3">
        <input
          type="search"
          aria-label="Filter log lines"
          autoComplete="off"
          data-1p-ignore="true"
          data-lpignore="true"
          class="min-w-48 flex-1 rounded-lg border border-pine-highlight bg-pine-surface px-3 py-1.5 text-sm text-pine-text placeholder-pine-subtle outline-none focus:border-pine-iris"
          placeholder="Filter log lines..."
          value={query}
          onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
        />

        <div class="flex items-center gap-2">
          <button
            type="button"
            class="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-pine-highlight bg-pine-surface px-3 py-1.5 text-xs font-medium text-pine-text transition-colors hover:bg-pine-overlay"
            onClick={() => setPaused(!paused)}
          >
            <Icon icon={paused ? faPlay : faPause} class="size-3 text-pine-iris" />
            <span>{paused ? 'Resume' : 'Pause'}</span>
          </button>

          <button
            type="button"
            class="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-pine-highlight bg-pine-surface px-3 py-1.5 text-xs font-medium text-pine-text transition-colors hover:bg-pine-overlay"
            onClick={handleCopyLogs}
            disabled={visible.length === 0}
            title="Copy visible log lines to clipboard"
          >
            <Icon icon={copied ? faCheck : faCopy} class="size-3 text-pine-foam" />
            <span>{copied ? 'Copied' : 'Copy'}</span>
          </button>

          <button
            type="button"
            class="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-pine-highlight bg-pine-surface px-3 py-1.5 text-xs font-medium text-pine-text transition-colors hover:bg-pine-overlay"
            onClick={handleDownloadLogs}
            disabled={visible.length === 0}
            title="Download visible logs as .log file"
          >
            <Icon icon={faDownload} class="size-3 text-pine-iris" />
            <span>Export</span>
          </button>

          <button
            type="button"
            class="cursor-pointer rounded-lg border border-pine-highlight bg-pine-surface px-3 py-1.5 text-xs font-medium text-pine-subtle transition-colors hover:bg-pine-overlay hover:text-pine-text"
            onClick={() => setEntries([])}
          >
            Clear view
          </button>
        </div>

        <span class="text-xs text-pine-subtle">{visible.length} lines</span>
      </div>

      {/* Terminal Output */}
      <div
        ref={scroller}
        class="min-h-96 flex-1 overflow-y-auto rounded-xl border border-pine-highlight bg-pine-surface p-4 font-mono text-xs/relaxed shadow-sm"
      >
        {!enabled ? (
          <p class="text-pine-subtle">
            Log capture isn't active in this process. It starts with the daemon entrypoint (
            <code>npm start</code>).
          </p>
        ) : visible.length === 0 ? (
          <p class="text-pine-subtle">No log lines match current filters.</p>
        ) : (
          visible.map((e) => (
            <div key={`${e.id}-${e.ts}`} class="flex gap-3 hover:bg-pine-overlay/30">
              <span class="shrink-0 font-mono text-pine-subtle">
                {formatTime(e.ts, { includeSeconds: true, timeFormat })}
              </span>
              <span class={`w-12 shrink-0 font-bold uppercase ${LEVEL_STYLE[e.level]}`}>
                {e.level}
              </span>
              <span class="break-all whitespace-pre-wrap text-pine-text">{e.message}</span>
            </div>
          ))
        )}
      </div>

      <p class="text-xs text-pine-subtle">
        Last {MAX_LINES} lines are kept in memory only and cleared on restart. Tokens and secrets
        are redacted server-side.
      </p>
    </div>
  );
};
