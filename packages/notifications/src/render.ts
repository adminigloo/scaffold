import { breakLinks } from "./links.js";
import { alertLinkLine, alertSettingsLine, TEAM_ALERT_EMAIL_TEMPLATE } from "./template.js";
import type { AlertEmailMessage } from "./types.js";

/**
 * The team alert email for a host WITHOUT comms (Tenancy 2b-1, 4.9; reviews
 * G12, BO-17): Ridgeline sends through nodemailer, and the obvious host code
 * (`html: \`<p>${m.body}</p>\``) would put what a customer typed into a staff
 * email as markup. This renders the same email comms would, in
 * TEAM_ALERT_EMAIL_TEMPLATE's exact words, safely:
 *
 *   - every value is HTML-escaped in `html` BEFORE any structure is added
 *     (comms' html.ts order: escape first, then paragraphs);
 *   - `breakLinks` is applied to the title and body (again: harmless twice);
 *   - CR, LF, U+2028 and U+2029 are stripped from `subject` (a header);
 *   - a line that is only a variable folds away when empty;
 *   - the only links are the two the host built (`link`, `settingsLink`),
 *     and only when they are http(s) URLs.
 */

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch] ?? ch);
}

/** `{{name}}` from own properties only (comms' render rule): an unknown placeholder renders empty. */
function fill(template: string, vars: Readonly<Record<string, string>>): string {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_match, key: string) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? (vars[key] ?? "") : "",
  );
}

/** Blank-line-separated paragraphs, empty ones dropped: the folding rule. */
function paragraphs(text: string): string[] {
  return text
    .replace(/\r\n?/g, "\n")
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
}

function isHttpUrl(value: string | null | undefined): value is string {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

/** WRAPPED, so a long link breaks across lines on a phone (comms' link style; inline, since mail clients drop <style>). */
const LINK_STYLE = "word-break:break-all";

function anchor(url: string): string {
  const escaped = escapeHtml(url);
  return `<a href="${escaped}" style="${LINK_STYLE}">${escaped}</a>`;
}

/**
 * The team alert email, in TEAM_ALERT_EMAIL_TEMPLATE's exact words. Every
 * value is HTML-escaped in `html`; `breakLinks` is applied to the title and
 * body (again: harmless twice); CR, LF, U+2028 and U+2029 are stripped from
 * `subject`; empty lines fold away. `link` and `settingsLink` are absolute
 * URLs the host built (null: that line is left out). For an `addressOnly`
 * message `settingsLink` is ignored and the settings line reads "You get this
 * because {businessName} added this address."
 */
export function renderAlertEmail(
  message: AlertEmailMessage,
  options: { readonly businessName: string; readonly link: string | null; readonly settingsLink: string | null },
): { readonly subject: string; readonly text: string; readonly html: string } {
  const businessName = (options.businessName ?? "").replace(/[\r\n\u2028\u2029]+/g, " ").trim();
  const title = breakLinks(message.title ?? "");
  const body = breakLinks(message.body ?? "");
  const link = isHttpUrl(options.link) ? options.link : null;
  const settingsLink = !message.addressOnly && isHttpUrl(options.settingsLink) ? options.settingsLink : null;
  const vars = {
    title,
    body,
    linkLine: alertLinkLine(link),
    settingsLine: alertSettingsLine({ addressOnly: message.addressOnly, businessName, settingsLink }),
    businessName,
  };

  const subject = fill(TEAM_ALERT_EMAIL_TEMPLATE.subject, vars)
    .replace(/[\r\n\u2028\u2029]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
  const text = paragraphs(fill(TEAM_ALERT_EMAIL_TEMPLATE.body, vars)).join("\n\n");

  // The HTML is built from the same template, one placeholder at a time, so
  // its words are the text's words: each value escaped on its own, the two
  // host links the only anchors.
  const htmlVars: Record<string, string> = {
    title: escapeHtml(title),
    body: paragraphs(body)
      .map((paragraph) => escapeHtml(paragraph).replace(/\n/g, "<br>"))
      .join("\n\n"),
    linkLine: link ? `${escapeHtml("Open it: ")}${anchor(link)}` : "",
    settingsLine: message.addressOnly
      ? escapeHtml(vars.settingsLine)
      : settingsLink
        ? `${escapeHtml("Change which alerts you get by email: ")}${anchor(settingsLink)}`
        : "",
    businessName: escapeHtml(businessName),
  };
  const html = paragraphs(fill(TEAM_ALERT_EMAIL_TEMPLATE.body, htmlVars))
    .map((paragraph) => `<p>${paragraph.replace(/\n/g, "<br>")}</p>`)
    .join("\n");
  return { subject, text, html };
}
