import { useEffect, useMemo, useRef } from "react";
import type { ClientError, Result } from "../http.js";
import type { WireIssue } from "../types.js";
import { createInvoicingClient, type InvoicingTransport } from "./client.js";

const MISSING: Result<never> = {
  ok: false,
  error: { code: "bad_response", message: "This screen isn't connected to the invoices server yet.", status: 0 },
};

function missingTransport(): InvoicingTransport {
  const fail = () => Promise.resolve(MISSING);
  return new Proxy({} as InvoicingTransport, { get: () => fail });
}

/** `transport` wins over `baseUrl`; with neither, every call answers one plain error. */
export function useInvoicingTransport(transport: InvoicingTransport | undefined, baseUrl: string | undefined): InvoicingTransport {
  return useMemo(() => transport ?? (baseUrl ? createInvoicingClient({ baseUrl }) : missingTransport()), [transport, baseUrl]);
}

/** A call that never rejects: a host transport that throws still becomes an error value. */
export async function safely<T>(call: () => Promise<Result<T>>): Promise<Result<T>> {
  try {
    return await call();
  } catch {
    return { ok: false, error: { code: "bad_response", message: "Something went wrong. Please try again.", status: 0 } };
  }
}

/**
 * An href from a pattern or a function. A server page can't pass a function
 * to a client component, so a string is a pattern whose `{id}` is replaced
 * with the encoded id (T1's `detailHref` precedent).
 */
export function hrefFor(href: string | ((id: string) => string), id: string): string {
  return typeof href === "function" ? href(id) : href.split("{id}").join(encodeURIComponent(id));
}

/** True while mounted: async answers check it before setting state. */
export function useAlive() {
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  return alive;
}

/** The server's issue for a field path ("items.0.unitPrice"), if any. */
export function issueAt(issues: readonly WireIssue[] | undefined, path: string): string | null {
  return issues?.find((issue) => issue.path.join(".") === path)?.message ?? null;
}

/** The sentence for a refusal that has no field to sit on. */
export function errorSentence(error: ClientError): string {
  return error.message || "Something went wrong. Please try again.";
}

/** Go to a page (the ledger opening an invoice). Isolated so tests can watch it. */
export function navigate(href: string): void {
  if (typeof window !== "undefined" && typeof window.location?.assign === "function") window.location.assign(href);
}
