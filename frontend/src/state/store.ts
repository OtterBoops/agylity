import { useState, useEffect } from 'preact/hooks';

export interface Store<T> {
  getState: () => T;
  setState: (updater: T | ((prev: T) => T)) => void;
  subscribe: (listener: () => void) => () => void;
}

export function createStore<T>(initialState: T): Store<T> {
  let state = initialState;
  const listeners = new Set<() => void>();

  return {
    getState: () => state,
    setState: (updater) => {
      state = typeof updater === 'function' ? (updater as (prev: T) => T)(state) : updater;
      listeners.forEach((listener) => {
        try {
          listener();
        } catch (err) {
          console.error('[agylity] Store listener error:', err);
        }
      });
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export function useStore<T>(store: Store<T>): T {
  const [state, setState] = useState(store.getState);

  useEffect(() => {
    setState(store.getState());
    return store.subscribe(() => {
      setState(store.getState());
    });
  }, [store]);

  return state;
}
