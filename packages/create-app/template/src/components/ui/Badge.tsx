import type { ComponentProps } from "react";
import { cx } from "./cx";

export type BadgeTone = "neutral" | "accent" | "ok" | "danger" | "warn";

/**
 * A soft tint carrying its full-strength colour as text — never soft-on-soft,
 * which is how a status chip becomes unreadable on a cheap monitor, and never
 * a saturated fill, which is how a dense table starts looking like a dashboard
 * mock instead of something you can read at a glance. The tint is quiet enough
 * that the row's own state colour still wins.
 */
const TONES: Record<BadgeTone, string> = {
  neutral: "bg-canvas text-ink-muted border-line",
  accent: "bg-accent-soft text-accent border-transparent",
  ok: "bg-ok-soft text-ok border-transparent",
  danger: "bg-danger-soft text-danger border-transparent",
  warn: "bg-warn-soft text-warn border-transparent",
};

export interface BadgeProps extends ComponentProps<"span"> {
  readonly tone?: BadgeTone;
}

export function Badge({ tone = "neutral", className, ...rest }: BadgeProps) {
  return (
    <span
      className={cx(
        "inline-flex items-center rounded-pill border px-2 py-0.5",
        "text-[10px] font-semibold uppercase tracking-wider whitespace-nowrap",
        TONES[tone],
        className,
      )}
      {...rest}
    />
  );
}
