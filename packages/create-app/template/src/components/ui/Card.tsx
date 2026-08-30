import type { ComponentProps, ReactNode } from "react";
import { cx } from "./cx";

/**
 * The one container shape in the product.
 *
 * No padding of its own: a card wrapping a table must let the table's own cell
 * padding reach the edge, and a card that pads unconditionally forces every
 * table to undo it with a negative margin. Wrap prose in <CardBody>.
 */
export function Card({ className, ...rest }: ComponentProps<"div">) {
  return (
    <div
      className={cx(
        "bg-surface border border-line rounded-[--radius-card] overflow-hidden",
        className,
      )}
      {...rest}
    />
  );
}

export function CardBody({ className, ...rest }: ComponentProps<"div">) {
  return <div className={cx("p-4", className)} {...rest} />;
}

/** A titled strip at the top of a card. Separated by a line, never by a fill. */
export function CardHeader({
  title,
  hint,
  actions,
  className,
}: {
  readonly title: string;
  readonly hint?: string;
  readonly actions?: ReactNode;
  readonly className?: string;
}) {
  return (
    <div
      className={cx(
        "flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3",
        className,
      )}
    >
      <div className="min-w-0">
        <h2 className="text-sm font-semibold tracking-tight">{title}</h2>
        {hint && <p className="mt-0.5 text-xs text-ink-muted">{hint}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}
