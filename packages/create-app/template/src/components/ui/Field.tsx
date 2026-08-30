import type { ComponentProps, ReactNode } from "react";
import { cx } from "./cx";

/**
 * One control shape, shared by input, select and textarea.
 *
 * `bg-surface` rather than a transparent fill: a transparent control on a
 * transparent card inherits the browser's own field colour in dark mode, which
 * is the single most common way a themed form ends up with one white box in it.
 */
const CONTROL =
  "w-full rounded-[--radius-card] border border-line bg-surface px-2.5 py-1.5 " +
  "text-sm text-ink placeholder:text-ink-muted disabled:opacity-60";

export function Input({ className, ...rest }: ComponentProps<"input">) {
  return <input className={cx(CONTROL, className)} {...rest} />;
}

export function Select({ className, ...rest }: ComponentProps<"select">) {
  return <select className={cx(CONTROL, "pr-8", className)} {...rest} />;
}

export function Textarea({ className, ...rest }: ComponentProps<"textarea">) {
  return <textarea className={cx(CONTROL, "min-h-20 resize-y", className)} {...rest} />;
}

/**
 * Label, control, hint — and the label is a real <label htmlFor>, not a styled
 * span. A placeholder is not a label: it disappears the moment anyone types,
 * and a screen reader announces the field as unnamed.
 */
export function Field({
  label,
  htmlFor,
  hint,
  error,
  children,
}: {
  readonly label: ReactNode;
  readonly htmlFor: string;
  readonly hint?: ReactNode;
  readonly error?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={htmlFor} className="text-sm font-medium text-ink">
        {label}
      </label>
      {children}
      {hint && !error && <p className="text-xs text-ink-muted">{hint}</p>}
      {error && (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
