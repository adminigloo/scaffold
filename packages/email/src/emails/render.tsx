import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";

/**
 * Turning a React Email component into the two bodies a message needs.
 *
 * WHY REACT EMAIL AND NOT A TEMPLATE STRING. An email body is a whole HTML
 * document assembled from customer-typed values, and the hand-rolled version of
 * this file was a template literal with an `escapeHtml` helper applied at every
 * interpolation. That works exactly as long as nobody forgets one, and the
 * consequence of forgetting one is stored HTML injection carried by a message
 * sent from our own authenticated domain — the highest-trust delivery path the
 * product has. React escapes children and attribute values by construction, so
 * the failure mode stops being a discipline and starts being impossible. The
 * components underneath also carry the table scaffolding and MSO conditionals
 * that make a layout survive Outlook, which is the other half of what this
 * would otherwise be maintaining by hand.
 *
 * WHY `renderToStaticMarkup` AND NOT `@react-email/render`. That package's
 * `render` returns a PROMISE — it runs Prettier over the output and can convert
 * to plain text through html-to-text. Neither is wanted here. Rendering has to
 * stay synchronous because the call site composes a message inside a function
 * whose signature is fixed, and an async body would ripple into every caller
 * for the benefit of pretty-printed HTML that no inbox reads. `renderToStaticMarkup`
 * is what react-email builds on in any case; taking it directly costs one
 * dependency less and one await less.
 *
 * PLAIN TEXT IS WRITTEN BY HAND, per template, and is not derived from the
 * markup. A message with no text part scores as spam at most providers, so the
 * text is not a courtesy — it is the difference between the invitation arriving
 * and the invitation never being seen. Machine-converted text from a
 * table-based layout reads like a machine converted a table, which is exactly
 * the impression a transactional mail cannot afford; and the URL has to appear
 * in full in both parts, because a link whose text and target differ is the
 * strongest phishing signal a filter looks for.
 */

/** One message, ready to hand to a transport. */
export interface RenderedEmail {
  readonly subject: string;
  readonly html: string;
  readonly text: string;
}

/**
 * A React Email document as a complete HTML string.
 *
 * The doctype is prepended rather than rendered, because React will not emit
 * one. Without it Outlook and several webmail clients fall into quirks mode,
 * where the table widths that hold the layout together are interpreted
 * differently — the symptom is a message that looks correct everywhere the
 * author tested and 800 pixels wide in the one client the recipient uses.
 */
export function renderEmailHtml(element: ReactElement): string {
  return `<!DOCTYPE html>${renderToStaticMarkup(element)}`;
}

/**
 * "an Admin", "a Member".
 *
 * Wrong for a word starting with a silent consonant, right for every role this
 * scaffold ships, and cheaper than a dependency.
 */
export function articleFor(word: string): string {
  const first = word.trim().charAt(0).toLowerCase();
  return "aeiou".includes(first) ? "an" : "a";
}

/**
 * `12 March 2026`, in UTC.
 *
 * UTC and not the server's zone: the value is being read off a `timestamptz`
 * and shown to somebody who may be anywhere, and a date that disagrees with the
 * row it came from is worse than one that is a few hours out for the reader.
 */
export function formatEmailDate(value: Date): string {
  return value.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}
