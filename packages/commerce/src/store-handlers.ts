import {
  listPublicStoreProducts,
  listStoreAlerts,
  listStoreOrders,
  listStoreProducts,
  markStoreOrderSent,
  getStoreSettings,
  openStoreAlertCount,
  releaseHeldStock,
  releaseLapsedStoreCheckouts,
  saveStoreSettings,
  storeVisitorKey,
  removeStoreProduct,
  resolveStoreAlert,
  setStoreProductPhoto,
  startStoreCheckout,
  storeAlertWire,
  storeCheckoutStatus,
  StoreRefusal,
  storeProductExists,
  updateStoreProduct,
  createStoreProduct,
  type StoreCardPayments,
  type StoreDb,
} from "./store.js";
import { STORE_ADMIN_ROUTE_PERMISSIONS, type StoreAdminRouteKind, type StorePublicRouteKind } from "./store-routes.js";
import type { StorePermission } from "./permissions.js";
import type { StorePublicResponse, StoreStatusResponse } from "./store-wire.js";

/**
 * THE STORE'S TWO HANDLERS (commerce 0.2), mounted by the app:
 *
 *   createStoreAdminHandlers   the owner's screen: products, orders, what
 *                              needs attention — every route asks
 *                              `authorize(req, permission, tenantId)` for its
 *                              one key (STORE_ADMIN_ROUTE_PERMISSIONS)
 *   createStorePublicHandlers  the store page, Check out, the thank-you page
 *
 * A row named in the path (a product, an order, an alert, a checkout) is
 * read INSIDE the business the request resolved to: another business's is
 * "not found", exactly like one that doesn't exist. POSTs from another site
 * are refused. No CORS.
 */

// --- HTTP mechanics -------------------------------------------------------------

/** COPIED FROM @adminigloo/invoicing's http.ts (isCrossSiteRequest); change both or neither. */
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

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "cache-control": "no-store", "content-type": "application/json; charset=utf-8", ...headers } });
}

function refusalStatus(code: string): number {
  return code === "not_found" ? 404 : code === "invalid" ? 400 : 409;
}

function failure(error: unknown, headers: Record<string, string> = {}): Response {
  if (error instanceof HttpRefusal) return json({ error: { code: error.code, message: error.message } }, error.status, headers);
  if (error instanceof StoreRefusal) return json({ error: { code: error.code, message: error.message } }, refusalStatus(error.code), headers);
  return json({ error: { code: "internal", message: INTERNAL } }, 500, headers);
}

function expected(error: unknown): boolean {
  return error instanceof HttpRefusal || error instanceof StoreRefusal;
}

/**
 * COPIED FROM @adminigloo/invoicing's http.ts (readBodyCapped); change both
 * or neither. The body's bytes, refused the moment more than `cap` arrive —
 * a declared length over the cap before a byte is read.
 */
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

/** The photo's real type from its first bytes (never the name, never the header the browser sent). */
export function sniffStorePhoto(bytes: Uint8Array): "image/png" | "image/jpeg" | "image/webp" | "image/gif" | null {
  const at = (i: number) => bytes[i] ?? -1;
  if (at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47) return "image/png";
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return "image/jpeg";
  if (at(0) === 0x47 && at(1) === 0x49 && at(2) === 0x46) return "image/gif";
  if (at(0) === 0x52 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x46 && at(8) === 0x57 && at(9) === 0x45 && at(10) === 0x42 && at(11) === 0x50) return "image/webp";
  return null;
}

/** A product photo's most: 4 MB, storage's own upload limit (the base64 body is a third bigger). */
export const STORE_PHOTO_MAX_BYTES = 4 * 1024 * 1024;

// --- The owner's side -------------------------------------------------------------

export type StoreAuthorizeResult = boolean | { userId?: string | number | null } | Response;

/**
 * Where a product's photo is kept: structurally storage's
 * `purposeStore(STORE_PHOTO_PURPOSE.key)` — the business's own files, public,
 * COUNTED in its storage allowance (a full business is refused in storage's
 * own words).
 */
export interface StorePhotoStore {
  put(input: {
    readonly tenantId: string;
    readonly bytes: Uint8Array;
    readonly contentType: string;
    readonly filename: string;
    readonly addedBy?: string | null;
  }): Promise<{ readonly fileId: string; readonly url: string }>;
  delete(input: { readonly tenantId: string; readonly fileId: string }): Promise<void>;
}

export interface CreateStoreAdminHandlersOptions {
  readonly db: StoreDb;
  /** A fixed business (one business). Pass this or `resolveTenant`. */
  readonly tenantId?: string;
  readonly resolveTenant?: (req: Request) => string | null | Promise<string | null>;
  readonly authorize: (req: Request, permission: StorePermission, tenantId: string) => StoreAuthorizeResult | Promise<StoreAuthorizeResult>;
  /** The Stripe seam: whether the business takes orders, and closing pages a product edit made stale. */
  readonly payments?: StoreCardPayments;
  /** Product photos (file storage). Absent: the screen says photo uploads aren't switched on. */
  readonly photoStore?: StorePhotoStore;
  /** The plan's number of products. A number: the limit; null: none; undefined: the plan doesn't say. */
  readonly productLimit?: (tenantId: string) => number | null | undefined | Promise<number | null | undefined>;
  /** The currency new products start in (the business's own). Default "usd". */
  readonly currency?: (tenantId: string) => string | Promise<string>;
  /** Why the business isn't taking orders when it isn't (e.g. "Connect Stripe at Card payments"). */
  readonly notTakingOrders?: string;
  /** Your limit on photo uploads, per business: false → 429. Default: none. */
  readonly photoRateLimit?: (tenantId: string) => boolean | Promise<boolean>;
  readonly onError?: (error: unknown, context: { tenantId: string | null; route: string }) => void;
}

function adminRoute(method: string, pathname: string): { kind: StoreAdminRouteKind; id: string | null } | null {
  const parts = segmentsAfter(pathname, "/v1/admin/");
  if (!parts) return null;
  const [a, b, c, d] = parts;
  const n = parts.length;
  if (method === "GET") {
    if (n === 1 && a === "status") return { kind: "status", id: null };
    if (n === 1 && a === "products") return { kind: "products", id: null };
    if (n === 1 && a === "orders") return { kind: "orders", id: null };
    if (n === 1 && a === "attention") return { kind: "attention", id: null };
    return null;
  }
  if (method !== "POST") return null;
  if (n === 1 && a === "products") return { kind: "product-create", id: null };
  if (n === 2 && a === "products") return { kind: "product-update", id: b! };
  if (n === 3 && a === "products" && c === "photo") return { kind: "product-photo", id: b! };
  if (n === 3 && a === "products" && c === "remove") return { kind: "product-remove", id: b! };
  if (n === 3 && a === "products" && c === "release") return { kind: "product-release", id: b! };
  if (n === 1 && a === "settings") return { kind: "settings-save", id: null };
  if (n === 3 && a === "orders" && c === "sent") return { kind: "order-sent", id: b! };
  if (n === 3 && a === "attention" && c === "resolve") return { kind: "attention-resolve", id: b! };
  void d;
  return null;
}

export function createStoreAdminHandlers(options: CreateStoreAdminHandlersOptions): { handle: (req: Request) => Promise<Response> } {
  if (!options.tenantId && !options.resolveTenant) throw new Error("createStoreAdminHandlers: pass tenantId or resolveTenant");
  if (typeof options.authorize !== "function") throw new Error("createStoreAdminHandlers: pass authorize (your permission check)");
  const report = (error: unknown, tenantId: string | null, route: string) => {
    try {
      options.onError?.(error, { tenantId, route });
    } catch {
      /* never let a reporter break an answer */
    }
  };
  const notFound = () => new HttpRefusal("not_found", 404, NOT_HERE);

  async function handle(req: Request): Promise<Response> {
    const matched = adminRoute(req.method, new URL(req.url).pathname);
    if (!matched) return failure(notFound());
    if (req.method === "POST" && isCrossSiteRequest(req)) return failure(new HttpRefusal("cross_site", 403, "This request came from another site, so it was refused."));
    let tenantId: string | null = null;
    try {
      tenantId = options.resolveTenant ? await options.resolveTenant(req) : (options.tenantId ?? null);
      if (!tenantId) return failure(notFound());
      const verdict = await options.authorize(req, STORE_ADMIN_ROUTE_PERMISSIONS[matched.kind], tenantId);
      if (verdict instanceof Response) return verdict;
      if (!verdict) return failure(new HttpRefusal("forbidden", 403, "You don't have permission to do that."));
      const userId = typeof verdict === "object" && verdict.userId !== undefined && verdict.userId !== null ? String(verdict.userId) : null;
      const scoped: string = tenantId;
      const reportFor = (error: unknown) => report(error, scoped, matched.kind);
      const id = matched.id ?? "";
      switch (matched.kind) {
        case "status": {
          const ready = options.payments ? await options.payments.ready(scoped) : { ready: false as const };
          const body: StoreStatusResponse = {
            takingOrders: ready.ready,
            takingOrdersNote: ready.ready ? null : (options.notTakingOrders ?? "Customers can look but can't pay yet: card payments aren't on."),
            photosEnabled: Boolean(options.photoStore),
            currency: options.currency ? (await options.currency(scoped)).toLowerCase() : "usd",
            openAttention: await openStoreAlertCount(options.db, scoped),
            settings: await getStoreSettings(options.db, scoped),
          };
          return json(body);
        }
        case "products": {
          await releaseLapsedStoreCheckouts(options.db, scoped);
          const limit = options.productLimit ? await options.productLimit(scoped) : undefined;
          return json({ products: await listStoreProducts(options.db, scoped), limit: limit ?? null });
        }
        case "product-create": {
          const body = await readJson(req);
          const limit = options.productLimit ? await options.productLimit(scoped) : undefined;
          return json({ product: await createStoreProduct(options.db, scoped, body, { limit: limit ?? null }) }, 201);
        }
        case "product-update": {
          if (!(await storeProductExists(options.db, scoped, id))) throw notFound();
          const body = await readJson(req);
          const product = await updateStoreProduct(options.db, scoped, id, body, { payments: options.payments, report: reportFor });
          if (!product) throw notFound();
          return json({ product });
        }
        case "product-photo": {
          if (!(await storeProductExists(options.db, scoped, id))) throw notFound();
          if (!options.photoStore) throw new HttpRefusal("unavailable", 409, "Photo uploads aren't switched on here yet.");
          if (options.photoRateLimit && !(await options.photoRateLimit(scoped))) throw new HttpRefusal("rate_limited", 429, "That's a lot of photos at once. Please wait a few minutes and try again.");
          const body = await readJson(req, Math.ceil((STORE_PHOTO_MAX_BYTES * 4) / 3) + 1024);
          const data = typeof body.data === "string" ? body.data.replace(/^data:[^,]*,/, "") : "";
          let bytes: Uint8Array;
          try {
            bytes = new Uint8Array(Buffer.from(data, "base64"));
          } catch {
            throw new HttpRefusal("invalid", 400, "That photo couldn't be read.");
          }
          if (bytes.byteLength === 0) throw new HttpRefusal("invalid", 400, "Choose a photo to upload.");
          if (bytes.byteLength > STORE_PHOTO_MAX_BYTES) throw new HttpRefusal("invalid", 413, "That photo is over 4 MB. Choose a smaller one.");
          const type = sniffStorePhoto(bytes);
          if (!type) throw new HttpRefusal("invalid", 400, "That isn't a photo we can show (use a JPEG, PNG, WebP or GIF).");
          let stored: { readonly fileId: string; readonly url: string };
          try {
            stored = await options.photoStore.put({ tenantId: scoped, bytes, contentType: type, filename: `product.${type.slice(6)}`, addedBy: userId });
          } catch (error) {
            // Storage's own refusal (the business is out of room, the file is too big): its words.
            if (error instanceof Error && error.name === "StorageError") throw new HttpRefusal("unavailable", 409, error.message);
            throw error;
          }
          const set = await setStoreProductPhoto(options.db, scoped, id, { url: stored.url, key: stored.fileId });
          if (!set) {
            await options.photoStore.delete({ tenantId: scoped, fileId: stored.fileId }).catch(reportFor);
            throw notFound();
          }
          if (set.replacedKey) await options.photoStore.delete({ tenantId: scoped, fileId: set.replacedKey }).catch(reportFor);
          return json({ product: set.product });
        }
        case "product-remove": {
          const removed = await removeStoreProduct(options.db, scoped, id, { payments: options.payments, report: reportFor });
          if (!removed) throw notFound();
          if (removed.photoKey && options.photoStore) await options.photoStore.delete({ tenantId: scoped, fileId: removed.photoKey }).catch(reportFor);
          return json({ removed: true });
        }
        case "product-release": {
          const released = await releaseHeldStock(options.db, options.payments ?? null, scoped, id, reportFor);
          if (!released) throw notFound();
          return json(released);
        }
        case "settings-save": {
          const body = await readJson(req);
          return json({ settings: await saveStoreSettings(options.db, scoped, body) });
        }
        case "orders":
          return json({ orders: await listStoreOrders(options.db, scoped) });
        case "order-sent": {
          const order = await markStoreOrderSent(options.db, scoped, id);
          if (!order) throw notFound();
          return json({ order });
        }
        case "attention": {
          const { open, handled } = await listStoreAlerts(options.db, scoped);
          return json({ open: open.map(storeAlertWire), handled: handled.map(storeAlertWire) });
        }
        case "attention-resolve": {
          const row = await resolveStoreAlert(options.db, scoped, id, userId);
          if (!row) throw notFound();
          return json({ alert: storeAlertWire(row) });
        }
      }
    } catch (error) {
      if (!expected(error)) report(error, tenantId, matched.kind);
      return failure(error);
    }
  }

  return { handle };
}


// --- The customer's side ------------------------------------------------------------

export type StoreAdmission = { readonly open: true } | { readonly open: false; readonly message: string };

export interface StoreBusiness {
  readonly name: string;
  readonly logoUrl?: string | null;
  readonly locale?: string | null;
}

export interface CreateStorePublicHandlersOptions {
  readonly db: StoreDb;
  readonly tenantId?: string;
  readonly resolveTenant?: (req: Request) => string | null | Promise<string | null>;
  /** Is this business taking requests from the public right now? A closed answer is 409 with its message. Default: open. */
  readonly admit?: (tenantId: string, req: Request) => StoreAdmission | Promise<StoreAdmission>;
  /** The Stripe seam. Absent: the store shows its products and no Check out. */
  readonly payments?: StoreCardPayments;
  readonly business: (tenantId: string) => StoreBusiness | null | Promise<StoreBusiness | null>;
  /** The thank-you page for a checkout (absolute) — where Stripe sends the customer after paying. */
  readonly thanksUrl: (checkoutId: string, tenantId: string) => string | Promise<string>;
  /** The store page (absolute) — where "Back" on Stripe's page goes. */
  readonly storeUrl: (tenantId: string) => string | Promise<string>;
  /** Your rate limit: false → 429. Default: none. */
  readonly rateLimit?: (req: Request, bucket: "read" | "checkout") => boolean | Promise<boolean>;
  /**
   * Who is checking out, for "3 open, 5 an hour" (default: `storeVisitorKey`,
   * the nearest proxy's address, an IPv6 /64). Null: the one shared
   * "unknown" visitor — never unlimited.
   */
  readonly visitorKey?: (req: Request) => string | null;
  readonly onError?: (error: unknown, context: { tenantId: string | null; route: string }) => void;
}

function publicRoute(method: string, pathname: string): { kind: StorePublicRouteKind; id: string | null } | null {
  const parts = segmentsAfter(pathname, "/v1/");
  if (!parts || parts[0] !== "store") return null;
  if (method === "GET" && parts.length === 1) return { kind: "store", id: null };
  if (method === "POST" && parts.length === 2 && parts[1] === "checkout") return { kind: "checkout", id: null };
  if (method === "GET" && parts.length === 3 && parts[1] === "checkouts") return { kind: "checkout-status", id: parts[2]! };
  return null;
}

const PUBLIC_HEADERS: Readonly<Record<string, string>> = { "referrer-policy": "no-referrer" };

export function createStorePublicHandlers(options: CreateStorePublicHandlersOptions): { handle: (req: Request) => Promise<Response> } {
  if (!options.tenantId && !options.resolveTenant) throw new Error("createStorePublicHandlers: pass tenantId or resolveTenant");
  const report = (error: unknown, tenantId: string | null, route: string) => {
    try {
      options.onError?.(error, { tenantId, route });
    } catch {
      /* never let a reporter break an answer */
    }
  };
  const answer = (body: unknown, status = 200) => json(body, status, PUBLIC_HEADERS);
  const refuse = (error: unknown) => failure(error, PUBLIC_HEADERS);

  async function handle(req: Request): Promise<Response> {
    const matched = publicRoute(req.method, new URL(req.url).pathname);
    if (!matched) return refuse(new HttpRefusal("not_found", 404, NOT_HERE));
    if (req.method === "POST" && isCrossSiteRequest(req)) return refuse(new HttpRefusal("cross_site", 403, "This request came from another site, so it was refused."));
    let tenantId: string | null = null;
    try {
      tenantId = options.resolveTenant ? await options.resolveTenant(req) : (options.tenantId ?? null);
      if (!tenantId) return refuse(new HttpRefusal("not_found", 404, "This store isn't here."));
      const scoped: string = tenantId;
      const admission = options.admit ? await options.admit(scoped, req) : { open: true as const };
      if (!admission.open) return refuse(new HttpRefusal("unavailable", 409, admission.message));
      if (options.rateLimit && !(await options.rateLimit(req, matched.kind === "checkout" ? "checkout" : "read"))) {
        return refuse(new HttpRefusal("rate_limited", 429, "Too many tries. Please wait a minute and try again."));
      }
      const business = (await options.business(scoped)) ?? { name: "" };
      if (matched.kind === "store") {
        await releaseLapsedStoreCheckouts(options.db, scoped);
        let ready = false;
        try {
          ready = options.payments ? (await options.payments.ready(scoped)).ready : false;
        } catch (error) {
          report(error, scoped, "store");
        }
        const settings = await getStoreSettings(options.db, scoped);
        const body: StorePublicResponse = {
          business: { name: business.name, logoUrl: business.logoUrl ?? null },
          takingOrders: ready,
          takingOrdersNote: ready ? null : `${business.name || "This business"} isn't taking orders online right now.`,
          // The customer's own cart (?cart=): what it holds counts as theirs, so it is never "sold out" to them.
          products: await listPublicStoreProducts(options.db, scoped, { cartId: new URL(req.url).searchParams.get("cart") }),
          locale: business.locale ?? "en-US",
          shipping: settings.fulfilment === "ship" ? { minor: settings.shippingMinor, currency: settings.currency } : null,
          pricesIncludeTax: settings.pricesIncludeTax,
        };
        return answer(body);
      }
      if (matched.kind === "checkout-status") {
        const status = await storeCheckoutStatus(options.db, scoped, matched.id ?? "");
        if (!status) return refuse(new HttpRefusal("not_found", 404, NOT_HERE));
        return answer(status);
      }
      // Check out.
      const body = await readJson(req);
      if (!options.payments) throw new StoreRefusal("unavailable", `${business.name || "This business"} isn't taking orders online right now.`);
      const thanks = (id: string) => options.thanksUrl(id, scoped);
      // The thank-you address is built once the checkout's id is known, so ask for it up front as a template.
      const probe = await thanks("__CHECKOUT__");
      const started = await startStoreCheckout(options.db, options.payments, {
        tenantId: scoped,
        cartId: body.cartId,
        lines: body.lines,
        visitorKey: (options.visitorKey ?? storeVisitorKey)(req),
        businessName: business.name,
        successUrl: (id) => probe.replace("__CHECKOUT__", encodeURIComponent(id)),
        cancelUrl: await options.storeUrl(scoped),
        report: (error) => report(error, scoped, "checkout"),
      });
      return answer({ url: started.url, checkoutId: started.checkoutId });
    } catch (error) {
      if (!expected(error)) report(error, tenantId, matched.kind);
      return refuse(error);
    }
  }

  return { handle };
}
