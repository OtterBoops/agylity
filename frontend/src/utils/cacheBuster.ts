import { APP_VERSION } from './version';

const VERSION_STORAGE_KEY = 'agylity_client_version';

export const invalidateClientCacheOnNewVersion = async (): Promise<void> => {
  if (typeof window === 'undefined') return;

  try {
    const storedVersion = localStorage.getItem(VERSION_STORAGE_KEY);
    const isNewVersion = storedVersion !== APP_VERSION;

    if ('serviceWorker' in navigator) {
      const registrations = await navigator.serviceWorker.getRegistrations();
      for (const registration of registrations) {
        await registration.unregister();
      }
    }

    if ('caches' in window) {
      const keys = await caches.keys();
      if (keys.length > 0 || isNewVersion) {
        await Promise.all(keys.map((key) => caches.delete(key)));
      }
    }

    if (isNewVersion) {
      localStorage.setItem(VERSION_STORAGE_KEY, APP_VERSION);
    }
  } catch {}
};
