interface ModelCascadeFieldProps {
  /** Raw comma-separated text; every form keeps the chain in one controlled string. */
  value: string;
  onChange: (next: string) => void;
  label?: string;
  placeholder?: string;
}

/** Splits the cascade into the ordered list the API stores, dropping empty entries. */
export const parseModelCascade = (raw: string): string[] =>
  raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);

/** `primaryModel (+N)` — the chain's first hop plus how many fallbacks follow it. */
export const modelChainLabel = (models: string[]): string => {
  const primary = models[0] || 'no model';
  const extra = models.length - 1;
  return extra > 0 ? `${primary} (+${extra})` : primary;
};

/**
 * Ordered model cascade shared by the routine and backlog forms. Dispatch walks the list until a
 * pool clears its floor, so the order is the whole point — the preview spells it out.
 */
export const ModelCascadeField = ({
  value,
  onChange,
  label = 'Model Preference Chain',
  placeholder = 'gemini-3.8-flash, claude-sonnet-5-5',
}: ModelCascadeFieldProps) => {
  const chain = parseModelCascade(value);

  return (
    <div>
      <label class="mb-1 block font-medium text-pine-subtle">
        <span>{label}</span>
        <span class="ml-1 font-normal text-pine-muted">(comma-separated, evaluated in order)</span>
      </label>
      <input
        type="text"
        required
        value={value}
        onInput={(e) => onChange((e.target as HTMLInputElement).value)}
        placeholder={placeholder}
        class="w-full rounded-lg border border-pine-highlight bg-pine-overlay px-3 py-2 font-mono text-pine-text focus:border-pine-iris focus:outline-hidden"
      />
      {chain.length > 1 && (
        <div class="mt-1.5 flex flex-wrap items-center gap-1 font-mono text-xs text-pine-subtle">
          {chain.map((model, index) => (
            <span key={`${model}-${index}`} class="flex items-center gap-1">
              {index > 0 && (
                <span aria-hidden="true" class="text-pine-muted">
                  &rarr;
                </span>
              )}
              <span class="rounded-sm bg-pine-overlay px-1.5 py-0.5 whitespace-nowrap text-pine-iris">
                {model}
              </span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
};
