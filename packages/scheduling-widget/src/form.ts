import { statusWords, type ClientError } from "./http.js";
import type { PublicVisitStatus, VisitRequestBody, WireIssue } from "./types.js";

/**
 * The visit form's rules, the request it becomes, and what the server's errors
 * mean to a customer — pure, so every branch is a unit test rather than a
 * click-path.
 *
 * The client checks MIRROR the server's (the lengths in the wire contract and
 * an email's shape) so a customer hears about a problem before the round trip.
 * They are a courtesy, not the gate: the server checks everything again, and
 * its `issues` are mapped back onto the same fields.
 */

export const LIMITS = {
  name: 200,
  email: 320,
  phone: 60,
  address: 500,
  notes: 2000,
  reason: 500,
} as const;

export interface VisitFormValues {
  name: string;
  email: string;
  phone: string;
  address: string;
  notes: string;
  /** The honeypot. A person never sees it, so it stays empty. */
  website: string;
}

export type VisitField = "name" | "email" | "phone" | "address" | "notes";
export type FieldErrors = Partial<Record<VisitField, string>>;

export const EMPTY_VISIT_FORM: VisitFormValues = { name: "", email: "", phone: "", address: "", notes: "", website: "" };

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Text a mail client would make a link of — the server refuses it in a name
 * or an address (the acknowledgement echoes both to the typed email), so the
 * form says so on the field first. The same pattern as the server's.
 */
const LINKISH =
  /(?:\b[a-z][a-z0-9+.-]*:\/\/|\bwww\.|\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}\/|\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|net|org|info|biz|io|co|me|us|app|link|xyz|site|online|top|click|shop|store|live|ru|cn|tk|ly|gg|zip|mov)\b)/i;

export function isValidEmail(raw: string): boolean {
  const value = raw.trim();
  return value.length > 0 && value.length <= LIMITS.email && EMAIL_PATTERN.test(value);
}

/** Field-by-field problems, empty when the form can be sent. */
export function validateVisitForm(values: VisitFormValues, options: { requireAddress: boolean }): FieldErrors {
  const errors: FieldErrors = {};
  const name = values.name.trim();
  if (!name) errors.name = "Enter your name.";
  else if (name.length > LIMITS.name) errors.name = `Keep your name under ${LIMITS.name} characters.`;
  else if (LINKISH.test(name)) errors.name = "Leave web addresses out of your name.";

  const email = values.email.trim();
  if (!email) errors.email = "Enter your email address.";
  else if (!isValidEmail(email)) errors.email = "Enter an email address like you@example.com.";

  if (values.phone.trim().length > LIMITS.phone) errors.phone = `Keep the phone number under ${LIMITS.phone} characters.`;

  const address = values.address.trim();
  if (options.requireAddress && !address) errors.address = "Enter the address where the visit is.";
  else if (address.length > LIMITS.address) errors.address = `Keep the address under ${LIMITS.address} characters.`;
  else if (LINKISH.test(address)) errors.address = "Leave web addresses out of the address.";

  if (values.notes.trim().length > LIMITS.notes) errors.notes = `Keep notes under ${LIMITS.notes} characters.`;
  return errors;
}

const FIELD_ORDER: readonly VisitField[] = ["name", "email", "phone", "address", "notes"];

/** The first invalid field in visual order: where focus goes on a failed submit. */
export function firstInvalidField(errors: FieldErrors): VisitField | null {
  return FIELD_ORDER.find((field) => errors[field]) ?? null;
}

/** Server issues that name a form field (wire names), as the form's own error map. */
export function issuesToFieldErrors(issues: readonly WireIssue[] | undefined): FieldErrors {
  const errors: FieldErrors = {};
  for (const issue of issues ?? []) {
    const field = issue.path[0];
    if (typeof field === "string" && (FIELD_ORDER as readonly string[]).includes(field) && !errors[field as VisitField]) {
      errors[field as VisitField] = issue.message;
    }
  }
  return errors;
}

/**
 * The body for `POST /v1/request`: trimmed, empty optional fields left out (to
 * a validator an empty string is a value; absent is "not given"), the
 * honeypot sent only when something filled it, and the fill time as a whole
 * number of milliseconds.
 */
export function buildVisitRequest(input: {
  slotId: string;
  service: string;
  values: VisitFormValues;
  fillMs: number;
  estimateId?: string | null;
  /** "Send it anyway": the map couldn't find the address, and the customer is sure of it. */
  addressAsTyped?: boolean;
}): VisitRequestBody {
  const { values } = input;
  const body: VisitRequestBody = {
    slotId: input.slotId,
    service: input.service,
    name: values.name.trim(),
    email: values.email.trim(),
    fillMs: Math.max(0, Math.round(input.fillMs)),
  };
  const phone = values.phone.trim();
  if (phone) body.phone = phone;
  const address = values.address.trim();
  if (address) body.address = address;
  const notes = values.notes.trim();
  if (notes) body.notes = notes;
  const estimateId = input.estimateId?.trim();
  if (estimateId) body.estimateId = estimateId.slice(0, 200);
  if (values.website) body.website = values.website;
  if (input.addressAsTyped && address) body.addressAsTyped = true;
  return body;
}

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------

/** A status as the customer reads it on their manage page. */
export function toPublicStatusLabel(status: PublicVisitStatus, businessName: string): string {
  const business = businessName.trim() || "The business";
  switch (status) {
    case "requested":
      return `Waiting for ${business} to confirm`;
    case "confirmed":
      return "Confirmed";
    case "in_progress":
      return "In progress";
    case "completed":
      return "Done";
    case "cancelled":
      return "Cancelled";
    case "declined":
      return `${business} couldn't make this time`;
    case "expired":
      return "Not confirmed in time";
    case "missed":
      return "Didn't happen";
  }
}

/** "Call us at (801) 555-0143." / "Email us at …" / "" — how to reach the business, as a sentence. */
export function contactSentence(contact: { contactPhone: string | null; contactEmail: string | null }): string {
  if (contact.contactPhone) return `Call ${contact.contactPhone}.`;
  if (contact.contactEmail) return `Email ${contact.contactEmail}.`;
  return "Please get in touch with the business.";
}

/**
 * Why a visit can't be changed online any more (contract 8.4): inside the
 * cutoff, the crew has planned its day, so the business would rather take a
 * call than lose the slot to a same-morning click.
 */
export function cutoffMessage(visit: {
  cancelCutoffHours: number;
  contactPhone: string | null;
  contactEmail: string | null;
}): string {
  const hours = visit.cancelCutoffHours;
  const lead =
    hours > 0
      ? `This visit starts within ${hours} hour${hours === 1 ? "" : "s"}, so it can't be changed online.`
      : "This visit has started, so it can't be changed online.";
  return `${lead} ${contactSentence(visit)}`;
}

export type ErrorContext = "config" | "slots" | "request" | "visit" | "reschedule" | "cancel";

/**
 * What a customer reads for an error, by where it happened. Codes whose server
 * message is written for a person (too_soon, too_far, spam_suspected) use it;
 * everything else gets fixed words, because a server's text for `internal` or a
 * proxy's HTML page is not for customers.
 */
export function friendlyError(error: ClientError, context: ErrorContext): string {
  switch (error.code) {
    case "network":
      return "We couldn't connect. Check your connection and try again.";
    case "rate_limited":
      return "That's a lot of tries in a short time. Wait a minute, then try again.";
    case "spam_suspected":
      return "That was quicker than a person can fill in the form. Please check your details and send it again.";
    case "too_many_requests":
      return "You already have visits booked or waiting with us. Please call or email us to book another.";
    case "booking_closed":
      return context === "reschedule" ? "Online changes are switched off right now." : "Online booking is closed right now.";
    case "slot_unavailable":
      return "That time was just taken. Pick another.";
    case "too_soon":
      return error.message && error.message !== "too_soon" ? error.message : "That time is too soon to book online. Pick a later one.";
    case "too_far":
      return error.message && error.message !== "too_far" ? error.message : "That time is too far ahead to book online yet. Pick an earlier one.";
    case "unknown_service":
    case "invalid_duration":
      return "That service isn't offered any more. Please choose again.";
    case "address_unresolved":
      return "We couldn't find that address on the map. Check the street, city and ZIP code. If it's right, send it anyway and we'll check it with you.";
    case "not_found":
      if (context === "visit" || context === "reschedule" || context === "cancel") return "This link doesn't open a visit.";
      return "That isn't available any more. Please refresh the page.";
    case "forbidden":
      return "Booking from this page isn't allowed. Please use the business's own website.";
    case "invalid":
      if (context === "request") {
        return Object.keys(issuesToFieldErrors(error.issues)).length > 0
          ? "Please check the highlighted fields."
          : "Some details weren't accepted. Please check them and try again.";
      }
      if (context === "cancel") return "That cancellation couldn't be sent. Please try again.";
      return "Something about this page isn't right. Please refresh and try again.";
    case "bad_response":
      return statusWords(error.status, "Something went wrong on our side. Please try again.");
    default:
      return "Something went wrong on our side. Please try again.";
  }
}

/** The time went away under the customer: back to the times, refetched, form kept. */
export function isTimeGone(error: ClientError): boolean {
  return error.code === "slot_unavailable" || error.code === "too_soon" || error.code === "too_far";
}
