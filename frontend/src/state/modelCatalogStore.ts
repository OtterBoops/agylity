import { useEffect, useState } from 'preact/hooks';
import { getModels } from '../api';
import type { ModelCatalogEntry } from '../types';

export interface ModelCatalogState {
  models: ModelCatalogEntry[];
  defaultModel: string | null;
  defaultEffort: string | null;
  /** Models the server could not attribute to a quota pool; they are deliberately unselectable. */
  unattributedModels: string[];
  loaded: boolean;
}

const initialState: ModelCatalogState = {
  models: [],
  defaultModel: null,
  defaultEffort: null,
  unattributedModels: [],
  loaded: false,
};

let state: ModelCatalogState = initialState;
let inFlight: Promise<ModelCatalogState> | null = null;
const listeners = new Set<(next: ModelCatalogState) => void>();

const publish = (next: ModelCatalogState): ModelCatalogState => {
  state = next;
  listeners.forEach((listener) => {
    try {
      listener(state);
    } catch (err) {
      console.error('[agylity] Model catalog listener error:', err);
    }
  });
  return state;
};

export const getModelCatalog = (): ModelCatalogState => state;

/**
 * One shared fetch for every view that offers model choice, so the dashboard shows whatever
 * models the CLI reports without a per-component request.
 */
export const loadModelCatalog = async (force = false): Promise<ModelCatalogState> => {
  if (!force && state.loaded) return state;
  if (inFlight) return inFlight;

  inFlight = getModels()
    .then((res) => {
      // An empty list means the endpoint failed; keep the last good catalog rather than blanking.
      if (!res.models || res.models.length === 0) {
        return publish({ ...state, loaded: true });
      }
      return publish({
        models: res.models,
        defaultModel: res.defaultModel,
        defaultEffort: res.defaultEffort,
        unattributedModels: res.unattributedModels ?? [],
        loaded: true,
      });
    })
    .catch(() => publish({ ...state, loaded: true }))
    .finally(() => {
      inFlight = null;
    });

  return inFlight;
};

export const useModelCatalog = (): ModelCatalogState => {
  const [snapshot, setSnapshot] = useState<ModelCatalogState>(state);

  useEffect(() => {
    setSnapshot(state);
    const listener = (next: ModelCatalogState) => setSnapshot(next);
    listeners.add(listener);
    void loadModelCatalog();
    return () => {
      listeners.delete(listener);
    };
  }, []);

  return snapshot;
};

/** Catalog entries as select options, ordered as the CLI reports them. */
export const toModelOptions = (
  models: ModelCatalogEntry[]
): Array<{ value: string; label: string }> => models.map((m) => ({ value: m.id, label: m.label }));
