import { useState, useEffect, useCallback } from 'preact/hooks';
import { faClock, faMinus, faPlay, faPlus, faTrash } from '@fortawesome/free-solid-svg-icons';
import type { ConfigData, ReasoningEffort, RepositoryConfig, StandingTaskRecord } from '../types';
import {
  getStandingTasks,
  createStandingTask,
  updateStandingTask,
  deleteStandingTask,
  triggerStandingTask,
} from '../api';
import { Icon } from './Icon';
import { ToggleSwitch } from './ToggleSwitch';
import { EFFORT_OPTIONS, MODEL_OPTIONS, resolveModelEffort } from '../config/fields';
import { useModelCatalog } from '../state/modelCatalogStore';

interface StandingTasksCardProps {
  config: ConfigData;
}

export const StandingTasksCard = ({ config }: StandingTasksCardProps) => {
  const [tasks, setTasks] = useState<StandingTaskRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [actionId, setActionId] = useState<string | null>(null);

  // Form state
  const repos = config.resolved?.repositories || [];
  const defaultRepoId = repos[0]?.id || 'agylity';
  const catalog = useModelCatalog();
  // Live catalog first; the bundled list only covers the window before it loads.
  const modelOptions =
    catalog.models.length > 0
      ? catalog.models.map((m) => ({ value: m.id, label: m.label }))
      : MODEL_OPTIONS;
  const defaultModel =
    config.resolved?.defaultDispatchModel || catalog.defaultModel || 'claude-sonnet-5-5';

  const [title, setTitle] = useState('');
  const [prompt, setPrompt] = useState('');
  const [repositoryId, setRepositoryId] = useState(defaultRepoId);
  const [model, setModel] = useState(defaultModel);
  const [effort, setEffort] = useState<ReasoningEffort>('high');
  const [triggerHours, setTriggerHours] = useState(4);
  const [autoCreatePr, setAutoCreatePr] = useState(true);
  const [verifyCommand, setVerifyCommand] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  const refreshTasks = useCallback(async () => {
    try {
      const list = await getStandingTasks();
      setTasks(list);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshTasks();
  }, [refreshTasks]);

  const handleToggleEnabled = async (task: StandingTaskRecord) => {
    setActionId(task.id);
    setStatusMessage(null);
    try {
      await updateStandingTask(task.id, { enabled: !task.enabled });
      await refreshTasks();
    } catch (err: any) {
      setStatusMessage(`[Error] Failed to toggle routine: ${err?.message || String(err)}`);
    } finally {
      setActionId(null);
    }
  };

  const handleDelete = async (id: string) => {
    setActionId(id);
    setStatusMessage(null);
    try {
      await deleteStandingTask(id);
      await refreshTasks();
    } catch (err: any) {
      setStatusMessage(`[Error] Failed to delete routine: ${err?.message || String(err)}`);
    } finally {
      setActionId(null);
    }
  };

  const handleTriggerNow = async (task: StandingTaskRecord) => {
    setActionId(task.id);
    setStatusMessage(null);
    try {
      const res = await triggerStandingTask(task.id);
      if (!res.success || !res.taskId) {
        setStatusMessage(
          `[Blocked] Routine ${task.id} was not dispatched: ${res.error || 'no task was queued'}`
        );
        await refreshTasks();
        return;
      }
      setStatusMessage(`[Success] Dispatched routine ${task.id} (Task ID: ${res.taskId})`);
      await refreshTasks();
    } catch (err: any) {
      setStatusMessage(`[Error] Failed to trigger standing task: ${err?.message || String(err)}`);
    } finally {
      setActionId(null);
    }
  };

  const handleCreate = async (e: Event) => {
    e.preventDefault();
    if (!title.trim() || !prompt.trim()) return;

    setIsSubmitting(true);
    setStatusMessage(null);
    try {
      await createStandingTask({
        title: title.trim(),
        prompt: prompt.trim(),
        repositoryId,
        model,
        effort,
        triggerBeforeResetHours: triggerHours,
        autoCreatePr,
        verifyCommand: verifyCommand.trim() || undefined,
        enabled: true,
      });
      setTitle('');
      setPrompt('');
      setVerifyCommand('');
      setShowCreate(false);
      await refreshTasks();
      setStatusMessage(`[Success] Created standing task "${title.trim()}"`);
    } catch (err: any) {
      setStatusMessage(`[Error] Failed to create standing task: ${err?.message || String(err)}`);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div class="rounded-xl border border-pine-highlight bg-pine-surface p-6 shadow-sm">
      <div class="flex flex-wrap items-center justify-between gap-4">
        <div>
          <div class="mb-1 flex flex-wrap items-center gap-2">
            <Icon icon={faClock} class="size-5 text-pine-rose" />
            <h3 class="text-lg font-semibold text-pine-text">
              Standing Tasks &amp; Quota-Burn Templates
            </h3>
            <span class="rounded-full border border-pine-highlight bg-pine-overlay px-2.5 py-0.5 text-xs font-bold tracking-wider whitespace-nowrap text-pine-subtle uppercase">
              {tasks.length} {tasks.length === 1 ? 'Template' : 'Templates'}
            </span>
          </div>
          <p class="text-xs text-pine-subtle">
            Recurring prompt templates automatically dispatched before pool reset windows to burn
            expiring quota without overages.
          </p>
        </div>

        <button
          type="button"
          onClick={() => setShowCreate(!showCreate)}
          class="flex cursor-pointer items-center gap-1.5 rounded-lg border border-pine-rose/40 bg-pine-rose/15 px-3.5 py-2 text-xs font-semibold whitespace-nowrap text-pine-rose transition-colors hover:bg-pine-rose hover:text-pine-base sm:text-sm"
        >
          <Icon icon={showCreate ? faMinus : faPlus} class="size-3" />
          <span>{showCreate ? 'Close Form' : 'New Standing Task'}</span>
        </button>
      </div>

      {statusMessage && (
        <div class="mt-4 rounded-lg border border-pine-highlight bg-pine-overlay/60 px-4 py-2.5 text-xs font-medium text-pine-text">
          {statusMessage}
        </div>
      )}

      {showCreate && (
        <form
          onSubmit={handleCreate}
          class="mt-5 rounded-lg border border-pine-highlight bg-pine-base/50 p-4"
        >
          <h4 class="mb-3 text-sm font-semibold text-pine-text">New Standing Task Template</h4>
          <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div class="sm:col-span-2">
              <label class="mb-1 block text-xs font-medium text-pine-subtle">Title</label>
              <input
                type="text"
                required
                value={title}
                onInput={(e) => setTitle((e.target as HTMLInputElement).value)}
                placeholder="e.g. Claude Weekly Audit & Bug Hunt"
                class="w-full rounded-md border border-pine-highlight bg-pine-surface px-3 py-1.5 text-xs text-pine-text focus:border-pine-iris focus:outline-none"
              />
            </div>

            <div class="sm:col-span-2">
              <label class="mb-1 block text-xs font-medium text-pine-subtle">Task Prompt</label>
              <textarea
                required
                rows={3}
                value={prompt}
                onInput={(e) => setPrompt((e.target as HTMLTextAreaElement).value)}
                placeholder="Exhaustively audit recent commits, run lint and tests, identify latent defects, and submit PR or issue."
                class="w-full rounded-md border border-pine-highlight bg-pine-surface px-3 py-1.5 text-xs text-pine-text focus:border-pine-iris focus:outline-none"
              />
            </div>

            <div>
              <label class="mb-1 block text-xs font-medium text-pine-subtle">
                Target Repository
              </label>
              <select
                value={repositoryId}
                onChange={(e) => setRepositoryId((e.target as HTMLSelectElement).value)}
                class="w-full rounded-md border border-pine-highlight bg-pine-surface px-3 py-1.5 text-xs text-pine-text focus:border-pine-iris focus:outline-none"
              >
                {repos.map((r: RepositoryConfig) => (
                  <option key={r.id} value={r.id}>
                    {r.name || r.id}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label class="mb-1 block text-xs font-medium text-pine-subtle">Model</label>
              <select
                value={model}
                onChange={(e) => setModel((e.target as HTMLSelectElement).value)}
                class="w-full rounded-md border border-pine-highlight bg-pine-surface px-3 py-1.5 text-xs text-pine-text focus:border-pine-iris focus:outline-none"
              >
                {modelOptions.map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.label}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label class="mb-1 block text-xs font-medium text-pine-subtle">
                Reasoning Effort
              </label>
              <select
                value={effort}
                onChange={(e) =>
                  setEffort((e.target as HTMLSelectElement).value as ReasoningEffort)
                }
                class="w-full rounded-md border border-pine-highlight bg-pine-surface px-3 py-1.5 text-xs text-pine-text focus:border-pine-iris focus:outline-none"
              >
                {EFFORT_OPTIONS.filter((o) =>
                  resolveModelEffort(catalog.models, model).supported.includes(o.value)
                ).map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label class="mb-1 block text-xs font-medium text-pine-subtle">
                Trigger Before Reset (Hours)
              </label>
              <input
                type="number"
                min="1"
                max="168"
                value={triggerHours}
                onInput={(e) => setTriggerHours(Number((e.target as HTMLInputElement).value))}
                class="w-full rounded-md border border-pine-highlight bg-pine-surface px-3 py-1.5 text-xs text-pine-text focus:border-pine-iris focus:outline-none"
              />
            </div>

            <div class="sm:col-span-2">
              <label class="mb-1 block text-xs font-medium text-pine-subtle">
                Optional Verify Command
              </label>
              <input
                type="text"
                value={verifyCommand}
                onInput={(e) => setVerifyCommand((e.target as HTMLInputElement).value)}
                placeholder="e.g. npm test"
                class="w-full rounded-md border border-pine-highlight bg-pine-surface px-3 py-1.5 text-xs text-pine-text focus:border-pine-iris focus:outline-none"
              />
            </div>
          </div>

          <div class="mt-4 flex items-center justify-between">
            <label class="flex items-center gap-2 text-xs text-pine-subtle">
              <input
                type="checkbox"
                checked={autoCreatePr}
                onChange={(e) => setAutoCreatePr((e.target as HTMLInputElement).checked)}
                class="rounded-sm border-pine-highlight text-pine-iris"
              />
              <span>Auto-create pull request if code changes are produced</span>
            </label>

            <button
              type="submit"
              disabled={isSubmitting}
              class="rounded-lg bg-pine-rose px-4 py-1.5 text-xs font-semibold text-pine-base transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {isSubmitting ? 'Saving...' : 'Create Standing Task'}
            </button>
          </div>
        </form>
      )}

      {loading ? (
        <div class="py-6 text-center text-xs text-pine-subtle">Loading standing tasks...</div>
      ) : tasks.length === 0 ? (
        <div class="mt-4 rounded-lg border border-pine-highlight bg-pine-overlay/30 p-6 text-center">
          <p class="text-xs text-pine-subtle">No standing tasks configured yet.</p>
          <p class="mt-1 text-xs text-pine-muted">
            Create a standing task template to automatically burn expiring quota when the pool
            reaches its pre-reset window.
          </p>
        </div>
      ) : (
        <div class="mt-4 flex flex-col gap-3">
          {tasks.map((t) => (
            <div
              key={t.id}
              class="flex flex-col gap-2 rounded-lg border border-pine-highlight bg-pine-base/40 p-4 transition-colors hover:border-pine-subtle/40"
            >
              <div class="flex flex-wrap items-center justify-between gap-2">
                <div class="flex min-w-0 flex-1 flex-wrap items-center gap-2">
                  <span class="text-sm font-semibold wrap-break-word text-pine-text">
                    {t.title}
                  </span>
                  <span class="rounded-full border border-pine-highlight bg-pine-surface px-2 py-0.5 font-mono text-xs whitespace-nowrap text-pine-subtle">
                    {t.repositoryId}
                  </span>
                  <span class="rounded-full border border-pine-iris/30 bg-pine-iris/10 px-2 py-0.5 text-xs whitespace-nowrap text-pine-iris">
                    {t.models?.join(', ') || (t as any).model || 'model'} ({t.effort})
                  </span>
                  <span class="rounded-full border border-pine-foam/30 bg-pine-foam/10 px-2 py-0.5 text-xs whitespace-nowrap text-pine-foam">
                    &le; {t.triggerBeforeResetHours}h before reset
                  </span>
                </div>

                <div class="flex items-center gap-2">
                  <ToggleSwitch
                    checked={t.enabled}
                    label={`Enable ${t.title}`}
                    disabled={actionId === t.id}
                    onChange={() => handleToggleEnabled(t)}
                  />
                  <button
                    type="button"
                    title="Trigger Now"
                    disabled={actionId === t.id}
                    onClick={() => handleTriggerNow(t)}
                    class="cursor-pointer rounded-sm border border-pine-pine/30 bg-pine-pine/10 p-1.5 text-pine-foam transition-colors hover:bg-pine-pine hover:text-white disabled:opacity-50"
                  >
                    <Icon icon={faPlay} class="size-3" />
                  </button>
                  <button
                    type="button"
                    title="Delete Standing Task"
                    disabled={actionId === t.id}
                    onClick={() => handleDelete(t.id)}
                    class="cursor-pointer rounded-sm border border-pine-love/30 bg-pine-love/10 p-1.5 text-pine-love transition-colors hover:bg-pine-love hover:text-white disabled:opacity-50"
                  >
                    <Icon icon={faTrash} class="size-3" />
                  </button>
                </div>
              </div>

              <div class="text-xs wrap-break-word text-pine-subtle">
                <span class="text-pine-muted">Prompt: </span>
                {t.prompt}
              </div>

              <div class="flex flex-wrap items-center gap-4 font-mono text-xs text-pine-muted">
                {t.lastTriggeredResetTime ? (
                  <span>
                    Last burned cycle:{' '}
                    <span class="text-pine-text">{t.lastTriggeredResetTime}</span>
                  </span>
                ) : (
                  <span>Last burned cycle: never</span>
                )}
                {t.lastTaskId && (
                  <span>
                    Last Task ID: <span class="text-pine-iris">{t.lastTaskId}</span>
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
