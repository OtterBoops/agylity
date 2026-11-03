import { APP_VERSION } from './version';

const VERSION_STORAGE_KEY = 'agylity_client_version';

// Ensures any registered service workers from previous builds or development
export const invalidateClientCacheOnNewVersion = async (): Promise<void> => {
  if (typeof window === 'undefined') return;

  try {
    const storedVersion = localStorage.getItem(VERSION_STORAGE_KEY);
    const isNewVersion = storedVersion !== APP_VERSION;

    // 1. Unregister all existing service workers unconditionally
    if ('serviceWorker' in navigator) {
      const registrations = await navigator.serviceWorker.getRegistrations();
      for (const registration of registrations) {
        await registration.unregister();
      }
    }

    // 2. Clear browser CacheStorage if version changed or if any caches exist
    if ('caches' in window) {
      const keys = await caches.keys();
      if (keys.length > 0 || isNewVersion) {
        await Promise.all(keys.map((key) => caches.delete(key)));
      }
    }

    // 3. Record current version
    if (isNewVersion) {
      localStorage.setItem(VERSION_STORAGE_KEY, APP_VERSION);
    }
  } catch {
    // Non-fatal if browser restrictions block storage access
  }
};
