interface ConsoleChannelFormProps {
  onSendTest: () => void;
  isTesting: boolean;
}

export const ConsoleChannelForm = ({ onSendTest, isTesting }: ConsoleChannelFormProps) => {
  return (
    <div class="flex flex-col gap-4">
      <div class="flex items-center justify-between border-b border-pine-highlight pb-3">
        <span class="text-xs font-semibold text-pine-subtle">Console Output Stream</span>
        <button
          type="button"
          onClick={onSendTest}
          disabled={isTesting}
          class="cursor-pointer rounded-lg border border-pine-highlight bg-pine-overlay px-3 py-1.5 text-xs font-medium text-pine-subtle transition-colors hover:text-pine-text disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isTesting ? 'Testing...' : 'Test Console Output'}
        </button>
      </div>
      <p class="text-xs/relaxed text-pine-muted">
        Milestone warnings and quota alerts are formatted into clean ASCII boxes and emitted
        directly to standard output, which streams live into the{' '}
        <strong class="font-medium text-pine-text">Logs</strong> tab.
      </p>
    </div>
  );
};
