import { Link } from 'preact-router/match';

export const NotFoundView = () => (
  <div class="flex min-h-[50vh] flex-col items-center justify-center gap-2 text-center">
    <h2 class="text-lg font-semibold text-pine-text">Not Found</h2>
    <p class="text-sm text-pine-subtle">That page does not exist.</p>
    <Link
      href="/"
      class="mt-1 inline-flex min-h-11 items-center rounded-lg border border-pine-highlight bg-pine-overlay px-3 py-2 text-sm text-pine-text transition-colors hover:bg-pine-highlight"
    >
      Back to overview
    </Link>
  </div>
);
