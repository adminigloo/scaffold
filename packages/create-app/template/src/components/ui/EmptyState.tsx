import type { ReactNode } from "react";

/**
 * An empty table is a question, and "No data" answers none of it.
 *
 * The two things a reader needs are what WOULD be here and what puts it here.
 * On a freshly generated project almost every list is empty, so these strings
 * are the first documentation anybody reads — `title` says what the list holds,
 * `children` says the concrete step that produces a row.
 */
export function EmptyState({
  title,
  children,
  action,
}: {
  readonly title: string;
  readonly children: ReactNode;
  readonly action?: ReactNode;
}) {
  return (
    <div className="rounded-[--radius-card] border border-dashed border-line px-4 py-8 text-center">
      <p className="text-sm font-medium text-ink">{title}</p>
      <div className="mx-auto mt-1 max-w-[58ch] text-sm text-ink-muted">{children}</div>
      {action && <div className="mt-3 flex justify-center">{action}</div>}
    </div>
  );
}
