import { useEffect, useState } from 'preact/hooks';

export type TimeFormat = '12h' | '24h';

const STORAGE_KEY = 'agylity-time-format';
const EVENT_NAME = 'agylity:timeformat-changed';

export const getTimeFormat = (): TimeFormat => {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === '24h' || stored === '12h') return stored;
  } catch {}
  return '12h';
};

export const setTimeFormat = (format: TimeFormat): void => {
  try {
    localStorage.setItem(STORAGE_KEY, format);
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent(EVENT_NAME, { detail: format }));
    }
  } catch {}
};

export const formatTime = (
  date: Date | string | number | null | undefined,
  options?: { includeSeconds?: boolean; timeFormat?: TimeFormat }
): string => {
  if (!date) return '';
  const d = date instanceof Date ? date : new Date(date);
  if (isNaN(d.getTime())) return '';
  const fmt = options?.timeFormat ?? getTimeFormat();
  const hour12 = fmt === '12h';
  return d.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: options?.includeSeconds ? '2-digit' : undefined,
    hour12,
  });
};

export const formatDateTime = (
  date: Date | string | number | null | undefined,
  options?: { timeFormat?: TimeFormat }
): string => {
  if (!date) return '';
  const d = date instanceof Date ? date : new Date(date);
  if (isNaN(d.getTime())) return '';
  const fmt = options?.timeFormat ?? getTimeFormat();
  const hour12 = fmt === '12h';
  return d.toLocaleString([], {
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12,
  });
};

export const useTimeFormat = (): [TimeFormat, (fmt: TimeFormat) => void] => {
  const [fmt, setFmt] = useState<TimeFormat>(getTimeFormat);

  useEffect(() => {
    const handleFormatChange = (e: Event) => {
      const custom = e as CustomEvent<TimeFormat>;
      if (custom.detail) {
        setFmt(custom.detail);
      } else {
        setFmt(getTimeFormat());
      }
    };
    window.addEventListener(EVENT_NAME, handleFormatChange);
    return () => window.removeEventListener(EVENT_NAME, handleFormatChange);
  }, []);

  const update = (newFmt: TimeFormat) => {
    setTimeFormat(newFmt);
    setFmt(newFmt);
  };

  return [fmt, update];
};
