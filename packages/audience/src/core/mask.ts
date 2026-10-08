import { createHmac, randomBytes } from "node:crypto";
import { normalizeEmail } from "./normalize.js";
import type { AudienceRule, AudienceRun } from "./types.js";

/**
 * Masking for the analytics role (Road Rally's analyst-privacy pattern): an
 * analyst sees "j***@gmail.com · 3f9a" — enough to tell two people apart in
 * one screen, not enough to read an address. The tag is an HMAC under a salt
 * made fresh for each response, so the same person carries a different tag
 * tomorrow and tags cannot be joined across exports.
 *
 * MASK ON THE SERVER. The UI's `maskEmails` prop is a display fallback; an
 * address that reaches the browser is readable in devtools whatever the
 * component draws.
 */

/** "jane.doe@gmail.com" → "j***@gmail.com". Not an email → returned unchanged. */
export function maskEmail(email: string): string {
  const normalized = normalizeEmail(email);
  if (!normalized) return email;
  const at = normalized.lastIndexOf("@");
  const local = normalized.slice(0, at);
  return `${local.slice(0, 1)}***@${normalized.slice(at + 1)}`;
}

/** Any email-looking run inside free text, masked. */
export function maskEmailsIn(text: string): string {
  return text.replace(/[^\s@<>()"',;:]+@[^\s@<>()"',;:]+\.[^\s@<>()"',;:]+/g, (match) => maskEmail(match));
}

export interface Masker {
  /** "j***@gmail.com" */
  email(email: string): string;
  /** A short tag, stable within this masker only. */
  tag(value: string): string;
  /** "j***@gmail.com · 3f9a" — the form lists show. */
  label(email: string): string;
  /** Free text with any address inside masked and tagged. */
  text(value: string): string;
}

/** A masker with its own salt (random unless given — pass one only in tests). */
export function createMasker(salt: string = randomBytes(16).toString("hex")): Masker {
  const tag = (value: string) =>
    createHmac("sha256", salt).update(normalizeEmail(value) ?? value).digest("hex").slice(0, 4);
  const label = (email: string) => `${maskEmail(email)} · ${tag(email)}`;
  return {
    email: maskEmail,
    tag,
    label,
    text: (value) =>
      value.replace(/[^\s@<>()"',;:]+@[^\s@<>()"',;:]+\.[^\s@<>()"',;:]+/g, (match) => label(match)),
  };
}

/** Rule kinds whose value can identify a person. */
const PERSONAL_KINDS = new Set(["email", "email_pattern", "user", "visitor"]);

/**
 * A network rule's value as an analyst may see it. A single address (/32,
 * /128) is usually someone's home connection, so it is shortened and tagged;
 * a wider range (an office /24) stays readable.
 */
export function maskNetwork(value: string, masker?: Pick<Masker, "tag">): string {
  const slash = value.lastIndexOf("/");
  const address = slash >= 0 ? value.slice(0, slash) : value;
  const bits = slash >= 0 ? Number(value.slice(slash + 1)) : address.includes(":") ? 128 : 32;
  const v6 = address.includes(":");
  if (bits < (v6 ? 128 : 32)) return value;
  const head = v6 ? address.split(":").slice(0, 2).join(":") : address.split(".").slice(0, 2).join(".");
  const short = `${head}${v6 ? ":" : "."}•••/${bits}`;
  return masker ? `${short} · ${masker.tag(value)}` : short;
}

/**
 * Rules as an analyst may see them: email values masked and tagged; user and
 * device ids, and email patterns ("rachel.smith"), shortened and tagged; a
 * single-address network shortened; any address in a label, note or author
 * masked.
 */
export function maskRule(rule: AudienceRule, masker: Masker): AudienceRule {
  let value = rule.value;
  if (rule.kind === "email") value = masker.label(rule.value);
  else if (rule.kind === "network") value = maskNetwork(rule.value, masker);
  else if (PERSONAL_KINDS.has(rule.kind)) value = shortenId(rule.value, masker);
  return {
    ...rule,
    value,
    reasonLabel: rule.reasonLabel === null ? null : masker.text(rule.reasonLabel),
    note: rule.note === null ? null : masker.text(rule.note),
    createdBy: rule.createdBy === null ? null : masker.text(rule.createdBy),
    disabledBy: rule.disabledBy === null ? null : masker.text(rule.disabledBy),
  };
}

export function maskRun(run: AudienceRun, masker: Masker): AudienceRun {
  return {
    ...run,
    runBy: run.runBy === null ? null : masker.text(run.runBy),
    summary: run.summary === null ? null : masker.text(run.summary),
  };
}

export function shortenId(id: string, masker: Pick<Masker, "tag">): string {
  if (id.length <= 6) return `••• · ${masker.tag(id)}`;
  return `${id.slice(0, 3)}••• · ${masker.tag(id)}`;
}
