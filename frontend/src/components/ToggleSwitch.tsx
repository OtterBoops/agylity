interface ToggleSwitchProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  /** Accessible name; also used as the tooltip. */
  label: string;
  size?: 'sm' | 'md';
  disabled?: boolean;
  /** Track colour when on; callers differ (iris for settings, pine for dispatch). */
  activeClass?: string;
}

const TRACK = { sm: 'h-5 w-9', md: 'h-6 w-11' } as const;
const THUMB = { sm: 'size-4', md: 'size-5' } as const;
const SHIFT = { sm: 'translate-x-4', md: 'translate-x-5' } as const;

export const ToggleSwitch = ({
  checked,
  onChange,
  label,
  size = 'md',
  disabled = false,
  activeClass = 'bg-pine-iris',
}: ToggleSwitchProps) => (
  <button
    type="button"
    role="switch"
    aria-checked={checked}
    aria-label={label}
    title={label}
    disabled={disabled}
    onClick={() => onChange(!checked)}
    class={`relative inline-flex ${TRACK[size]} shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out before:absolute before:-inset-2.5 before:content-[''] focus:outline-hidden focus-visible:ring-2 focus-visible:ring-pine-iris focus-visible:ring-offset-2 focus-visible:ring-offset-pine-base disabled:opacity-50 ${
      checked ? activeClass : 'border-pine-highlight bg-pine-overlay'
    }`}
  >
    <span
      aria-hidden="true"
      class={`pointer-events-none inline-block ${THUMB[size]} transform rounded-full bg-pine-text shadow-xs ring-0 transition duration-200 ease-in-out ${
        checked ? SHIFT[size] : 'translate-x-0'
      }`}
    />
  </button>
);
