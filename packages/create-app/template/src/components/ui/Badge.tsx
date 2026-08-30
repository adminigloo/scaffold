import type { ComponentProps } from "react";
import { cx } from "./cx";

export type BadgeTone = "neutral" | "accent" | "danger" | "warn";

/**
 * Outlined, not filled. A row already carries one background; a second filled
 * block inside it competes with the row's own state colour, and the two
 * together are what makes a dense table look like a dashboard mock rather than
 * something you can read at a glance.
 */
const TONES: Record<BadgeTone, string> = {
  neutral: "border-line text-ink-muted",
  accent: "border-accent text-accent",
  danger: "border-danger text-danger",
  warn: "border-warn text-warn",
};

export interface BadgeProps extends ComponentProps<"span"> {
  readonly tone?: BadgeTone;
}

export function Badge({ tone = "neutral", className, ...rest }: BadgeProps) {
  return (
    <span
      className={cx(
        "inline-flex items-center rounded-[3px] border px-1.5 py-px",
        "text-[10px] font-medium uppercase tracking-wider whitespace-nowrap",
        TONES[tone],
        className,
      )}
      {...rest}
    />
  );
}
