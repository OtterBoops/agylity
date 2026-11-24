import { useEffect } from 'preact/hooks';
import { getModels } from '../api';
import type { ModelCatalogEntry, ReasoningEffort } from '../types';
import { createStore, useStore } from './store';

export interface ModelCatalogState {
  models: ModelCatalogEntry[];
  defaultModel: string | null;
  defaultEffort: string | null;
  unattributedModels: string[];
  loaded: boolean;
}

const catalogStore = createStore<ModelCatalogState>({
  models: [],
  defaultModel: null,
  defaultEffort: null,
  unattributedModels: [],
  loaded: false,
});

let inFlight: Promise<ModelCatalogState> | null = null;

export const getModelCatalog = (): ModelCatalogState => catalogStore.getState();

export const loadModelCatalog = async (force = false): Promise<ModelCatalogState> => {
  const state = getModelCatalog();
  if (!force && state.loaded) return state;
  if (inFlight) return inFlight;

  inFlight = getModels()
    .then((res) => {
      const next: ModelCatalogState =
        res.models && res.models.length > 0
          ? {
              models: res.models,
              defaultModel: res.defaultModel,
              defaultEffort: res.defaultEffort,
              unattributedModels: res.unattributedModels ?? [],
              loaded: true,
            }
          : { ...getModelCatalog(), loaded: true };
      catalogStore.setState(next);
      return next;
    })
    .catch(() => {
      const next = { ...getModelCatalog(), loaded: true };
      catalogStore.setState(next);
      return next;
    })
    .finally(() => {
      inFlight = null;
    });

  return inFlight;
};

export const useModelCatalog = (): ModelCatalogState => {
  const state = useStore(catalogStore);
  useEffect(() => {
    void loadModelCatalog();
  }, []);
  return state;
};

export const toModelOptions = (
  models: ModelCatalogEntry[]
): Array<{ value: string; label: string; supportedEfforts: ReasoningEffort[] }> =>
  models.map((m) => ({ value: m.id, label: m.label, supportedEfforts: m.supportedEfforts }));
