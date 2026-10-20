import type { ReactNode } from "react";

/**
 * The top of every page: a title, one line saying what this is, and the
 * page's primary action on the right. Never a hero — this is a working tool,
 * and vertical space spent on decoration is a row of data somebody has to
 * scroll for. On a phone the action drops under the title.
 */
export function PageHeader({
  title,
  description,
  actions,
}: {
  readonly title: ReactNode;
  readonly description?: ReactNode;
  readonly actions?: ReactNode;
}) {
  return (
    <header className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold tracking-tight text-ink">{title}</h1>
        {description && <p className="mt-1 max-w-[68ch] text-sm leading-relaxed text-ink-muted">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}
