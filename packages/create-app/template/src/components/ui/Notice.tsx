import type { ReactNode } from "react";
import { cx } from "./cx";

export type NoticeTone = "info" | "warn" | "danger";

/**
 * A rule down the left edge, no fill.
 *
 * Filled banners are the thing people learn to scroll past. These carry the
 * three messages this app actually needs to survive — "the database is not
 * configured", "the server refused that change", "these rows reference
 * permissions that no longer exist" — and each one is load-bearing.
 */
const TONES: Record<NoticeTone, string> = {
  info: "border-accent",
  warn: "border-warn",
  danger: "border-danger",
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
    <div role={role} className={cx("border-l-2 py-1 pl-3", TONES[tone])}>
      {title && <p className="text-sm font-medium text-ink">{title}</p>}
      <div className="max-w-[62ch] text-sm text-ink-muted">{children}</div>
    </div>
  );
}
