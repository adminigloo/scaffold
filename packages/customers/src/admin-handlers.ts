import {
  addCustomerAddress,
  createCustomer,
  customerTimeline,
  CustomersRefusal,
  exportCustomersCsv,
  getCustomer,
  keptCustomer,
  listCustomers,
  mergeCustomers,
  removeCustomerAddress,
  resolveCustomerNotice,
  updateCustomer,
  type NoticeAction,
  type CustomersDb,
} from "./customers.js";
import { applyCustomerImport, previewCustomerImport } from "./import.js";
import type { CustomersPermission } from "./permissions.js";
import { CUSTOMERS_ADMIN_ROUTE_PERMISSIONS, type CustomersAdminRouteKind } from "./routes.js";

/**
 * THE CUSTOMER SCREEN'S HANDLER (customers 0.1), mounted by the app at
 * /api/app/{company id}/customers (a company's) or /api/admin/customers (one
 * business's). Every route asks `authorize(req, permission, tenantId)` for
 * its one key (CUSTOMERS_ADMIN_ROUTE_PERMISSIONS). A customer or address
 * named in the path — or the customer a merge names in its body — is read
 * INSIDE the company the request resolved to: another company's is "not
 * found", exactly like one that doesn't exist. POSTs from another site are
 * refused. No CORS.
 */

/** COPIED FROM @adminigloo/commerce's store-handlers.ts (isCrossSiteRequest); change both or neither. */
export function isCrossSiteRequest(req: Request): boolean {
  const site = req.headers.get("sec-fetch-site");
  if (site !== null) {
    const verdict = site.trim().toLowerCase();
    return !(verdict === "same-origin" || verdict === "none");
  }
  const origin = req.headers.get("origin");
  if (origin !== null && origin.trim().toLowerCase() === "null") return true;
  const source = origin ?? req.headers.get("referer");
  if (source) {
    const host = (value: string) => {
      try {
        return new URL(value).host.toLowerCase();
      } catch {
        return null;
      }
    };
    const from = host(source);
    if (!from) return true;
    const forwarded = req.headers.get("x-forwarded-host")?.split(",")[0]?.trim().toLowerCase();
    return !(from === host(req.url) || (forwarded !== undefined && forwarded !== "" && from === forwarded));
  }
  for (const name of req.headers.keys()) {
    if (name.toLowerCase().startsWith("sec-fetch-")) return true;
  }
  return false;
}

class HttpRefusal extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const NOT_HERE = "That isn't here.";
const INTERNAL = "Something went wrong. Please try again.";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "cache-control": "no-store", "content-type": "application/json; charset=utf-8" } });
}

function refusalStatus(code: string): number {
  return code === "not_found" ? 404 : code === "invalid" ? 400 : 409;
}

function failure(error: unknown): Response {
  if (error instanceof HttpRefusal) return json({ error: { code: error.code, message: error.message } }, error.status);
  if (error instanceof CustomersRefusal) return json({ error: { code: error.code, message: error.message } }, refusalStatus(error.code));
  return json({ error: { code: "internal", message: INTERNAL } }, 500);
}

function expected(error: unknown): boolean {
  return error instanceof HttpRefusal || error instanceof CustomersRefusal;
}

/** COPIED FROM @adminigloo/commerce's store-handlers.ts (readBodyCapped); change both or neither. */
async function readBodyCapped(req: Request, cap: number): Promise<Uint8Array> {
  const tooLarge = () => new HttpRefusal("invalid", 413, "That's too much to send at once.");
  const declared = req.headers.get("content-length");
  if (declared !== null && /^\s*\d+\s*$/.test(declared) && Number(declared) > cap) throw tooLarge();
  const body = req.body;
  if (!body) return new Uint8Array(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > cap) {
        await reader.cancel().catch(() => undefined);
        throw tooLarge();
      }
      chunks.push(value);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* already released */
    }
  }
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return bytes;
}

async function readJson(req: Request, cap = 32 * 1024): Promise<Record<string, unknown>> {
  const text = new TextDecoder().decode(await readBodyCapped(req, cap));
  if (text.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new HttpRefusal("invalid", 400, "Expected a JSON body.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new HttpRefusal("invalid", 400, "Expected a JSON object.");
  return parsed as Record<string, unknown>;
}

function segmentsAfter(pathname: string, marker: string): string[] | null {
  const path = pathname.replace(/\/+$/, "");
  const at = path.lastIndexOf(marker);
  if (at < 0) return null;
  const parts = path
    .slice(at + marker.length)
    .split("/")
    .map((part) => {
      try {
        return decodeURIComponent(part);
      } catch {
        return "";
      }
    });
  return parts.some((part) => part === "") ? null : parts;
}

/** A CSV import's most: 5,000 customers is about 1 MB; 4 MB leaves room for long notes. */
export const CUSTOMERS_IMPORT_MAX_BYTES = 4 * 1024 * 1024;

export type CustomersAuthorizeResult = boolean | { userId?: string | number | null } | Response;

export interface CreateCustomersAdminHandlersOptions {
  readonly db: CustomersDb;
  /** A fixed business (one business). Pass this or `resolveTenant`. */
  readonly tenantId?: string;
  readonly resolveTenant?: (req: Request) => string | null | Promise<string | null>;
  readonly authorize: (req: Request, permission: CustomersPermission, tenantId: string) => CustomersAuthorizeResult | Promise<CustomersAuthorizeResult>;
  /** Reads a phone written without "+" (ISO 3166 alpha-2). Default "US". */
  readonly defaultCountry?: (tenantId: string) => string | Promise<string>;
  readonly onError?: (error: unknown, context: { tenantId: string | null; route: string }) => void;
}

function adminRoute(method: string, pathname: string): { kind: CustomersAdminRouteKind; id: string | null; sub: string | null } | null {
  const parts = segmentsAfter(pathname, "/v1/admin/");
  if (!parts) return null;
  const [a, b, c, d, e] = parts;
  const n = parts.length;
  if (method === "GET") {
    if (n === 1 && a === "customers") return { kind: "list", id: null, sub: null };
    if (n === 2 && a === "customers") return { kind: "get", id: b!, sub: null };
    if (n === 3 && a === "customers" && c === "timeline") return { kind: "timeline", id: b!, sub: null };
    if (n === 1 && a === "export") return { kind: "export", id: null, sub: null };
    return null;
  }
  if (method !== "POST") return null;
  if (n === 1 && a === "customers") return { kind: "create", id: null, sub: null };
  if (n === 2 && a === "customers") return { kind: "update", id: b!, sub: null };
  if (n === 3 && a === "customers" && c === "addresses") return { kind: "address-add", id: b!, sub: null };
  if (n === 5 && a === "customers" && c === "addresses" && e === "remove") return { kind: "address-remove", id: b!, sub: d! };
  if (n === 3 && a === "customers" && c === "merge") return { kind: "merge", id: b!, sub: null };
  if (n === 4 && a === "customers" && c === "notices") return { kind: "notice", id: b!, sub: d! };
  if (n === 2 && a === "import" && b === "preview") return { kind: "import-preview", id: null, sub: null };
  if (n === 2 && a === "import" && b === "apply") return { kind: "import-apply", id: null, sub: null };
  return null;
}

export function createCustomersAdminHandlers(options: CreateCustomersAdminHandlersOptions): { handle: (req: Request) => Promise<Response> } {
  if (!options.tenantId && !options.resolveTenant) throw new Error("createCustomersAdminHandlers: pass tenantId or resolveTenant");
  if (typeof options.authorize !== "function") throw new Error("createCustomersAdminHandlers: pass authorize (your permission check)");
  const report = (error: unknown, tenantId: string | null, route: string) => {
    try {
      options.onError?.(error, { tenantId, route });
    } catch {
      /* never let a reporter break an answer */
    }
  };
  const notFound = () => new HttpRefusal("not_found", 404, NOT_HERE);

  async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const matched = adminRoute(req.method, url.pathname);
    if (!matched) return failure(notFound());
    if (req.method === "POST" && isCrossSiteRequest(req)) return failure(new HttpRefusal("cross_site", 403, "This request came from another site, so it was refused."));
    let tenantId: string | null = null;
    try {
      tenantId = options.resolveTenant ? await options.resolveTenant(req) : (options.tenantId ?? null);
      if (!tenantId) return failure(notFound());
      const verdict = await options.authorize(req, CUSTOMERS_ADMIN_ROUTE_PERMISSIONS[matched.kind], tenantId);
      if (verdict instanceof Response) return verdict;
      if (!verdict) return failure(new HttpRefusal("forbidden", 403, "You don't have permission to do that."));
      const userId = typeof verdict === "object" && verdict.userId !== undefined && verdict.userId !== null ? String(verdict.userId) : null;
      const scoped: string = tenantId;
      const country = options.defaultCountry ? await options.defaultCountry(scoped) : "US";
      const id = matched.id ?? "";
      const found = <T>(value: T | null): T => {
        if (value === null) throw notFound();
        return value;
      };
      switch (matched.kind) {
        case "list":
          return json(await listCustomers(options.db, scoped, { q: url.searchParams.get("q"), cursor: url.searchParams.get("cursor"), defaultCountry: country }));
        case "create":
          return json({ customer: await createCustomer(options.db, scoped, await readJson(req), { defaultCountry: country }) }, 201);
        case "get": {
          const customer = await getCustomer(options.db, scoped, id);
          if (customer) return json({ customer });
          // An old link to a customer merged into another opens the one kept.
          const kept = await keptCustomer(options.db, scoped, id);
          if (!kept || kept.id === id) throw notFound();
          return json({ customer: found(await getCustomer(options.db, scoped, kept.id)), mergedFrom: id });
        }
        case "update": {
          const body = await readJson(req);
          return json({ customer: found(await updateCustomer(options.db, scoped, id, body, { defaultCountry: country })) });
        }
        case "timeline": {
          const order = url.searchParams.get("order") === "oldest" ? "oldest" : "newest";
          return json(found(await customerTimeline(options.db, scoped, id, { cursor: url.searchParams.get("cursor"), order })));
        }
        case "address-add": {
          const body = await readJson(req);
          return json({ customer: found(await addCustomerAddress(options.db, scoped, id, body)) });
        }
        case "address-remove":
          return json({ customer: found(await removeCustomerAddress(options.db, scoped, id, matched.sub ?? "")) });
        case "merge": {
          const body = await readJson(req);
          const mergeId = typeof body.mergeId === "string" ? body.mergeId : "";
          if (!mergeId) throw new HttpRefusal("invalid", 400, "Choose the customer to merge into this one.");
          return json(found(await mergeCustomers(options.db, scoped, id, mergeId, userId)));
        }
        case "notice": {
          const body = await readJson(req);
          const action = body.action;
          if (action !== "add" && action !== "ignore" && action !== "dismiss") throw new HttpRefusal("invalid", 400, "Choose Add, Ignore or Not the same.");
          return json({ customer: found(await resolveCustomerNotice(options.db, scoped, id, matched.sub ?? "", action as NoticeAction, userId)) });
        }
        case "import-preview": {
          const body = await readJson(req, CUSTOMERS_IMPORT_MAX_BYTES);
          if (typeof body.csv !== "string") throw new HttpRefusal("invalid", 400, "Choose a CSV file to import.");
          return json(await previewCustomerImport(options.db, scoped, body.csv, { defaultCountry: country }));
        }
        case "import-apply": {
          const body = await readJson(req, CUSTOMERS_IMPORT_MAX_BYTES);
          if (typeof body.csv !== "string") throw new HttpRefusal("invalid", 400, "Choose a CSV file to import.");
          const fromRow = typeof body.fromRow === "number" && Number.isInteger(body.fromRow) && body.fromRow >= 0 ? body.fromRow : 0;
          return json(await applyCustomerImport(options.db, scoped, body.csv, { defaultCountry: country, fromRow }));
        }
        case "export": {
          const csv = await exportCustomersCsv(options.db, scoped);
          return new Response(csv, {
            status: 200,
            headers: {
              "cache-control": "no-store",
              "content-type": "text/csv; charset=utf-8",
              "content-disposition": `attachment; filename="customers-${new Date().toISOString().slice(0, 10)}.csv"`,
            },
          });
        }
      }
    } catch (error) {
      if (!expected(error)) report(error, tenantId, matched.kind);
      return failure(error);
    }
  }

  return { handle };
}
