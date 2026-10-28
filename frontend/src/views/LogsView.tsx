import { faCheck, faCopy, faDownload, faPause, faPlay } from '@fortawesome/free-solid-svg-icons';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { LogEntry, LogLevel } from '../types';
import { getLogs } from '../api';
import { Icon } from '../components/Icon';

const MAX_LINES = 1000;

const LEVEL_STYLE: Record<LogLevel, string> = {
  debug: 'text-pine-muted',
  info: 'text-pine-foam',
  warn: 'text-pine-gold',
  error: 'text-pine-love',
};

type NamespaceFacet = 'all' | 'sentry' | 'notify' | 'web' | 'runner';

const FACET_KEYWORDS: Record<Exclude<NamespaceFacet, 'all'>, string[]> = {
  sentry: ['sentry', 'quota', 'probe', 'milestone', 'pool'],
  notify: ['notify', 'discord', 'webhook', 'channel', 'alert'],
  web: ['web', 'http', 'api', 'server', 'request', 'status'],
  runner: ['runner', 'dispatch', 'task', 'git', 'worktree'],
};

export const LogsView = () => {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [enabled, setEnabled] = useState(true);
  const [level, setLevel] = useState<LogLevel>('info');
  const [namespace, setNamespace] = useState<NamespaceFacet>('all');
  const [query, setQuery] = useState('');
  const [paused, setPaused] = useState(false);
  const [copied, setCopied] = useState(false);
  const lastId = useRef(0);
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (paused) return;
    let cancelled = false;

    const poll = () => {
      getLogs(lastId.current, 'debug')
        .then((data) => {
          if (cancelled) return;
          setEnabled(data.enabled);
          if (data.entries.length > 0) {
            lastId.current = data.entries[data.entries.length - 1]!.id;
            setEntries((prev) => [...prev, ...data.entries].slice(-MAX_LINES));
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

  const rank: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };
  const q = query.trim().toLowerCase();

  const visible = entries.filter((e) => {
    if (rank[e.level] < rank[level]) return false;
    const msg = e.message.toLowerCase();
    if (q && !msg.includes(q)) return false;
    if (namespace !== 'all') {
      const keywords = FACET_KEYWORDS[namespace];
      if (!keywords.some((kw) => msg.includes(kw))) return false;
    }
    return true;
  });

  useEffect(() => {
    if (!paused && scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
  }, [visible.length, paused]);

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
    <div class="flex flex-col gap-4">
      {/* Top Filter Bar */}
      <div class="flex flex-wrap items-center gap-3">
        <select
          class="cursor-pointer rounded-lg border border-pine-highlight bg-pine-surface px-3 py-1.5 text-sm text-pine-text outline-none focus:border-pine-iris"
          value={level}
          onChange={(e) => setLevel((e.target as HTMLSelectElement).value as LogLevel)}
        >
          <option value="debug">Debug +</option>
          <option value="info">Info +</option>
          <option value="warn">Warnings +</option>
          <option value="error">Errors only</option>
        </select>

        {/* Facet pills */}
        <div class="inline-flex rounded-lg border border-pine-highlight bg-pine-surface p-0.5 text-xs">
          {(['all', 'sentry', 'notify', 'web', 'runner'] as NamespaceFacet[]).map((facet) => (
            <button
              key={facet}
              type="button"
              onClick={() => setNamespace(facet)}
              class={`cursor-pointer rounded-md px-2.5 py-1 font-medium capitalize transition-colors ${
                namespace === facet
                  ? 'bg-pine-iris text-pine-base shadow-xs'
                  : 'text-pine-subtle hover:text-pine-text'
              }`}
            >
              {facet}
            </button>
          ))}
        </div>

        <input
          type="search"
          class="min-w-[180px] flex-1 rounded-lg border border-pine-highlight bg-pine-surface px-3 py-1.5 text-sm text-pine-text outline-none focus:border-pine-iris"
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

        <span class="text-xs text-pine-muted">{visible.length} lines</span>
      </div>

      {/* Terminal Output */}
      <div
        ref={scroller}
        class="h-[60vh] overflow-y-auto rounded-xl border border-pine-highlight bg-pine-surface p-4 font-mono text-xs/relaxed shadow-sm"
      >
        {!enabled ? (
          <p class="text-pine-muted">
            Log capture isn't active in this process. It starts with the daemon entrypoint (
            <code>npm start</code>).
          </p>
        ) : visible.length === 0 ? (
          <p class="text-pine-muted">No log lines match current filters.</p>
        ) : (
          visible.map((e) => (
            <div key={e.id} class="flex gap-3 hover:bg-white/[0.03]">
              <span class="shrink-0 text-pine-muted">{new Date(e.ts).toLocaleTimeString()}</span>
              <span class={`w-12 shrink-0 font-bold uppercase ${LEVEL_STYLE[e.level]}`}>
                {e.level}
              </span>
              <span class="break-all whitespace-pre-wrap text-pine-text">{e.message}</span>
            </div>
          ))
        )}
      </div>

      <div class="flex flex-wrap items-center justify-between text-xs text-pine-muted">
        <span>
          Last {MAX_LINES} lines are kept in memory only and cleared on restart. Tokens and secrets
          are redacted server-side.
        </span>
        <span>Streaming live via /api/logs</span>
      </div>
    </div>
  );
};
