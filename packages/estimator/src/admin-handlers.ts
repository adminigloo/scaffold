import { and, desc, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import {
  attachComponent,
  createComponent,
  createOption,
  createOptionValue,
  createProduct,
  deactivateComponent,
  deactivateOption,
  deactivateOptionValue,
  deactivateProduct,
  detachComponent,
  getComponent,
  getProductDetail,
  getProductRow,
  listComponents,
  listProducts,
  productIdForAttachment,
  productIdForOption,
  productIdForOptionValue,
  productsUsingComponent,
  productsUsingComponents,
  reactivateComponent,
  reactivateProduct,
  reorderProducts,
  setDefaultOptionValue,
  toAdminProduct,
  toSupplyWire,
  updateAttachment,
  updateComponent,
  updateOption,
  updateOptionValue,
  updateProduct,
} from "./catalog.js";
import {
  addEstimateItem,
  archiveEstimate,
  createEstimate,
  duplicateEstimate,
  getEstimateDetail,
  getEstimateRow,
  removeEstimateItem,
  searchEstimates,
  setEstimateStatus,
  unarchiveEstimate,
  updateEstimate,
  updateEstimateItem,
} from "./estimates.js";
import { emitEvents, loadSnapshots, type EstimatorActor, type EstimatorEvent, type EstimatorEventListener } from "./events.js";
import {
  createThrottle,
  HttpError,
  isCrossSiteRequest,
  MAX_PHOTO_BODY_CHARS,
  NOT_FOUND_MESSAGE,
  readJsonBody,
  safeDecode,
  toWireError,
} from "./http.js";
import { issueClientKey, listClientKeys, revokeClientKey, toKeyWire, updateClientKey } from "./keys.js";
import type { EstimatorPermission } from "./permissions.js";
import { attachStaffPhoto, removeEstimatePhoto, type EstimatorPhotoStore } from "./photos.js";
import { previewProductPrice, priceProduct } from "./price-product.js";
import { exampleInputsFor, inputsSummary } from "./recipes.js";
import { expireQuotes, issueQuoteToken, resendQuote, reviseQuote, sendQuote } from "./quotes.js";
import { loadSampleCatalog } from "./sample.js";
import { estimatorClientKeys, estimatorComponents, estimatorProductComponents, estimatorProducts, estimatorTakeoffs } from "./schema.js";
import { COMPANY_OWNED_ESTIMATOR_SETTINGS, resolveEstimatorSettings, validCeiling, type EstimatorCompany } from "./company.js";
import { estimatorReady, formatMoney, toSettingsWire, updateEstimatorSettings, type EstimatorSettings } from "./settings.js";
import { utcDayStart } from "./takeoff-run.js";
import { EstimatorInputError, type EstimatorDb, type ProductRow } from "./types.js";
import type {
  AdminNoticeCode,
  AdminProduct,
  AdminStatus,
  ConvertResponse,
  EstimateDetail,
  EstimateFilter,
  EstimateListResponse,
  EstimateMutationResponse,
  EstimateSnapshot,
  EstimatorDelivery,
  ExpireResponse,
  IssuedKeyResponse,
  LinkedInvoice,
  LinkedVisit,
  PreviewResponse,
  ProductExample,
  QuoteLinkResponse,
  SampleCatalogResponse,
  SupplyMutationResponse,
  UsageResponse,
} from "./wire.js";

/**
 * The HTTP surface the staff widgets (`<EstimatorAdmin>`, `<PriceBook>`,
 * `<EstimatesQueue>`, `<EstimateEditor>`, `<EmbedKeys>`,
 * `<EstimatorSettings>`) speak: every route under `{base}/v1/admin/`, one
 * `handle(req)` routed by path suffix (section 8.3 of the 0.3 contract).
 *
 *   // app/api/admin/estimator/[...path]/route.ts
 *   const { handle } = createEstimatorAdminHandlers({ db, tenantId, authorize });
 *   export { handle as GET, handle as POST, handle as OPTIONS };
 *
 * EVERY ROUTE ASKS `authorize(req, permission, tenantId)` for exactly one of
 * the package's permission keys (`ESTIMATOR_ADMIN_ROUTE_PERMISSIONS`): `false`
 * is 403, a `Response` (a host's 401) is returned as it is, `true` or
 * `{ userId }` passes — and `userId` is who the event says acted. A route that
 * returns products, supplies, estimates, a preview or the status ALSO asks
 * `estimator.costs.view` once; any answer but yes strips every cost, labor
 * rate and margin (staff who quote see prices), and that second answer is
 * never returned as a response.
 *
 * NEVER CROSS-ORIGIN. No CORS headers, ever, and every POST must pass the
 * same-site check: a staff session cookie must not be usable from another site.
 */

export type AuthorizeResult = boolean | { userId?: string | number | null } | Response;

/**
 * Something in the price book changed through the admin (review RL-02): a
 * host that mirrors the price book into its own system hears it here, after
 * the change is saved. Awaited and contained, like an event listener.
 */
export interface PriceBookChange {
  tenantId: string;
  kind: "product" | "supply" | "sample";
  /** The product or supply; null for the sample catalog. */
  id: string | null;
  action: "created" | "updated" | "retired" | "restored" | "loaded";
  userId: string | null;
}

/** Why photo reading is off, when the host knows (the status notice says so in words an owner can act on). */
export type PhotoReadingOffReason = "not_installed" | "no_key" | "model_unpriced";

/** The draft keys a caller WITHOUT `estimator.costs.view` may preview: words and the range, nothing a cost can be read from (review ADV-3). */
const PRICE_ONLY_DRAFT_KEYS: ReadonlySet<string> = new Set([
  "name",
  "category",
  "description",
  "showInEstimator",
  "isEstimatable",
  "allowMultiple",
  "multipleLabel",
  "maxQuantity",
  "recipeConfig",
  "rangeMode",
  "contingencyBp",
  "estimateLowBp",
  "estimateHighBp",
]);

export interface CreateEstimatorAdminHandlersOptions {
  db: EstimatorDb;
  tenantId?: string;
  resolveTenant?: (req: Request) => string | null | Promise<string | null>;
  /** Your auth: may this request do `permission` for `tenantId`? */
  authorize: (req: Request, permission: EstimatorPermission, tenantId: string) => AuthorizeResult | Promise<AuthorizeResult>;
  photoStore?: EstimatorPhotoStore;
  /** The public side has a takeoff model (for the status's "reading is off" notice). */
  photoReading?: boolean;
  /**
   * Why there is no takeoff model, when you know (review EST-R12): "not
   * installed" (this site was built without photo reading — adding a key
   * changes nothing), "no key", or "model_unpriced". The notice tells the
   * owner what to do about each.
   */
  photoReadingOff?: PhotoReadingOffReason;
  /**
   * Who reads the notices about the SITE's own setup — no AI key, no file
   * storage (Tenancy 2a review T2A-BO-05):
   *
   *   "developer" (default)  the business owns the deployment, so a notice
   *                          names the fix ("ANTHROPIC_API_KEY. Ask your
   *                          developer to add it").
   *   "company"              one company of many on someone else's site: it
   *                          can't set an environment variable and has no
   *                          developer, so it reads only what that means for
   *                          it ("Photo reading isn't available on this site
   *                          yet"). The site's operator sees the gaps, with
   *                          their fixes, on the site's own setup page.
   */
  siteNotices?: "developer" | "company";
  /** After a price-book change is saved (a host mirroring the price book). Awaited; a throw is reported to `onError`, never the response. */
  onPriceBookChange?: (change: PriceBookChange) => void | Promise<void>;
  onEvent?: EstimatorEventListener;
  onEventError?: (error: unknown, event: EstimatorEvent) => void;
  /** Enables "Copy the quote link". May be async (Tenancy 2a: the host looks the company's web address up). */
  quoteUrl?: (token: string, tenantId: string) => string | Promise<string>;
  /** Default `{ emails: Boolean(onEvent), followUps: Boolean(onEvent), note: null }`. */
  delivery?: (tenantId: string) => EstimatorDelivery | Promise<EstimatorDelivery>;
  links?: {
    /** May be async (Tenancy 2a). */
    bookVisitUrl?: (estimate: EstimateSnapshot, tenantId: string) => string | null | Promise<string | null>;
    visits?: (estimateId: string, tenantId: string) => Promise<LinkedVisit[]>;
    invoice?: (estimateId: string, tenantId: string) => Promise<LinkedInvoice | null>;
  };
  /** Turn an approved estimate into an invoice. Owns its transaction and calls markEstimateConverted in it. */
  convertToInvoice?: (input: { tenantId: string; estimateId: string; userId: string | null }) => Promise<LinkedInvoice>;
  /**
   * The host's INVOICE permission, asked beside the estimator's own (Tenancy 2a
   * review SEC-2A-02). "Turn into an invoice" WRITES AN INVOICE, so the
   * estimator's `estimator.estimates.manage` is not enough on its own: a
   * person whose role may quote but not bill (a single business's default
   * "CS agent"; a company member whose invoice rights an owner took away)
   * used to raise invoices by converting accepted quotes. With this seam:
   *
   *   "manage"  asked before converting. Anything but yes is 403 "You can't
   *             raise invoices"; a Response (a host's 401) is returned as is.
   *   "view"    asked when an estimate's page is built: without it the linked
   *             invoice's number, status and link are left off, and "Turn into
   *             an invoice" isn't offered unless "manage" said yes.
   *
   * Same answers as `authorize`. Without it, 0.3's behaviour (the
   * estimator's own permission decides).
   */
  invoiceAccess?: (req: Request, need: "view" | "manage", tenantId: string) => AuthorizeResult | Promise<AuthorizeResult>;
  /** The deployment's public estimator base, for the EmbedKeys snippet. */
  embedBaseUrl?: string;
  /** Default true: the estimates list expires overdue quotes (once a minute per tenant). */
  sweepExpired?: boolean;
  onError?: (error: unknown, context: { tenantId: string | null; route: string }) => void;
  now?: () => Date;
  /**
   * The business as its customers know it, from the host's company profile
   * (Tenancy 2a, D5): every route reads settings through
   * `resolveEstimatorSettings`, so the name, contact, zone, colour and logo
   * are the company's. A throw is reported and that request uses the stored
   * settings.
   */
  company?: (tenantId: string) => EstimatorCompany | null | Promise<EstimatorCompany | null>;
  /** Where the owner changes the company-owned fields (D6), e.g. "/settings/company#details". Default null. */
  companySettingsHref?: string | null;
  /**
   * The most a day of photo reading may cost per business on this site, in
   * cents (D14). The budget shown and spent is `min(the setting, this)`, and a
   * save above it is refused with the sentence the owner reads.
   */
  aiBudgetCeilingCents?: number;
}

export interface EstimatorAdminHandlers {
  handle: (req: Request) => Promise<Response>;
}

export type AdminRouteKind =
  | "status"
  | "usage"
  | "settings-get"
  | "settings-update"
  | "products-list"
  | "product-create"
  | "products-reorder"
  | "products-preview"
  | "product-get"
  | "product-update"
  | "product-deactivate"
  | "product-reactivate"
  | "supply-attach"
  | "attachment-update"
  | "attachment-remove"
  | "option-create"
  | "option-update"
  | "option-remove"
  | "option-value-create"
  | "option-value-update"
  | "option-value-default"
  | "option-value-remove"
  | "supplies-list"
  | "supply-create"
  | "supply-update"
  | "supply-deactivate"
  | "supply-reactivate"
  | "sample-catalog"
  | "estimates-list"
  | "estimate-create"
  | "estimate-get"
  | "estimate-update"
  | "line-add"
  | "line-update"
  | "line-remove"
  | "photo-add"
  | "photo-remove"
  | "quote-send"
  | "quote-resend"
  | "quote-revise"
  | "estimate-status"
  | "quote-link"
  | "estimate-archive"
  | "estimate-unarchive"
  | "estimate-duplicate"
  | "estimate-convert"
  | "expire"
  | "keys-list"
  | "key-issue"
  | "key-update"
  | "key-revoke";

/** The permission each route asks for — the contract's table, as data (the tests read it back). */
export const ESTIMATOR_ADMIN_ROUTE_PERMISSIONS: Readonly<Record<AdminRouteKind, EstimatorPermission>> = Object.freeze({
  status: "estimator.view",
  usage: "estimator.costs.view",
  "settings-get": "estimator.view",
  "settings-update": "estimator.settings.manage",
  "products-list": "estimator.view",
  "product-create": "estimator.pricebook.manage",
  "products-reorder": "estimator.pricebook.manage",
  "products-preview": "estimator.view",
  "product-get": "estimator.view",
  "product-update": "estimator.pricebook.manage",
  "product-deactivate": "estimator.pricebook.manage",
  "product-reactivate": "estimator.pricebook.manage",
  "supply-attach": "estimator.pricebook.manage",
  "attachment-update": "estimator.pricebook.manage",
  "attachment-remove": "estimator.pricebook.manage",
  "option-create": "estimator.pricebook.manage",
  "option-update": "estimator.pricebook.manage",
  "option-remove": "estimator.pricebook.manage",
  "option-value-create": "estimator.pricebook.manage",
  "option-value-update": "estimator.pricebook.manage",
  "option-value-default": "estimator.pricebook.manage",
  "option-value-remove": "estimator.pricebook.manage",
  "supplies-list": "estimator.costs.view",
  "supply-create": "estimator.pricebook.manage",
  "supply-update": "estimator.pricebook.manage",
  "supply-deactivate": "estimator.pricebook.manage",
  "supply-reactivate": "estimator.pricebook.manage",
  "sample-catalog": "estimator.pricebook.manage",
  "estimates-list": "estimator.view",
  "estimate-create": "estimator.estimates.manage",
  "estimate-get": "estimator.view",
  "estimate-update": "estimator.estimates.manage",
  "line-add": "estimator.estimates.manage",
  "line-update": "estimator.estimates.manage",
  "line-remove": "estimator.estimates.manage",
  "photo-add": "estimator.estimates.manage",
  "photo-remove": "estimator.estimates.manage",
  "quote-send": "estimator.estimates.manage",
  "quote-resend": "estimator.estimates.manage",
  "quote-revise": "estimator.estimates.manage",
  "estimate-status": "estimator.estimates.manage",
  "quote-link": "estimator.estimates.manage",
  "estimate-archive": "estimator.estimates.manage",
  "estimate-unarchive": "estimator.estimates.manage",
  "estimate-duplicate": "estimator.estimates.manage",
  "estimate-convert": "estimator.estimates.manage",
  expire: "estimator.estimates.manage",
  "keys-list": "estimator.settings.manage",
  "key-issue": "estimator.settings.manage",
  "key-update": "estimator.settings.manage",
  "key-revoke": "estimator.settings.manage",
});

/** Routes whose answer can carry a cost: they also ask `estimator.costs.view`. */
const COST_ROUTES: ReadonlySet<AdminRouteKind> = new Set<AdminRouteKind>([
  "status",
  "settings-get",
  "settings-update",
  "products-list",
  "product-create",
  "products-reorder",
  "products-preview",
  "product-get",
  "product-update",
  "product-deactivate",
  "product-reactivate",
  "supply-attach",
  "attachment-update",
  "attachment-remove",
  "option-create",
  "option-update",
  "option-remove",
  "option-value-create",
  "option-value-update",
  "option-value-default",
  "option-value-remove",
  "supply-create",
  "supply-update",
  "supply-deactivate",
  "supply-reactivate",
  "estimate-create",
  "estimate-get",
  "estimate-update",
  "line-add",
  "line-update",
  "line-remove",
  "photo-add",
  "photo-remove",
  "quote-send",
  "quote-resend",
  "quote-revise",
  "estimate-status",
  "estimate-archive",
  "estimate-unarchive",
  "estimate-duplicate",
  "estimate-convert",
]);

interface AdminRoute {
  kind: AdminRouteKind;
  id?: string;
  sub?: string;
}

/** Literal segments (`reorder`, `preview`) match before `:id`. */
function route(method: string, pathname: string): AdminRoute | null {
  const path = pathname.replace(/\/+$/, "");
  const at = path.lastIndexOf("/v1/admin/");
  if (at < 0) return null;
  const parts = path.slice(at + "/v1/admin/".length).split("/").map(safeDecode);
  if (parts.some((part) => part === "")) return null;
  const [head, id, action, sub, last] = parts;
  const get = method === "GET";
  const post = method === "POST";
  const n = parts.length;
  switch (head) {
    case "status":
      return get && n === 1 ? { kind: "status" } : null;
    case "usage":
      return get && n === 1 ? { kind: "usage" } : null;
    case "settings":
      return n === 1 ? (get ? { kind: "settings-get" } : post ? { kind: "settings-update" } : null) : null;
    case "sample-catalog":
      return post && n === 1 ? { kind: "sample-catalog" } : null;
    case "expire":
      return post && n === 1 ? { kind: "expire" } : null;
    case "products": {
      if (n === 1) return get ? { kind: "products-list" } : post ? { kind: "product-create" } : null;
      if (n === 2 && id === "reorder") return post ? { kind: "products-reorder" } : null;
      if (n === 2 && id === "preview") return post ? { kind: "products-preview" } : null;
      if (n === 2) return get ? { kind: "product-get", id: id as string } : post ? { kind: "product-update", id: id as string } : null;
      if (!post) return null;
      if (n === 3) {
        if (action === "deactivate") return { kind: "product-deactivate", id: id as string };
        if (action === "reactivate") return { kind: "product-reactivate", id: id as string };
        if (action === "supplies") return { kind: "supply-attach", id: id as string };
        if (action === "options") return { kind: "option-create", id: id as string };
        return null;
      }
      if (n === 4 && action === "supplies") return { kind: "attachment-update", id: id as string, sub: sub as string };
      if (n === 5 && action === "supplies" && last === "remove") return { kind: "attachment-remove", id: id as string, sub: sub as string };
      return null;
    }
    case "options": {
      if (!post) return null;
      if (n === 2) return { kind: "option-update", id: id as string };
      if (n === 3 && action === "remove") return { kind: "option-remove", id: id as string };
      if (n === 3 && action === "values") return { kind: "option-value-create", id: id as string };
      return null;
    }
    case "option-values": {
      if (!post) return null;
      if (n === 2) return { kind: "option-value-update", id: id as string };
      if (n === 3 && action === "default") return { kind: "option-value-default", id: id as string };
      if (n === 3 && action === "remove") return { kind: "option-value-remove", id: id as string };
      return null;
    }
    case "supplies": {
      if (n === 1) return get ? { kind: "supplies-list" } : post ? { kind: "supply-create" } : null;
      if (!post) return null;
      if (n === 2) return { kind: "supply-update", id: id as string };
      if (n === 3 && action === "deactivate") return { kind: "supply-deactivate", id: id as string };
      if (n === 3 && action === "reactivate") return { kind: "supply-reactivate", id: id as string };
      return null;
    }
    case "estimates": {
      if (n === 1) return get ? { kind: "estimates-list" } : post ? { kind: "estimate-create" } : null;
      if (n === 2) return get ? { kind: "estimate-get", id: id as string } : post ? { kind: "estimate-update", id: id as string } : null;
      if (!post) return null;
      if (n === 3) {
        const kinds: Record<string, AdminRouteKind> = {
          items: "line-add",
          photos: "photo-add",
          send: "quote-send",
          resend: "quote-resend",
          revise: "quote-revise",
          status: "estimate-status",
          link: "quote-link",
          archive: "estimate-archive",
          unarchive: "estimate-unarchive",
          duplicate: "estimate-duplicate",
          convert: "estimate-convert",
        };
        const kind = kinds[action as string];
        return kind ? { kind, id: id as string } : null;
      }
      if (n === 4 && action === "items") return { kind: "line-update", id: id as string, sub: sub as string };
      if (n === 5 && action === "items" && last === "remove") return { kind: "line-remove", id: id as string, sub: sub as string };
      if (n === 5 && action === "photos" && last === "remove") return { kind: "photo-remove", id: id as string, sub: sub as string };
      return null;
    }
    case "keys": {
      if (n === 1) return get ? { kind: "keys-list" } : post ? { kind: "key-issue" } : null;
      if (!post) return null;
      if (n === 2) return { kind: "key-update", id: id as string };
      if (n === 3 && action === "revoke") return { kind: "key-revoke", id: id as string };
      return null;
    }
    default:
      return null;
  }
}

// --- Bodies (the wire's names) ----------------------------------------------------------

const statusBodySchema = z.object({
  status: z.enum(["approved", "rejected", "draft"], { message: "Pick yes, no or reopen." }),
  note: z.string().trim().max(1000).nullish(),
  notify: z.boolean().optional(),
});
const reorderBodySchema = z.object({ ids: z.array(z.string().min(1).max(200)).max(500) });
const attachBodySchema = z.object({
  supplyId: z.string().min(1).max(200),
  quantityMilli: z.number().int().min(1).max(100_000_000),
  per: z.string().trim().min(1).max(40).optional(),
  roundUp: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
});
const photoBodySchema = z.object({ imageBase64: z.string().max(MAX_PHOTO_BODY_CHARS), mediaType: z.string().max(40) });
const issueKeyBodySchema = z.object({ label: z.string(), allowedOrigins: z.array(z.string()).optional() });
const sampleBodySchema = z.object({
  trade: z.enum(["lawn", "cleaning", "ramps"], { message: "Pick lawn care, cleaning or ramps." }).optional(),
});

const HOUR_MS = 60 * 60 * 1000;

/** The "photo reading is off" notice, in words that say what the owner can do about it — or, for a company on someone else's site, only what it means. */
export function readingOffMessage(reason: PhotoReadingOffReason | undefined, audience: "developer" | "company" = "developer"): string {
  if (audience === "company") {
    return "Photo reading isn't available on this site yet, so customers are asked to count and measure themselves.";
  }
  switch (reason) {
    case "not_installed":
      return "Photo reading isn't part of this site. Ask your developer to add it (pnpm dlx @adminigloo/create-app add ai).";
    case "no_key":
      return "Photo reading is off: no AI key is connected (ANTHROPIC_API_KEY). Ask your developer to add it.";
    case "model_unpriced":
      return "Photo reading is off: the AI model set for it has no price, so its cost couldn't be counted. Ask your developer to check it.";
    default:
      return "Photo reading is off: no AI key is connected.";
  }
}

export function createEstimatorAdminHandlers(options: CreateEstimatorAdminHandlersOptions): EstimatorAdminHandlers {
  if (typeof options.authorize !== "function") {
    throw new Error("createEstimatorAdminHandlers: pass authorize (your permission check)");
  }
  const clock = () => options.now?.() ?? new Date();
  const sweep = createThrottle(60_000);
  const notFound = () => new HttpError("not_found", NOT_FOUND_MESSAGE);

  function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "cache-control": "no-store", "content-type": "application/json; charset=utf-8" },
    });
  }
  function failure(error: unknown, context: { tenantId: string | null; route: string }): Response {
    const wire = toWireError(error);
    if (wire.unexpected) {
      try {
        if (options.onError) options.onError(error, context);
        else console.error("[@adminigloo/estimator] unexpected admin error", context, error);
      } catch {
        /* a broken reporter must not change the answer */
      }
    }
    return json({ error: { code: wire.code, message: wire.message, ...(wire.issues ? { issues: wire.issues } : {}) } }, wire.status);
  }

  async function delivery(tenantId: string): Promise<EstimatorDelivery> {
    if (options.delivery) return options.delivery(tenantId);
    const on = Boolean(options.onEvent);
    return { emails: on, followUps: on, note: null };
  }

  /**
   * What a product prices at for an everyday answer ("3 steps: $6,924,
   * margin 28.6%"), for the price book's list (review EST-R14). Null for a
   * product priced by quote, a retired one, or one that can't be priced yet.
   */
  async function exampleFor(
    tenantId: string,
    product: ProductRow,
    recipe: Parameters<typeof exampleInputsFor>[0],
    config: Parameters<typeof exampleInputsFor>[1],
    settings: EstimatorSettings,
    includeCosts: boolean,
  ): Promise<ProductExample | null> {
    if (!product.isActive || !product.isEstimatable) return null;
    const inputs = exampleInputsFor(recipe, config);
    try {
      const priced = await priceProduct(options.db, tenantId, { productId: product.id, inputs }, { audience: "staff", settings });
      if (priced.status !== "priced") return null;
      return { label: inputsSummary(recipe, config, inputs), price: priced.build.point, marginBp: includeCosts ? priced.build.marginBp : null };
    } catch {
      return null;
    }
  }

  async function adminProduct(tenantId: string, id: string, settings: EstimatorSettings, includeCosts: boolean): Promise<AdminProduct> {
    const detail = await getProductDetail(options.db, tenantId, id);
    if (!detail) throw notFound();
    const example = await exampleFor(tenantId, detail.product, detail.recipe, detail.recipeConfig, settings, includeCosts);
    return toAdminProduct(detail, { settings, includeCosts, example });
  }

  /** Tell the host about a saved price-book change. Contained: the change is already saved. */
  async function announce(change: PriceBookChange): Promise<void> {
    if (!options.onPriceBookChange) return;
    try {
      await options.onPriceBookChange(change);
    } catch (error) {
      try {
        if (options.onError) options.onError(error, { tenantId: change.tenantId, route: "price-book-change" });
        else console.error("[@adminigloo/estimator] a price-book listener failed", error);
      } catch {
        /* a broken reporter must not fail the request */
      }
    }
  }

  async function adminProducts(tenantId: string, settings: EstimatorSettings, includeCosts: boolean, includeInactive: boolean) {
    const rows = await listProducts(options.db, tenantId, { includeInactive });
    const out: AdminProduct[] = [];
    for (const row of rows) out.push(await adminProduct(tenantId, row.id, settings, includeCosts));
    return out;
  }

  /**
   * What the caller may do with invoices (SEC-2A-02), asked at most once per
   * request: an estimate's page and the convert route both read it.
   */
  const invoiceRightsMemo = new WeakMap<Request, Promise<{ view: boolean; manage: boolean; refusal: Response | null }>>();
  function invoiceRights(req: Request, tenantId: string): Promise<{ view: boolean; manage: boolean; refusal: Response | null }> {
    const access = options.invoiceAccess;
    if (!access) return Promise.resolve({ view: true, manage: true, refusal: null });
    const known = invoiceRightsMemo.get(req);
    if (known) return known;
    const ask = async (need: "view" | "manage"): Promise<{ yes: boolean; refusal: Response | null }> => {
      try {
        const answer = await access(req, need, tenantId);
        if (answer instanceof Response) return { yes: false, refusal: answer };
        return { yes: answer === true || (typeof answer === "object" && answer !== null), refusal: null };
      } catch (error) {
        try {
          options.onError?.(error, { tenantId, route: "invoice-access" });
        } catch {
          /* contained */
        }
        return { yes: false, refusal: null };
      }
    };
    const pending = Promise.all([ask("view"), ask("manage")]).then(([view, manage]) => ({
      view: view.yes,
      manage: manage.yes,
      refusal: manage.refusal,
    }));
    invoiceRightsMemo.set(req, pending);
    return pending;
  }

  async function estimateDetail(
    req: Request,
    tenantId: string,
    id: string,
    includeCosts: boolean,
    now: Date,
    settings: Pick<EstimatorSettings, "locale">,
  ): Promise<EstimateDetail> {
    const row = await getEstimateRow(options.db, tenantId, id);
    if (!row) throw notFound();
    let bookVisitUrl: string | null = null;
    if (options.links?.bookVisitUrl && (row.status === "approved" || row.status === "converted")) {
      const snapshot = (await loadSnapshots(options.db, tenantId, [id])).get(id);
      if (snapshot) bookVisitUrl = await options.links.bookVisitUrl(snapshot, tenantId);
    }
    const rights = await invoiceRights(req, tenantId);
    const detail = await getEstimateDetail(options.db, tenantId, id, {
      includeCosts,
      now,
      locale: settings.locale,
      ...(options.photoStore ? { photoStore: options.photoStore } : {}),
      // "Turn into an invoice" only for someone who may raise invoices (SEC-2A-02).
      seams: { convert: Boolean(options.convertToInvoice) && rights.manage, bookVisit: bookVisitUrl !== null, copyLink: Boolean(options.quoteUrl) },
    });
    if (!detail) throw notFound();
    const visits = options.links?.visits ? await options.links.visits(id, tenantId) : [];
    // The invoice an estimate became is shown only to someone who may see invoices.
    const invoice = options.links?.invoice && rights.view ? await options.links.invoice(id, tenantId) : null;
    return { ...detail, links: { bookVisitUrl, visits, invoice } };
  }

  /**
   * The live products a customer would be quoted $0 for, and those whose
   * labor is free (review EST-R01, EST-R06), by name. A product is UNPRICED
   * when nothing can give it a price: no supply with a cost, no lump cost, no
   * minimum, and no labor at a rate. FREE LABOR is labor hours at a $0 rate on
   * a product that is otherwise priced — a bigger error than the 2K variance
   * the founder started from, and invisible unless the owner reads every
   * breakdown line.
   */
  async function pricingGaps(tenantId: string, settings: EstimatorSettings): Promise<{ unpriced: string[]; freeLabor: string[] }> {
    const db = options.db;
    const live = (await db
      .select()
      .from(estimatorProducts)
      .where(and(eq(estimatorProducts.tenantId, tenantId), eq(estimatorProducts.isActive, true), eq(estimatorProducts.isEstimatable, true)))
      .orderBy(estimatorProducts.sortOrder, estimatorProducts.name)) as ProductRow[];
    if (live.length === 0) return { unpriced: [], freeLabor: [] };
    const costed = (await db
      .select({ productId: estimatorProductComponents.productId })
      .from(estimatorProductComponents)
      .innerJoin(estimatorComponents, eq(estimatorComponents.id, estimatorProductComponents.componentId))
      .where(
        and(
          inArray(
            estimatorProductComponents.productId,
            live.map((p) => p.id),
          ),
          eq(estimatorProductComponents.isActive, true),
          eq(estimatorComponents.isActive, true),
          eq(estimatorComponents.tenantId, tenantId),
          sql`${estimatorComponents.unitCost} > 0`,
        ),
      )) as Array<{ productId: string }>;
    const withSupplies = new Set(costed.map((row) => row.productId));
    const unpriced: string[] = [];
    const freeLabor: string[] = [];
    for (const p of live) {
      const rate = p.laborRateCents ?? settings.defaultLaborRateCents;
      const hours = p.laborHoursPerUnitMilli + p.laborSetupHoursMilli;
      const lump = p.basePrice + (p.pricePerSqFt ?? 0) + (p.pricePerLinearFt ?? 0) + p.laborCost;
      const pricedSomehow = withSupplies.has(p.id) || lump > 0 || p.minimumCharge > 0 || (hours > 0 && rate > 0);
      if (!pricedSomehow) unpriced.push(p.name);
      else if (hours > 0 && rate === 0) freeLabor.push(p.name);
    }
    return { unpriced, freeLabor };
  }

  async function status(tenantId: string, settings: EstimatorSettings, includeCosts: boolean, now: Date): Promise<AdminStatus> {
    const db = options.db;
    const [products] = (await db
      .select({
        active: sql<number>`count(*) filter (where ${estimatorProducts.isActive})::int`,
        public: sql<number>`count(*) filter (where ${estimatorProducts.isActive} and ${estimatorProducts.showInEstimator})::int`,
      })
      .from(estimatorProducts)
      .where(eq(estimatorProducts.tenantId, tenantId))) as Array<{ active: number | string; public: number | string }>;
    const [keys] = (await db
      .select({
        active: sql<number>`count(*)::int`,
        withoutOrigins: sql<number>`count(*) filter (where jsonb_array_length(${estimatorClientKeys.allowedOrigins}) = 0)::int`,
      })
      .from(estimatorClientKeys)
      .where(and(eq(estimatorClientKeys.tenantId, tenantId), isNull(estimatorClientKeys.revokedAt)))) as Array<{
      active: number | string;
      withoutOrigins: number | string;
    }>;
    const active = Number(products?.active ?? 0);
    const withoutOrigins = Number(keys?.withoutOrigins ?? 0);
    const sending = await delivery(tenantId);
    const attach = settings.photosEnabled && Boolean(options.photoStore);
    const reading =
      settings.photosEnabled && options.photoReading === true && settings.aiDailyBudgetCents > 0 && settings.aiPerRequesterDaily > 0;

    let spend: AdminStatus["spend"] = null;
    if (includeCosts) {
      const dayStart = utcDayStart(now);
      const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
      const [row] = (await db
        .select({
          readingsToday: sql<number>`count(*) filter (where ${estimatorTakeoffs.createdAt} >= ${dayStart.toISOString()}::timestamptz)::int`,
          costToday: sql<number>`coalesce(sum(${estimatorTakeoffs.costMicros}) filter (where ${estimatorTakeoffs.createdAt} >= ${dayStart.toISOString()}::timestamptz), 0)::bigint`,
          readingsMonth: sql<number>`count(*)::int`,
          costMonth: sql<number>`coalesce(sum(${estimatorTakeoffs.costMicros}), 0)::bigint`,
        })
        .from(estimatorTakeoffs)
        .where(
          and(
            eq(estimatorTakeoffs.tenantId, tenantId),
            gte(estimatorTakeoffs.createdAt, monthStart),
            inArray(estimatorTakeoffs.status, ["read", "unreadable", "failed"]),
          ),
        )) as Array<Record<string, number | string>>;
      spend = {
        readingsToday: Number(row?.["readingsToday"] ?? 0),
        costTodayMicros: Number(row?.["costToday"] ?? 0),
        readingsMonth: Number(row?.["readingsMonth"] ?? 0),
        costMonthMicros: Number(row?.["costMonth"] ?? 0),
        dailyBudgetCents: settings.aiDailyBudgetCents,
      };
    }

    const notices: Array<{ code: AdminNoticeCode; message: string }> = [];
    if (!estimatorReady(settings)) {
      // Not a reminder but a gate (review EST-R02): nothing reaches a customer until this is done.
      notices.push({
        code: "settings_not_saved",
        // Tenancy 2a, D6: with the name coming from the company profile there
        // is no name to save here, and telling an owner to go and find one on
        // a screen that shows it read-only sends them in a circle. They save
        // the tax rate; the name is already the company's.
        message: settings.managedByCompany
          ? "Your estimate page is closed, and quotes can't be sent, until you save your tax rate in Estimate settings."
          : "Your estimate page is closed, and quotes can't be sent, until you save your business name and tax rate in Settings.",
      });
    }
    if (active === 0) {
      notices.push({ code: "no_products", message: "Add a product, or load the sample catalog, before you share your estimator." });
    } else if (Number(products?.public ?? 0) === 0) {
      notices.push({
        code: "nothing_public",
        message: 'None of your products is on your website yet. When a product\'s prices are yours, turn on "Show on your website" in it.',
      });
    }
    const { unpriced, freeLabor } = await pricingGaps(tenantId, settings);
    if (unpriced.length > 0) {
      notices.push({
        code: "products_unpriced",
        message:
          unpriced.length === 1
            ? `${unpriced[0]} prices at $0. Add its supplies or a labor rate; until then customers are asked to call for a price.`
            : `${unpriced.join(", ")} price at $0. Add their supplies or a labor rate; until then customers are asked to call for a price.`,
      });
    }
    if (freeLabor.length > 0) {
      notices.push({
        code: "labor_rate_zero",
        message:
          freeLabor.length === 1
            ? `${freeLabor[0]} has labor hours but no labor rate, so its labor is priced at $0. Set a rate on the product or a default in Settings.`
            : `${freeLabor.join(", ")} have labor hours but no labor rate, so their labor is priced at $0. Set a rate on each product or a default in Settings.`,
      });
    }
    if (!settings.saved && settings.taxRateBp === 825) {
      // Not "still the 8.25% default": the form shows the field EMPTY until it is
      // saved (the owner types the rate they charge), so quoting a number the
      // screen doesn't show reads as a contradiction (review T2A-BO-06).
      notices.push({ code: "tax_default", message: "Your sales tax rate isn't saved yet. Enter it in Estimate settings." });
    }
    if (!sending.emails) notices.push({ code: "emails_off", message: "Customers won't get emails: email sending isn't set up." });
    if (settings.photosEnabled && !options.photoStore) {
      notices.push({
        code: "photos_no_store",
        message:
          options.siteNotices === "company"
            ? "Photos customers send can't be kept on this site yet, so they aren't saved with the estimate."
            : "Photos can't be kept: no file storage is connected.",
      });
    }
    if (settings.photosEnabled && options.photoReading !== true) {
      notices.push({ code: "reading_off", message: readingOffMessage(options.photoReadingOff, options.siteNotices ?? "developer") });
    }
    if (withoutOrigins > 0) {
      notices.push({
        code: "keys_without_origins",
        // CONTRACT: "{n} website key{s} work on any website" reads "1 website key
        // works … to it" in the singular.
        message:
          withoutOrigins === 1
            ? "1 website key works on any website. Add your site's address to it."
            : `${withoutOrigins} website keys work on any website. Add your site's address to them.`,
      });
    }
    return {
      settingsSaved: settings.saved,
      products: { active, public: Number(products?.public ?? 0) },
      keys: { active: Number(keys?.active ?? 0), withoutOrigins },
      delivery: sending,
      photos: { attach, reading },
      spend,
      embedBaseUrl: options.embedBaseUrl ?? null,
      notices,
      aiBudgetCeilingCents: settings.aiBudgetCeilingCents,
    };
  }

  async function usage(tenantId: string, days: number, now: Date): Promise<UsageResponse> {
    const db = options.db;
    const start = new Date(utcDayStart(now).getTime() - (days - 1) * 24 * HOUR_MS);
    const rows = (await db
      .select({
        date: sql<string>`to_char(${estimatorTakeoffs.createdAt} at time zone 'UTC', 'YYYY-MM-DD')`,
        readings: sql<number>`count(*)::int`,
        costMicros: sql<number>`coalesce(sum(${estimatorTakeoffs.costMicros}), 0)::bigint`,
      })
      .from(estimatorTakeoffs)
      .where(
        and(
          eq(estimatorTakeoffs.tenantId, tenantId),
          gte(estimatorTakeoffs.createdAt, start),
          inArray(estimatorTakeoffs.status, ["read", "unreadable", "failed"]),
        ),
      )
      .groupBy(sql`1`)) as Array<{ date: string; readings: number | string; costMicros: number | string }>;
    const [latest] = (await db
      .select({ model: estimatorTakeoffs.model })
      .from(estimatorTakeoffs)
      .where(and(eq(estimatorTakeoffs.tenantId, tenantId), sql`${estimatorTakeoffs.model} is not null`))
      .orderBy(desc(estimatorTakeoffs.createdAt))
      .limit(1)) as Array<{ model: string | null }>;
    const byDate = new Map(rows.map((row) => [row.date, row]));
    const list: UsageResponse["days"] = [];
    for (let i = 0; i < days; i += 1) {
      const date = new Date(start.getTime() + i * 24 * HOUR_MS).toISOString().slice(0, 10);
      const row = byDate.get(date);
      list.push({ date, readings: Number(row?.readings ?? 0), costMicros: Number(row?.costMicros ?? 0) });
    }
    const readings = list.reduce((sum, d) => sum + d.readings, 0);
    const costMicros = list.reduce((sum, d) => sum + d.costMicros, 0);
    return {
      model: latest?.model ?? null,
      days: list,
      totals: { readings, costMicros, averageCostMicros: readings > 0 ? Math.round(costMicros / readings) : 0 },
    };
  }

  async function dispatch(
    req: Request,
    matched: AdminRoute,
    tenantId: string,
    userId: string | null,
    includeCosts: boolean,
  ): Promise<Response> {
    const db = options.db;
    const now = clock();
    const resolve = () =>
      resolveEstimatorSettings(db, tenantId, {
        ...(options.company ? { company: options.company } : {}),
        ...(options.aiBudgetCeilingCents !== undefined ? { aiBudgetCeilingCents: options.aiBudgetCeilingCents } : {}),
        onError: (error) => {
          try {
            options.onError?.(error, { tenantId, route: matched.kind });
          } catch {
            /* contained */
          }
        },
      });
    const settings = await resolve();
    const actor: EstimatorActor = { type: "staff", id: userId };
    const events = {
      now,
      actor,
      settings,
      ...(options.onEvent ? { onEvent: options.onEvent } : {}),
      ...(options.onEventError ? { onEventError: options.onEventError } : {}),
    };
    const params = new URL(req.url).searchParams;
    const id = matched.id ?? "";
    const sub = matched.sub ?? "";
    const body = async () => (req.method === "POST" ? readJsonBody(req) : {});
    const product = async (productId: string) => json({ product: await adminProduct(tenantId, productId, settings, includeCosts) });
    const mutation = async (estimateId: string, warnings: string[] = [], status = 200) => {
      const response: EstimateMutationResponse = { estimate: await estimateDetail(req, tenantId, estimateId, includeCosts, now, settings), warnings };
      return json(response, status);
    };
    const supplyResponse = async (supplyId: string, affected: Array<{ id: string; name: string }>) => {
      const row = await getComponent(db, tenantId, supplyId);
      if (!row) throw notFound();
      const usedBy = (await productsUsingComponents(db, tenantId, [supplyId])).get(supplyId) ?? [];
      const response: SupplyMutationResponse = { supply: toSupplyWire(row, usedBy, includeCosts), affectedProducts: affected };
      return json(response);
    };

    switch (matched.kind) {
      case "status":
        return json(await status(tenantId, settings, includeCosts, now));
      case "usage": {
        const raw = params.get("days");
        let days = 30;
        if (raw !== null && raw !== "") {
          const parsed = Number(raw);
          if (!Number.isInteger(parsed) || parsed < 1 || parsed > 90) {
            throw new HttpError("invalid", "Some details need another look.", [{ path: ["days"], message: "Ask for 1 to 90 days." }]);
          }
          days = parsed;
        }
        return json(await usage(tenantId, days, now));
      }
      case "settings-get":
        return json({ settings: toSettingsWire(settings, { includeCosts, companySettingsHref: options.companySettingsHref ?? null }) });
      case "settings-update": {
        const patch = { ...(await body()) } as Record<string, unknown>;
        const wireOptions = { includeCosts, companySettingsHref: options.companySettingsHref ?? null };
        if (settings.managedByCompany) {
          // D6: the company owns the name, contact, zone and colour. Dropped,
          // never refused: the widget doesn't send them, and a refusal would
          // only break an old client. A body of only those saves nothing.
          for (const key of COMPANY_OWNED_ESTIMATOR_SETTINGS) delete patch[key];
          if (Object.keys(patch).length === 0) return json({ settings: toSettingsWire(settings, wireOptions) });
        }
        // D14: the site's ceiling on photo reading per business. Refused on
        // the field, in the business's money, so the owner sees what's allowed.
        const ceiling = validCeiling(options.aiBudgetCeilingCents);
        const asked = patch["aiDailyBudgetCents"];
        if (ceiling !== null && typeof asked === "number" && asked > ceiling) {
          const message = `This site allows up to ${formatMoney(ceiling, settings)} a day of photo reading per business.`;
          throw new HttpError("invalid", message, [{ path: ["aiDailyBudgetCents"], message }]);
        }
        await updateEstimatorSettings(db, tenantId, patch, { now });
        return json({ settings: toSettingsWire(await resolve(), wireOptions) });
      }
      case "products-list":
        return json({ products: await adminProducts(tenantId, settings, includeCosts, params.get("include") === "inactive") });
      case "product-create": {
        const row = await createProduct(db, { ...(await body()), tenantId } as Parameters<typeof createProduct>[1]);
        await announce({ tenantId, kind: "product", id: row.id, action: "created", userId });
        return json({ product: await adminProduct(tenantId, row.id, settings, includeCosts) }, 201);
      }
      case "products-reorder": {
        const parsed = reorderBodySchema.parse(await body());
        await reorderProducts(db, tenantId, parsed.ids);
        return json({ products: await adminProducts(tenantId, settings, includeCosts, false) });
      }
      case "products-preview": {
        const raw = (await body()) as Record<string, unknown>;
        // A draft can set supplies, labor, waste and markup to anything, and the
        // customer's price then IS the cost (markup 0, one supply per job): so
        // without costs.view only the saved product (and its words) can be
        // tested (review ADV-3).
        if (!includeCosts) {
          const draft = raw["draft"];
          const keys = draft && typeof draft === "object" && !Array.isArray(draft) ? Object.keys(draft as object) : [];
          const costly = keys.filter((key) => !PRICE_ONLY_DRAFT_KEYS.has(key));
          if (costly.length > 0 || (!raw["productId"] && draft !== undefined && draft !== null)) {
            throw new HttpError("forbidden", "Testing unsaved price changes needs access to costs. Save the product, then test it.");
          }
        }
        const preview = await previewProductPrice(db, tenantId, {
          productId: typeof raw["productId"] === "string" ? raw["productId"] : null,
          draft: (raw["draft"] ?? null) as never,
          inputs: (raw["inputs"] ?? null) as never,
          ...(typeof raw["quantity"] === "number" ? { quantity: raw["quantity"] } : {}),
          ...(Array.isArray(raw["optionValueIds"]) ? { optionValueIds: raw["optionValueIds"] as string[] } : {}),
        });
        const response: PreviewResponse = {
          fields: preview.fields,
          status: preview.status,
          missing: preview.missing,
          customerView: preview.customerView,
          breakdown:
            includeCosts && preview.build
              ? {
                  low: preview.build.low,
                  point: preview.build.point,
                  high: preview.build.high,
                  cost: preview.build.cost,
                  marginBp: preview.build.marginBp,
                  minimumApplied: preview.build.minimumApplied,
                  lines: preview.build.breakdown,
                }
              : null,
        };
        return json(response);
      }
      case "product-get":
        return product(id);
      case "product-update": {
        const row = await updateProduct(db, tenantId, id, (await body()) as Parameters<typeof updateProduct>[3]);
        if (!row) throw notFound();
        await announce({ tenantId, kind: "product", id, action: "updated", userId });
        return product(id);
      }
      case "product-deactivate":
      case "product-reactivate": {
        const ok = matched.kind === "product-deactivate" ? await deactivateProduct(db, tenantId, id) : await reactivateProduct(db, tenantId, id);
        if (!ok) throw notFound();
        await announce({ tenantId, kind: "product", id, action: matched.kind === "product-deactivate" ? "retired" : "restored", userId });
        return product(id);
      }
      case "supply-attach": {
        const parsed = attachBodySchema.parse(await body());
        // The product in the PATH is the row this route reads (Tenancy 2a,
        // 3.1): one that isn't in this tenant is 404, like every other
        // product route, not the 400 attachComponent answers for a product it
        // can't price.
        if (!(await getProductRow(db, tenantId, id))) throw notFound();
        await attachComponent(db, tenantId, {
          productId: id,
          componentId: parsed.supplyId,
          quantityMilli: parsed.quantityMilli,
          ...(parsed.per !== undefined ? { per: parsed.per } : {}),
          ...(parsed.roundUp !== undefined ? { roundUp: parsed.roundUp } : {}),
          ...(parsed.sortOrder !== undefined ? { sortOrder: parsed.sortOrder } : {}),
        });
        await announce({ tenantId, kind: "product", id, action: "updated", userId });
        return product(id);
      }
      case "attachment-update":
      case "attachment-remove": {
        if ((await productIdForAttachment(db, tenantId, sub)) !== id) throw notFound();
        const ok =
          matched.kind === "attachment-update"
            ? await updateAttachment(db, tenantId, sub, (await body()) as Parameters<typeof updateAttachment>[3])
            : await detachComponent(db, tenantId, sub);
        if (!ok) throw notFound();
        await announce({ tenantId, kind: "product", id, action: "updated", userId });
        return product(id);
      }
      case "option-create": {
        // The product in the path is the row read: another tenant's is 404 (3.1).
        if (!(await getProductRow(db, tenantId, id))) throw notFound();
        await createOption(db, tenantId, { ...(await body()), productId: id } as Parameters<typeof createOption>[2]);
        return product(id);
      }
      case "option-update":
      case "option-remove":
      case "option-value-create": {
        const productId = await productIdForOption(db, tenantId, id);
        if (!productId) throw notFound();
        if (matched.kind === "option-update") await updateOption(db, tenantId, id, (await body()) as Parameters<typeof updateOption>[3]);
        else if (matched.kind === "option-remove") await deactivateOption(db, tenantId, id);
        else await createOptionValue(db, tenantId, { ...(await body()), optionId: id } as Parameters<typeof createOptionValue>[2]);
        return product(productId);
      }
      case "option-value-update":
      case "option-value-default":
      case "option-value-remove": {
        const owner = await productIdForOptionValue(db, tenantId, id);
        if (!owner) throw notFound();
        let ok: boolean;
        if (matched.kind === "option-value-update") ok = await updateOptionValue(db, tenantId, id, (await body()) as Parameters<typeof updateOptionValue>[3]);
        else if (matched.kind === "option-value-default") ok = await setDefaultOptionValue(db, tenantId, id);
        else ok = await deactivateOptionValue(db, tenantId, id);
        if (!ok) throw new EstimatorInputError("option_value_unavailable", "That choice isn't available any more.");
        return product(owner.productId);
      }
      case "supplies-list": {
        const rows = await listComponents(db, tenantId, { includeInactive: params.get("include") === "inactive" });
        const usedBy = await productsUsingComponents(
          db,
          tenantId,
          rows.map((row) => row.id),
        );
        return json({ supplies: rows.map((row) => toSupplyWire(row, usedBy.get(row.id) ?? [], includeCosts)) });
      }
      case "supply-create": {
        const row = await createComponent(db, { ...(await body()), tenantId } as Parameters<typeof createComponent>[1]);
        await announce({ tenantId, kind: "supply", id: row.id, action: "created", userId });
        return json({ supply: toSupplyWire(row, [], includeCosts) }, 201);
      }
      case "supply-update": {
        const result = await updateComponent(db, tenantId, id, (await body()) as Parameters<typeof updateComponent>[3]);
        if (!result) throw notFound();
        await announce({ tenantId, kind: "supply", id, action: "updated", userId });
        return supplyResponse(id, result.affectedProducts);
      }
      case "supply-deactivate":
      case "supply-reactivate": {
        // Read who uses it FIRST, so the screen can say what retiring it takes out of.
        const affected = (await productsUsingComponent(db, tenantId, id)).filter((p) => p.isActive).map(({ id: pid, name }) => ({ id: pid, name }));
        const ok = matched.kind === "supply-deactivate" ? await deactivateComponent(db, tenantId, id) : await reactivateComponent(db, tenantId, id);
        if (!ok) throw notFound();
        await announce({ tenantId, kind: "supply", id, action: matched.kind === "supply-deactivate" ? "retired" : "restored", userId });
        return supplyResponse(id, affected);
      }
      case "sample-catalog": {
        // Loaded OFF the website: the owner turns each product on once its prices are theirs (review EST-R01).
        // The body names the trade (T2A-BO-10); none is 0.3's ramps sample.
        const { trade } = sampleBodySchema.parse(await body());
        const loaded: SampleCatalogResponse = await loadSampleCatalog(db, tenantId, { now, ...(trade ? { trade } : {}) });
        await announce({ tenantId, kind: "sample", id: null, action: "loaded", userId });
        return json(loaded);
      }
      case "estimates-list": {
        if (options.sweepExpired !== false) {
          await sweep(tenantId, now.getTime(), () => expireQuotes(db, tenantId, events));
        }
        const filter = params.get("filter") || undefined;
        const limit = params.get("limit");
        const result = await searchEstimates(db, tenantId, {
          ...(filter ? { filter: filter as EstimateFilter } : {}),
          ...(params.get("q") ? { q: params.get("q") as string } : {}),
          ...(params.get("source") ? { source: params.get("source") as "public_tool" } : {}),
          cursor: params.get("cursor") || null,
          ...(limit ? { limit: Number(limit) } : {}),
        });
        const response: EstimateListResponse = { estimates: result.rows, nextCursor: result.nextCursor, counts: result.counts };
        return json(response);
      }
      case "estimate-create": {
        const raw = (await body()) as Record<string, unknown>;
        const created = await createEstimate(
          db,
          {
            tenantId,
            customerName: raw["customerName"] as string | null,
            customerEmail: raw["customerEmail"] as string | null,
            customerPhone: raw["customerPhone"] as string | null,
            jobAddress: raw["jobAddress"] as string | null,
            notes: raw["notes"] as string | null,
            internalNotes: raw["internalNotes"] as string | null,
            ...(raw["discount"] !== undefined ? { discount: raw["discount"] as number } : {}),
            ...(raw["taxRateBp"] !== undefined ? { taxRateBp: raw["taxRateBp"] as number } : {}),
            items: (raw["items"] ?? []) as never,
            source: "staff",
          },
          userId ?? undefined,
          { now, settings },
        );
        return mutation(created.id, [], 201);
      }
      case "estimate-get":
        return json({ estimate: await estimateDetail(req, tenantId, id, includeCosts, now, settings) });
      case "estimate-update": {
        const row = await updateEstimate(db, tenantId, id, (await body()) as Parameters<typeof updateEstimate>[3], events);
        if (!row) throw notFound();
        return mutation(id);
      }
      case "line-add": {
        const item = await addEstimateItem(db, tenantId, id, (await body()) as Parameters<typeof addEstimateItem>[3], events);
        if (!item) throw notFound();
        return mutation(id);
      }
      case "line-update": {
        const item = await updateEstimateItem(db, tenantId, id, sub, (await body()) as Parameters<typeof updateEstimateItem>[4], events);
        if (!item) throw notFound();
        return mutation(id);
      }
      case "line-remove": {
        if (!(await removeEstimateItem(db, tenantId, id, sub, events))) throw notFound();
        return mutation(id);
      }
      case "photo-add": {
        if (!options.photoStore) throw new HttpError("photos_disabled", "Photos can't be kept: no file storage is connected.");
        const parsed = photoBodySchema.parse(await readJsonBody(req, MAX_PHOTO_BODY_CHARS));
        const photo = await attachStaffPhoto(db, options.photoStore, tenantId, id, parsed, { now });
        if (!photo) throw notFound();
        return mutation(id);
      }
      case "photo-remove": {
        if (!(await removeEstimatePhoto(db, options.photoStore, tenantId, id, sub))) throw notFound();
        return mutation(id);
      }
      case "quote-send": {
        const result = await sendQuote(db, tenantId, id, (await body()) as Parameters<typeof sendQuote>[3], events);
        if (!result) throw notFound();
        return mutation(id, result.warnings);
      }
      case "quote-resend": {
        if (!(await resendQuote(db, tenantId, id, events))) throw notFound();
        return mutation(id);
      }
      case "quote-revise": {
        if (!(await reviseQuote(db, tenantId, id, events))) throw notFound();
        return mutation(id);
      }
      case "estimate-status": {
        const parsed = statusBodySchema.parse(await body());
        const row = await getEstimateRow(db, tenantId, id);
        if (!row) throw notFound();
        if (parsed.status === "draft" && (row.status === "sent" || row.status === "viewed")) {
          // Taking a sent quote back is a revision: it withdraws the follow-up
          // and the link says "updating" (quote.revised), which a bare status
          // move would not.
          await reviseQuote(db, tenantId, id, events);
          return mutation(id);
        }
        const moved = await setEstimateStatus(
          db,
          tenantId,
          { id, status: parsed.status, ...(parsed.note !== undefined ? { note: parsed.note } : {}) },
          { ...events, notify: parsed.notify ?? false },
        );
        if (!moved) {
          throw new HttpError("transition_not_allowed", "That can't be done from the quote's current state. Refresh and try again.");
        }
        return mutation(id);
      }
      case "quote-link": {
        if (!options.quoteUrl) throw notFound();
        const row = await getEstimateRow(db, tenantId, id);
        if (!row) throw notFound();
        if (!row.sentAt) throw new HttpError("not_changeable", "Send the quote first.");
        const token = await issueQuoteToken(db, tenantId, id);
        if (!token) throw notFound();
        return json({ url: await options.quoteUrl(token, tenantId) } satisfies QuoteLinkResponse);
      }
      case "estimate-archive":
      case "estimate-unarchive": {
        const ok =
          matched.kind === "estimate-archive" ? await archiveEstimate(db, tenantId, id, { now }) : await unarchiveEstimate(db, tenantId, id, { now });
        if (!ok) throw notFound();
        return mutation(id);
      }
      case "estimate-duplicate": {
        const created = await duplicateEstimate(db, tenantId, id, userId ?? undefined, { now, settings });
        if (!created) throw notFound();
        return mutation(created.id, [], 201);
      }
      case "estimate-convert": {
        if (!options.convertToInvoice) throw notFound();
        // Converting writes an invoice: the host's invoice permission must say
        // yes too, not only the estimator's (SEC-2A-02).
        const rights = await invoiceRights(req, tenantId);
        if (rights.refusal) return rights.refusal;
        if (!rights.manage) throw new HttpError("forbidden", "You can't raise invoices, so this quote can't be turned into one.");
        const row = await getEstimateRow(db, tenantId, id);
        if (!row) throw notFound();
        if (row.status !== "approved") {
          throw new HttpError("transition_not_allowed", "Only an accepted quote can become an invoice.");
        }
        const invoice = await options.convertToInvoice({ tenantId, estimateId: id, userId });
        // The seam claimed the estimate inside ITS transaction; the event goes
        // now, after that commit (so the seam should not pass onEvent itself).
        const after = await getEstimateRow(db, tenantId, id);
        if (after?.status === "converted") {
          await emitEvents(db, tenantId, [{ type: "estimate.converted", estimateId: id, actor }], events);
        }
        const response: ConvertResponse = { invoice, estimate: await estimateDetail(req, tenantId, id, includeCosts, now, settings) };
        return json(response);
      }
      case "expire": {
        const result = await expireQuotes(db, tenantId, events);
        return json({ expired: result.expired } satisfies ExpireResponse);
      }
      case "keys-list":
        return json({ keys: (await listClientKeys(db, tenantId)).map(toKeyWire) });
      case "key-issue": {
        const parsed = issueKeyBodySchema.parse(await body());
        const issued = await issueClientKey(db, {
          tenantId,
          label: parsed.label,
          ...(parsed.allowedOrigins ? { allowedOrigins: parsed.allowedOrigins } : {}),
        });
        const row = (await listClientKeys(db, tenantId)).find((key) => key.id === issued.id);
        if (!row) throw notFound();
        return json({ key: toKeyWire(row), plaintext: issued.key } satisfies IssuedKeyResponse, 201);
      }
      case "key-update": {
        const row = await updateClientKey(db, tenantId, id, (await body()) as Parameters<typeof updateClientKey>[3]);
        if (!row) throw notFound();
        return json({ key: toKeyWire(row) });
      }
      case "key-revoke": {
        if (!(await revokeClientKey(db, tenantId, id))) throw notFound();
        const row = (await listClientKeys(db, tenantId)).find((key) => key.id === id);
        if (!row) throw notFound();
        return json({ key: toKeyWire(row) });
      }
    }
  }

  async function handle(req: Request): Promise<Response> {
    // No CORS headers, ever: the staff API is same-origin only.
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
    if (req.method === "POST" && isCrossSiteRequest(req)) {
      return failure(new HttpError("forbidden", "This request came from another site, so it was refused."), { tenantId: null, route: "csrf" });
    }
    const matched = route(req.method, new URL(req.url).pathname);
    if (!matched) return failure(notFound(), { tenantId: null, route: "unknown" });
    let tenantId: string | null = null;
    try {
      tenantId = options.resolveTenant ? await options.resolveTenant(req) : (options.tenantId ?? null);
      if (!tenantId) return failure(notFound(), { tenantId: null, route: matched.kind });
      const verdict = await options.authorize(req, ESTIMATOR_ADMIN_ROUTE_PERMISSIONS[matched.kind], tenantId);
      if (verdict instanceof Response) return verdict;
      if (verdict === false || verdict === null || verdict === undefined) {
        return failure(new HttpError("forbidden", "You don't have permission to do that."), { tenantId, route: matched.kind });
      }
      const raw = typeof verdict === "object" ? (verdict.userId ?? null) : null;
      const userId = raw === null ? null : String(raw);
      let includeCosts = ESTIMATOR_ADMIN_ROUTE_PERMISSIONS[matched.kind] === "estimator.costs.view";
      if (!includeCosts && COST_ROUTES.has(matched.kind)) {
        // The second answer only decides what is stripped; it is never the response.
        const second = await options.authorize(req, "estimator.costs.view", tenantId);
        includeCosts = second === true || (typeof second === "object" && second !== null && !(second instanceof Response));
      }
      return await dispatch(req, matched, tenantId, userId, includeCosts);
    } catch (error) {
      return failure(error, { tenantId, route: matched.kind });
    }
  }

  return { handle };
}
