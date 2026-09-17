import type { ReactNode } from "react";
import { cx } from "./cx";

export type NoticeTone = "info" | "warn" | "danger";

/**
 * A rule down the left edge over the quietest possible tint.
 *
 * Saturated banners are the thing people learn to scroll past. These carry the
 * three messages this app actually needs to survive — "the database is not
 * configured", "the server refused that change", "these rows reference
 * permissions that no longer exist" — and each one is load-bearing. The soft
 * fill gives the message a body without giving it a megaphone; the rule is
 * still what says which kind of message it is.
 */
const TONES: Record<NoticeTone, string> = {
  info: "border-accent bg-accent-soft/50",
  warn: "border-warn bg-warn-soft/60",
  danger: "border-danger bg-danger-soft/60",
};

export function Notice({
  tone = "info",
  title,
  children,
  role,
}: {
  readonly tone?: NoticeTone;
  readonly title?: ReactNode;
  readonly children: ReactNode;
  /** Pass "alert" when this appeared in response to something the user did. */
  readonly role?: "alert" | "status";
}) {
  return (
    <div
      role={role}
      className={cx("rounded-r-[--radius-card] border-l-2 py-2 pr-3 pl-3", TONES[tone])}
    >
      {title && <p className="text-sm font-medium text-ink">{title}</p>}
      <div className="max-w-[62ch] text-sm text-ink-muted">{children}</div>
    </div>
  );
}
