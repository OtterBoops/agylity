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
        .catch(() => {});
    };

    poll();
    const timer = setInterval(poll, 2000);
    const onVisible = () => {
      if (!document.hidden) poll();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
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
    } catch {}
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
      <div class="flex min-h-96 flex-1 flex-col overflow-hidden rounded-xl border border-pine-highlight">
        <div class="flex shrink-0 flex-wrap items-center gap-2 border-b border-pine-highlight bg-pine-surface px-3 py-2">
          <input
            type="search"
            aria-label="Filter log lines"
            autoComplete="off"
            data-1p-ignore="true"
            data-lpignore="true"
            class="min-w-40 flex-1 rounded-lg border border-pine-highlight bg-pine-overlay px-3 py-1.5 text-sm text-pine-text placeholder-pine-subtle outline-none focus:border-pine-iris"
            placeholder="Filter log lines..."
            value={query}
            onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
          />

          <div class="flex flex-wrap items-center gap-2">
            <button
              type="button"
              class="inline-flex min-h-9 cursor-pointer items-center gap-1.5 rounded-lg border border-pine-highlight bg-pine-overlay px-3 py-1.5 text-xs font-medium text-pine-text transition-colors hover:bg-pine-highlight"
              onClick={() => setPaused(!paused)}
            >
              <Icon icon={paused ? faPlay : faPause} class="size-3 text-pine-iris" />
              <span>{paused ? 'Resume' : 'Pause'}</span>
            </button>

            <button
              type="button"
              class="inline-flex min-h-9 cursor-pointer items-center gap-1.5 rounded-lg border border-pine-highlight bg-pine-overlay px-3 py-1.5 text-xs font-medium text-pine-text transition-colors hover:bg-pine-highlight"
              onClick={handleCopyLogs}
              disabled={visible.length === 0}
              title="Copy visible log lines to clipboard"
            >
              <Icon icon={copied ? faCheck : faCopy} class="size-3 text-pine-foam" />
              <span>{copied ? 'Copied' : 'Copy'}</span>
            </button>

            <button
              type="button"
              class="inline-flex min-h-9 cursor-pointer items-center gap-1.5 rounded-lg border border-pine-highlight bg-pine-overlay px-3 py-1.5 text-xs font-medium text-pine-text transition-colors hover:bg-pine-highlight"
              onClick={handleDownloadLogs}
              disabled={visible.length === 0}
              title="Download visible logs as .log file"
            >
              <Icon icon={faDownload} class="size-3 text-pine-iris" />
              <span>Export</span>
            </button>

            <button
              type="button"
              class="min-h-9 cursor-pointer rounded-lg border border-pine-highlight bg-pine-overlay px-3 py-1.5 text-xs font-medium whitespace-nowrap text-pine-subtle transition-colors hover:bg-pine-highlight hover:text-pine-text"
              onClick={() => setEntries([])}
            >
              Clear view
            </button>
          </div>

          <span class="font-mono text-xs whitespace-nowrap text-pine-subtle">
            {visible.length} lines
          </span>
        </div>

        <div
          ref={scroller}
          class="min-h-0 flex-1 overflow-y-auto bg-pine-sunken p-4 font-mono text-xs/relaxed"
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
              <div
                key={`${e.id}-${e.ts}`}
                class="flex flex-col gap-0.5 py-0.5 hover:bg-pine-overlay/30 sm:flex-row sm:gap-3 sm:py-0"
              >
                <span class="flex shrink-0 items-center gap-2">
                  <span class="font-mono text-xs text-pine-subtle">
                    {formatTime(e.ts, { includeSeconds: true, timeFormat })}
                  </span>
                  <span class={`font-bold uppercase ${LEVEL_STYLE[e.level]}`}>{e.level}</span>
                </span>
                <span class="min-w-0 wrap-break-word whitespace-pre-wrap text-pine-text">
                  {e.message}
                </span>
              </div>
            ))
          )}
        </div>
      </div>

      <p class="text-xs text-pine-subtle">
        Last {MAX_LINES} lines are kept in memory only and cleared on restart. Tokens and secrets
        are redacted server-side.
      </p>
    </div>
  );
};
