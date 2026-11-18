import { useEffect, useState } from 'preact/hooks';
import { getModels } from '../api';
import type { ModelCatalogEntry, ReasoningEffort } from '../types';

export interface ModelCatalogState {
  models: ModelCatalogEntry[];
  defaultModel: string | null;
  defaultEffort: string | null;
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

export const loadModelCatalog = async (force = false): Promise<ModelCatalogState> => {
  if (!force && state.loaded) return state;
  if (inFlight) return inFlight;

  inFlight = getModels()
    .then((res) => {
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

export const toModelOptions = (
  models: ModelCatalogEntry[]
): Array<{ value: string; label: string; supportedEfforts: ReasoningEffort[] }> =>
  models.map((m) => ({ value: m.id, label: m.label, supportedEfforts: m.supportedEfforts }));
