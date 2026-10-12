import type { SubmitBody, SubmitItem, WireIssue } from "./types.js";

/**
 * The customer's details form: its rules, the body it becomes, and the
 * server's issues mapped back onto it — pure, so every branch is a unit test.
 *
 * The client checks MIRROR the server's (`publicSubmitSchema`'s lengths, an
 * email's shape, "an email or a phone number") so a customer hears about a
 * problem before the round trip. They are a courtesy, not the gate: the server
 * checks everything again, and its `issues` land on the same fields.
 */

export const LIMITS = { name: 200, email: 320, phone: 60, address: 500, notes: 2000 } as const;

export interface DetailsValues {
  name: string;
  email: string;
  phone: string;
  address: string;
  notes: string;
  /** The honeypot. A person never sees it, so it stays empty. */
  website: string;
}

export type DetailsField = "name" | "email" | "phone" | "address" | "notes";
export type DetailsErrors = Partial<Record<DetailsField, string>>;

export const EMPTY_DETAILS: DetailsValues = { name: "", email: "", phone: "", address: "", notes: "", website: "" };

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isValidEmail(raw: string): boolean {
  const value = raw.trim();
  return value.length > 0 && value.length <= LIMITS.email && EMAIL_PATTERN.test(value);
}

/** Field-by-field problems, empty when the form can be sent. */
export function validateDetails(values: DetailsValues): DetailsErrors {
  const errors: DetailsErrors = {};
  const name = values.name.trim();
  if (!name) errors.name = "Enter your name.";
  else if (name.length > LIMITS.name) errors.name = `Keep your name under ${LIMITS.name} characters.`;

  const email = values.email.trim();
  const phone = values.phone.trim();
  if (!email && !phone) errors.email = "Enter an email or a phone number so we can reach you.";
  else if (email && !isValidEmail(email)) errors.email = "Enter an email address like you@example.com.";
  if (phone.length > LIMITS.phone) errors.phone = `Keep the phone number under ${LIMITS.phone} characters.`;
  else if (phone && !/\d{3,}/.test(phone.replace(/\D/g, ""))) errors.phone = "Enter a phone number we can call.";

  if (values.address.trim().length > LIMITS.address) errors.address = `Keep the address under ${LIMITS.address} characters.`;
  if (values.notes.trim().length > LIMITS.notes) errors.notes = `Keep notes under ${LIMITS.notes} characters.`;
  return errors;
}

const FIELD_ORDER: readonly DetailsField[] = ["name", "email", "phone", "address", "notes"];

/** The first invalid field in visual order: where focus goes on a failed submit. */
export function firstInvalidField(errors: DetailsErrors): DetailsField | null {
  return FIELD_ORDER.find((field) => errors[field]) ?? null;
}

/** The wire's 0.2 names, mapped to the form's (the server answers in 0.3 names, but a 0.2 server may not). */
const ALIASES: Record<string, DetailsField> = {
  name: "name",
  email: "email",
  phone: "phone",
  address: "address",
  notes: "notes",
  customerName: "name",
  customerEmail: "email",
  customerPhone: "phone",
  jobAddress: "address",
};

/**
 * The server's issues split two ways: those about the customer's details
 * (path ["email"]) and those about a measurement (["items", 0, "inputs",
 * "steps"] or ["inputs", "steps"]), keyed by the field the customer sees.
 */
export function mapSubmitIssues(issues: readonly WireIssue[] | undefined): { details: DetailsErrors; inputs: Record<string, string> } {
  const details: DetailsErrors = {};
  const inputs: Record<string, string> = {};
  for (const issue of issues ?? []) {
    const path = issue.path;
    const at = path.indexOf("inputs");
    if (at >= 0 && typeof path[at + 1] === "string") {
      const key = path[at + 1] as string;
      if (!inputs[key]) inputs[key] = issue.message;
      continue;
    }
    const top = path[0];
    const field = typeof top === "string" ? ALIASES[top] : undefined;
    if (field && !details[field]) details[field] = issue.message;
  }
  return { details, inputs };
}

/**
 * The body for `POST /v1/submit`: trimmed, empty optional fields left out (to
 * a validator an empty string is a value; absent is "not given"), the
 * honeypot sent only when something filled it, and the fill time as a whole
 * number of milliseconds.
 */
export function buildSubmitBody(input: { values: DetailsValues; item: SubmitItem; photoIds: readonly string[]; fillMs: number }): SubmitBody {
  const { values } = input;
  const body: SubmitBody = { name: values.name.trim(), items: [input.item], fillMs: Math.max(0, Math.round(input.fillMs)) };
  const email = values.email.trim();
  if (email) body.email = email;
  const phone = values.phone.trim();
  if (phone) body.phone = phone;
  const address = values.address.trim();
  if (address) body.address = address;
  const notes = values.notes.trim();
  if (notes) body.notes = notes;
  if (input.photoIds.length > 0) body.photoIds = input.photoIds.slice(0, 3);
  if (values.website) body.website = values.website;
  return body;
}
