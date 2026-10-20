import type { ReactNode } from "react";

/**
 * An empty list is a sales page, and "No data" sells nothing.
 *
 * On a freshly made company almost every list is empty, so this is the first
 * thing a new owner reads on every screen. Three parts, in this order:
 * `title` says what the list holds ("No invoices yet"), `children` says what
 * the screen does once it's in use — one or two plain sentences, the outcome,
 * not the mechanics — and `action` is the one thing that puts the first row
 * here. No illustration and no stock art: the words carry it.
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
    <div className="rounded-[--radius-card] border border-line bg-surface px-6 py-12 text-center shadow-card">
      <p className="text-base font-semibold text-ink">{title}</p>
      <div className="mx-auto mt-2 max-w-[58ch] text-sm leading-relaxed text-ink-muted">{children}</div>
      {action && <div className="mt-5 flex flex-wrap justify-center gap-2">{action}</div>}
    </div>
  );
}
