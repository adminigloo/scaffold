/**
 * Join class names, dropping anything falsy.
 *
 * Not `clsx`, not `tailwind-merge`. A dependency for eleven lines is a
 * dependency to audit, and merge semantics would let a caller silently defeat a
 * primitive's own colour token — which is the one thing the theme must not
 * allow. Later classes win by CSS order, same as plain HTML; if a caller needs a
 * different background they should be reaching for a different variant.
 */
export function cx(...parts: readonly (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}
