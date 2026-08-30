import type { ComponentProps } from "react";
import { cx } from "./cx";

export type ButtonVariant = "primary" | "secondary" | "danger";

const BASE =
  "inline-flex items-center justify-center gap-1.5 rounded-[--radius-card] " +
  "px-3 py-1.5 text-sm font-medium no-underline transition-colors " +
  "disabled:pointer-events-none disabled:opacity-50";

/**
 * `text-surface`, NOT `text-white`.
 *
 * Surface is #ffffff in the light theme, so the filled button looks exactly as
 * specified. In the dark theme the accent is lightened for link legibility and
 * white on it measures 2.9:1 — below AA for a 14px label. Surface is near black
 * there, and the same markup reads at 6:1. One spelling, both themes.
 *
 * Destructive is outlined rather than filled for the same reason plus one more:
 * a solid red button next to a solid teal one reads as equally routine, and
 * "delete" should cost a beat of hesitation.
 */
const VARIANTS: Record<ButtonVariant, string> = {
  primary: "bg-accent text-surface hover:opacity-90",
  secondary: "border border-line bg-surface text-ink hover:bg-canvas",
  danger:
    "border border-danger bg-surface text-danger hover:bg-danger hover:text-surface",
};

/** For anchors and anything else that must look like a button but is not one. */
export function buttonClass(variant: ButtonVariant = "secondary", extra?: string): string {
  return cx(BASE, VARIANTS[variant], extra);
}

export interface ButtonProps extends ComponentProps<"button"> {
  readonly variant?: ButtonVariant;
}

export function Button({ variant = "secondary", className, type, ...rest }: ButtonProps) {
  // Default to "button". An unspecified <button> inside a <form> submits it,
  // which turns a filter toggle into a page reload that discards state.
  return <button type={type ?? "button"} className={buttonClass(variant, className)} {...rest} />;
}
