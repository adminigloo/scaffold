/**
 * HTML a section writes, escaped by construction (digest 0.1).
 *
 * A section's words come from the project's own data — a city's name, a
 * product a person saved, a message somebody typed — and they land in an
 * email sent from the site's own verified domain, the highest-trust place
 * the product writes. So the `html` tag escapes every value it is given:
 *
 *   html`<p>${city.name} settled at <strong>${high}°</strong></p>`
 *
 * and only markup made by `html` itself (or `raw`, said out loud) passes
 * through unescaped. A section's `html` must be one of these, so a plain
 * string — the version that is correct until somebody forgets one escape —
 * does not typecheck.
 */

/** What marks markup the `html` tag made (Symbol.for, so a second copy of this package recognises it). */
export const SAFE_HTML: unique symbol = Symbol.for("adminigloo.digest.safeHtml");

export interface SafeHtml {
  readonly [SAFE_HTML]: true;
  /** The markup. */
  readonly html: string;
  toString(): string;
}

function safe(markup: string): SafeHtml {
  return Object.freeze({ [SAFE_HTML]: true as const, html: markup, toString: () => markup });
}

export function isSafeHtml(value: unknown): value is SafeHtml {
  return typeof value === "object" && value !== null && (value as { [SAFE_HTML]?: unknown })[SAFE_HTML] === true;
}

/** `&`, `<`, `>`, `"` and `'` as entities: safe in text and in a quoted attribute. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function piece(value: unknown): string {
  if (value === null || value === undefined || value === false) return "";
  if (isSafeHtml(value)) return value.html;
  if (Array.isArray(value)) return value.map(piece).join("");
  return escapeHtml(String(value));
}

/** The tag: every interpolated value escaped, `html`/`raw` values and arrays of them kept. */
export function html(strings: TemplateStringsArray, ...values: readonly unknown[]): SafeHtml {
  let out = strings[0] ?? "";
  for (let i = 0; i < values.length; i += 1) out += piece(values[i]) + (strings[i + 1] ?? "");
  return safe(out);
}

/** Markup you vouch for, unescaped. For a fragment that was already escaped elsewhere. */
export function raw(markup: string): SafeHtml {
  return safe(String(markup));
}
