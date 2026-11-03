export const NotFoundView = () => (
  <div class="flex min-h-[50vh] flex-col items-center justify-center gap-2 text-center">
    <h2 class="text-lg font-semibold text-pine-text">Not Found</h2>
    <p class="text-sm text-pine-muted">That page does not exist.</p>
    <a
      href="/overview"
      class="mt-1 rounded-lg border border-pine-highlight px-3 py-1.5 text-sm text-pine-subtle transition-colors hover:bg-pine-overlay hover:text-pine-text"
    >
      Back to overview
    </a>
  </div>
);
