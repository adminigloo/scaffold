import { escapeHtml, html, raw, type SafeHtml } from "./html.js";
import type { DigestRecipient, DigestSectionContent, DigestSpec, EmailKind } from "./registry.js";
import type { DigestDay } from "./time.js";

/**
 * The email around the sections (digest 0.1): a heading, each section under
 * its own title, and a footer that says why it came and how to stop it —
 * the preferences link (signed in) and this email's own unsubscribe link
 * (no sign-in). Tables and inline styles, the shape every inbox renders;
 * one colour, the site's accent. The plain-text part is written alongside,
 * never derived: a message with no text part scores as spam.
 */

export interface EmailLinks {
  /** The person's preferences page (they sign in to it). */
  readonly preferences: string;
  /** This email kind's own unsubscribe page, signed (no sign-in). */
  readonly unsubscribe: string;
}

export interface RenderedEmail {
  readonly subject: string;
  readonly html: string;
  readonly text: string;
}

export interface EmailTheme {
  /** Links and the heading rule. Default "#0f766e". */
  readonly accent?: string;
}

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

function color(value: string | undefined, fallback: string): string {
  return value && /^#[0-9a-f]{3,8}$/i.test(value) ? value : fallback;
}

function oneLine(value: string): string {
  return value.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
}

function footer(siteName: string, kind: EmailKind, links: EmailLinks, accent: string): { html: SafeHtml; text: string } {
  const why =
    kind.type === "digest"
      ? `You're getting this because you chose the ${kind.title} from ${siteName}.`
      : `You're getting this because you chose ${kind.title} from ${siteName}.`;
  return {
    html: html`<tr><td style="padding:20px 28px 28px;border-top:1px solid #e3e8ec;font:13px/1.5 ${raw(FONT)};color:#55636f">
<p style="margin:0 0 8px">${why}</p>
<p style="margin:0"><a href="${links.preferences}" style="color:${raw(accent)}">Email preferences</a> &middot; <a href="${links.unsubscribe}" style="color:${raw(accent)}">Unsubscribe from ${kind.type === "digest" ? `the ${kind.title}` : kind.title}</a></p>
</td></tr>`,
    text: `--\n${why}\nEmail preferences: ${links.preferences}\nUnsubscribe from ${kind.type === "digest" ? `the ${kind.title}` : kind.title}: ${links.unsubscribe}\n`,
  };
}

function frame(body: SafeHtml): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head><body style="margin:0;padding:0;background:#f5f7f9">${
    html`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f7f9"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;background:#ffffff;border:1px solid #e3e8ec;border-radius:12px">
${body}
</table></td></tr></table>`.html
  }</body></html>`;
}

export interface RenderDigestInput {
  readonly siteName: string;
  readonly digest: DigestSpec;
  readonly kind: EmailKind;
  readonly person: DigestRecipient;
  readonly day: DigestDay;
  readonly sections: readonly DigestSectionContent[];
  readonly links: EmailLinks;
  readonly theme?: EmailTheme;
}

/** A day's digest: the subject, the HTML and the text. */
export function renderDigestEmail(input: RenderDigestInput): RenderedEmail {
  const accent = color(input.theme?.accent, "#0f766e");
  const subject = oneLine(input.digest.subject?.(input.person, input.day) ?? `${input.digest.title}: ${input.day.label}`);
  const end = footer(input.siteName, input.kind, input.links, accent);
  const sections = input.sections.map(
    (section) => html`<tr><td style="padding:18px 28px;border-top:1px solid #e3e8ec;font:15px/1.55 ${raw(FONT)};color:#0e161c">
<h2 style="margin:0 0 8px;font:600 17px/1.3 ${raw(FONT)};color:#0e161c">${oneLine(section.title)}</h2>
${section.html}
</td></tr>`,
  );
  const body = html`<tr><td style="padding:24px 28px 4px;border-top:4px solid ${raw(accent)};border-radius:12px 12px 0 0;font:600 21px/1.3 ${raw(FONT)};color:#0e161c">${input.digest.title}</td></tr>
<tr><td style="padding:0 28px 18px;font:14px/1.4 ${raw(FONT)};color:#55636f">${input.day.label}</td></tr>
${sections}
${end.html}`;
  const text = [
    `${input.digest.title}: ${input.day.label}`,
    "",
    ...input.sections.flatMap((section) => [oneLine(section.title), "-".repeat(Math.min(60, oneLine(section.title).length)), section.text.trim(), ""]),
    end.text,
  ].join("\n");
  return { subject, html: frame(body), text };
}

export interface RenderAlertInput {
  readonly siteName: string;
  readonly kind: EmailKind;
  readonly subject: string;
  readonly text: string;
  readonly html: SafeHtml;
  readonly links: EmailLinks;
  readonly theme?: EmailTheme;
}

/** An alert email: the project's own words, in the same frame and footer. */
export function renderAlertEmail(input: RenderAlertInput): RenderedEmail {
  const accent = color(input.theme?.accent, "#0f766e");
  const end = footer(input.siteName, input.kind, input.links, accent);
  const body = html`<tr><td style="padding:24px 28px 18px;border-top:4px solid ${raw(accent)};border-radius:12px 12px 0 0;font:15px/1.55 ${raw(FONT)};color:#0e161c">
${input.html}
</td></tr>
${end.html}`;
  return { subject: oneLine(input.subject), html: frame(body), text: `${input.text.trim()}\n\n${end.text}` };
}

/** A section's plain text as HTML paragraphs, for a section that writes only text. */
export function paragraphs(text: string): SafeHtml {
  const blocks = text
    .replace(/\r\n?/g, "\n")
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter((block) => block !== "");
  return raw(blocks.map((block) => `<p style="margin:0 0 10px">${escapeHtml(block).replace(/\n/g, "<br>")}</p>`).join(""));
}
