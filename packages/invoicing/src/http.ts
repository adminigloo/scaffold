import { z } from "zod";
import { InvoicingError, PaymentRefusedError } from "./errors.js";
import type { InvoicingErrorCodeWire, WireIssue } from "./wire.js";

/**
 * The HTTP mechanics both handler factories share: the same-site check, body
 * parsing, the error vocabulary and its statuses. COPIED, never imported,
 * from @adminigloo/scheduling's http.ts, so invoicing installs alone.
 */

function hostOf(value: string): string | null {
  try {
    return new URL(value).host.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * COPIED FROM @adminigloo/scheduling's http.ts; change both or neither.
 * Was this request sent by a browser from ANOTHER site? (Sec-Fetch-Site,
 * then Origin/Referer against the request's host, then "no browser headers at
 * all" for a server or a test.)
 */
export function isCrossSiteRequest(req: Request): boolean {
  const site = req.headers.get("sec-fetch-site");
  if (site !== null) {
    const verdict = site.trim().toLowerCase();
    return !(verdict === "same-origin" || verdict === "same-site" || verdict === "none");
  }
  const origin = req.headers.get("origin");
  if (origin !== null && origin.trim().toLowerCase() === "null") return true;
  const source = origin ?? req.headers.get("referer");
  if (source) {
    const from = hostOf(source);
    if (!from) return true;
    const forwarded = req.headers.get("x-forwarded-host")?.split(",")[0]?.trim().toLowerCase();
    return !(from === hostOf(req.url) || (forwarded !== undefined && forwarded !== "" && from === forwarded));
  }
  for (const name of req.headers.keys()) {
    if (name.toLowerCase().startsWith("sec-fetch-")) return true;
  }
  return false;
}

/** An error a handler answers as is. */
export class InvoicingHttpError extends Error {
  readonly name = "InvoicingHttpError";
  constructor(
    readonly code: InvoicingErrorCodeWire,
    readonly status: number,
    message: string,
    readonly issues?: WireIssue[],
  ) {
    super(message);
  }
}

export const INTERNAL_MESSAGE = "Something went wrong. Please try again.";
export const CROSS_SITE_MESSAGE = "This request came from another site, so it was refused.";
export const FORBIDDEN_MESSAGE = "You don't have permission to do that.";
export const INVOICE_NOT_HERE = "That invoice isn't here.";
export const PUBLIC_NOT_FOUND = "This invoice isn't available. It may have been replaced; contact the business.";

/** Zod issues → the wire's `issues`, WITHOUT the input values. */
export function wireIssues(error: z.ZodError): WireIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.filter((part): part is string | number => typeof part !== "symbol"),
    message: issue.message,
  }));
}

/**
 * The plain sentence for a package refusal. The package's own sentence, with
 * one exception: a payment on a draft. Its message names `allowDraft`, an
 * option of the function, which means nothing to a business owner reading it
 * on a button press.
 */
function refusalMessage(error: InvoicingError): string {
  // CONTRACT: 10.5 says "the error's own sentence". The draft refusal's own
  // sentence ends "…or record with allowDraft" (a developer option), so the
  // handler says what the owner can do instead. Every other refusal is the
  // package's sentence unchanged.
  if (error instanceof PaymentRefusedError && error.reason === "draft") {
    return "This invoice is still a draft. Send it first, then record the payment.";
  }
  return error.message;
}

/** Any thrown value → status, code, message (and issues), never echoing an unknown error's own text. */
export function toWireError(error: unknown): { status: number; code: InvoicingErrorCodeWire; message: string; issues?: WireIssue[] } {
  if (error instanceof InvoicingHttpError) {
    return { status: error.status, code: error.code, message: error.message, ...(error.issues ? { issues: error.issues } : {}) };
  }
  if (error instanceof InvoicingError) {
    return { status: 409, code: error.code, message: refusalMessage(error) };
  }
  if (error instanceof z.ZodError) {
    return { status: 400, code: "invalid", message: "Some details need another look.", issues: wireIssues(error) };
  }
  return { status: 500, code: "internal", message: INTERNAL_MESSAGE };
}

/** True for an error the handler meant to answer (anything else is reported). */
export function isExpected(error: unknown): boolean {
  return error instanceof InvoicingHttpError || error instanceof InvoicingError || error instanceof z.ZodError;
}

/** 32 KB: 200 lines of 500 characters would not fit, but no real invoice is that. */
const MAX_BODY_BYTES = 32 * 1024;

/** A JSON object body. Missing → {}. */
export async function readJsonBody(req: Request): Promise<Record<string, unknown>> {
  const text = await req.text();
  if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) {
    throw new InvoicingHttpError("invalid", 400, "That's too much to save at once.");
  }
  if (text.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new InvoicingHttpError("invalid", 400, "Expected a JSON body.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new InvoicingHttpError("invalid", 400, "Expected a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

export function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return "";
  }
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "cache-control": "no-store", "content-type": "application/json; charset=utf-8", ...headers },
  });
}

export function failure(error: unknown, headers: Record<string, string> = {}): Response {
  const wire = toWireError(error);
  return json(
    { error: { code: wire.code, message: wire.message, ...(wire.issues ? { issues: wire.issues } : {}) } },
    wire.status,
    headers,
  );
}

/** The suffix after `marker` split into decoded segments; null when absent or with an empty segment. */
export function segmentsAfter(pathname: string, marker: string): string[] | null {
  const path = pathname.replace(/\/+$/, "");
  const at = path.lastIndexOf(marker);
  if (at < 0) return null;
  const parts = path.slice(at + marker.length).split("/").map(safeDecode);
  return parts.some((part) => part === "") ? null : parts;
}
