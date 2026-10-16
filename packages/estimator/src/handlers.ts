import { z } from "zod";
import { listProducts, listPublicOptions, publicOptionsFor, recipeOf } from "./catalog.js";
import { createPublicEstimate } from "./estimates.js";
import type { EstimatorEvent, EstimatorEventListener } from "./events.js";
import {
  HttpError,
  isCrossSiteRequest,
  MAX_PHOTO_BODY_BYTES,
  MAX_PHOTO_BODY_CHARS,
  NOT_FOUND_MESSAGE,
  readJsonBody,
  safeDecode,
  toWireError,
} from "./http.js";
import { PHOTO_LIMITS, sha256Hex } from "./image.js";
import { ESTIMATOR_KEY_HEADER, originAllowed, verifyClientKey } from "./keys.js";
import { decodePhoto, keepPublicPhoto, type EstimatorPhotoStore, type PublicPhotoLimits } from "./photos.js";
import { customerInputsSchema, priceProduct, publicMeasurementSchema, toLegacyRange, toPublicPrice } from "./price-product.js";
import { acceptQuote, declineQuote, getQuoteByToken } from "./quotes.js";
import { customerFieldsFor, quantityQuestion, recipeReadsPhotos } from "./recipes.js";
import { resolveEstimatorSettings, type EstimatorAdmission, type EstimatorCompany } from "./company.js";
import { effectiveTaxRateBp, publicEstimatesOpen, type EstimatorSettings } from "./settings.js";
import { runPhotoTakeoff } from "./takeoff-run.js";
import type { TakeoffModel, TakeoffUsage } from "./takeoff.js";
import type { EstimatorDb } from "./types.js";
import type {
  CalculateResponse,
  CountRecipeConfig,
  PhotoResponse,
  PublicConfig,
  PublicProduct,
  QuoteResponse,
  RampRecipeConfig,
  SubmitResponse,
} from "./wire.js";

/**
 * The HTTP surface the customer-facing widget (`<EstimateTool>`, `<QuoteView>`)
 * speaks — one `handle(req)` routed by path suffix, mounted by the host app at
 * any base path with a catch-all route (section 8.2 of the 0.3 contract):
 *
 *   // app/api/estimator/[...path]/route.ts
 *   const { handle } = createEstimatorHandlers({ db, tenantId: "primary", photoStore, takeoff, onEvent });
 *   export { handle as GET, handle as POST, handle as OPTIONS };
 *
 *   GET  {base}/v1/config                    → PublicConfig
 *   POST {base}/v1/options    { productId }  → { options }       (0.2; kept)
 *   POST {base}/v1/calculate  CalculateBody  → CalculateResponse (never calls the model)
 *   POST {base}/v1/photo      PhotoBody      → 201 PhotoResponse (keep a photo for the business)
 *   POST {base}/v1/takeoff    TakeoffBody    → TakeoffResponse   (read a photo: observations only)
 *   POST {base}/v1/submit     SubmitBody     → 201 SubmitResponse (the lead)
 *   GET  {base}/v1/quote/:token              → QuoteResponse
 *   POST {base}/v1/quote/:token/accept|decline → QuoteResponse
 *
 * ONE FACTORY, TWO CALLERS. A request WITH `x-adminigloo-key` is the embed on
 * the business's own website: the key names the tenant, its allowed origins
 * are checked, and every response carries CORS for the page's origin (no
 * cookie rides along, so no CSRF check). A request WITHOUT a key is the
 * business's own page (`tenantId` / `resolveTenant`): same-origin only, every
 * POST passes the cross-site check, and there are no CORS headers.
 *
 * Every response is `Cache-Control: no-store`; quote routes (a key in the URL)
 * add `Referrer-Policy: no-referrer` and `X-Robots-Tag: noindex`. Errors are
 * `{ error: { code, message, issues? } }`; `issues` never echo input values,
 * and an unexpected error is a 500 with a fixed message, reported to
 * `onError` and never its own text (ES-V3).
 */

export type EstimatorRateLimitBucket = "read" | "calculate" | "photo" | "takeoff" | "submit" | "respond";

export interface CreateEstimatorHandlersOptions {
  db: EstimatorDb;
  /** For requests WITHOUT an embed key (the business's own pages). Omit both for keyed-only (0.2). */
  tenantId?: string;
  resolveTenant?: (req: Request) => string | null | Promise<string | null>;
  /** Where customers' photos are kept. Without it, no photo is kept (a reading still works). */
  photoStore?: EstimatorPhotoStore;
  /** Photo reading. Without it, reading is off and the widget asks for the count. */
  takeoff?: { model: TakeoffModel; recordUsage?: (usage: TakeoffUsage) => void | Promise<void>; maxTokens?: number };
  /** After commit, for every estimate event (the comms listener's `onEvent`). Awaited and contained. */
  onEvent?: EstimatorEventListener;
  onEventError?: (error: unknown, event: EstimatorEvent) => void;
  /**
   * false → 429. A THROW is also 429: every bucket fails closed. WITHOUT IT
   * EVERY PUBLIC ROUTE IS UNLIMITED: only the AI budget, the per-visitor
   * reading count and the photo cap (all in the database) still hold.
   */
  rateLimit?: (
    req: Request,
    bucket: EstimatorRateLimitBucket,
    context: { tenantId: string; keyId: string | null },
  ) => boolean | Promise<boolean>;
  /**
   * Who is asking, for the per-visitor photo-reading count and photo cap.
   * Default `clientIpKey` (one proxy in front). Behind more proxies, or
   * Cloudflare, pass `createClientIpKey({ trustProxy: 2 })` or
   * `createClientIpKey({ cloudflare: true })` (README, "Who is asking"). A
   * request it can't place (null) shares ONE bucket with every other such
   * request.
   */
  requesterKey?: (req: Request) => string | null | Promise<string | null>;
  /** The daily caps on photos visitors leave without sending an estimate (`DEFAULT_PUBLIC_PHOTO_LIMITS`). */
  photoLimits?: PublicPhotoLimits;
  /** The fill-time floor for the lead form, in ms. Default 2000; 0 = off. */
  minFillMs?: number;
  /** A KEYED submit with no `fillMs` at all (estimator-widget 0.1.x) passes the fill-time check. Default true. */
  allowLegacyWidgetBodies?: boolean;
  /** Does this deployment email customers? Default `Boolean(onEvent)`; echoed in the config. */
  emailsEnabled?: boolean;
  onError?: (error: unknown, context: { tenantId: string | null; route: string }) => void;
  now?: () => Date;
  /** @deprecated — set the rate in estimator settings. Used only while the tenant has no saved settings. */
  taxRateBp?: number | ((tenantId: string) => number | Promise<number>);
  /** @deprecated — use onEvent (lead.received). Still called after a public submit. */
  onLead?: (lead: { tenantId: string; estimateId: string; estimateNumber: string }) => void | Promise<void>;
  /**
   * The business as its customers know it, from the host's company profile
   * (Tenancy 2a, D5): the config's and quotes' name, contact, zone, colour
   * and logo are the company's. A throw is reported (`onError`) and that
   * request uses the stored settings.
   */
  company?: (tenantId: string) => EstimatorCompany | null | Promise<EstimatorCompany | null>;
  /**
   * Is this business taking requests from the public right now? Asked once
   * per request on BOTH paths, after the tenant is known (from the web
   * address OR from an embed key) and before the route, the rate limit or any
   * estimator query (D7). Closed → `409 estimates_closed` with its message
   * (and CORS for a keyed request, so the embed can show it). Default: open.
   */
  admit?: (tenantId: string, req: Request) => EstimatorAdmission | Promise<EstimatorAdmission>;
  /**
   * The most a day of photo reading may cost per business on this site, in
   * cents (D14). The budget the reading checks is `min(the business's
   * setting, this)`. Default: no ceiling.
   */
  aiBudgetCeilingCents?: number;
  /**
   * The most a day of photo reading may cost across EVERY business this
   * handler serves, in cents (Tenancy 2a review SEC-2A-07; see
   * `RunPhotoTakeoffDeps.siteDailyBudgetCents`). Default: no site ceiling.
   */
  aiSiteBudgetCents?: number;
}

/** @deprecated 0.2's name for the options. */
export type EstimatorHandlersOptions = CreateEstimatorHandlersOptions;

export interface EstimatorHandlers {
  handle: (req: Request) => Promise<Response>;
}

export interface ClientIpKeyOptions {
  /** How many proxies you run in front of the app, each APPENDING to `X-Forwarded-For`. Default 1. */
  trustProxy?: number;
  /**
   * The app is behind Cloudflare (review RL-06): the visitor is
   * `CF-Connecting-IP`, the address Cloudflare saw — with Cloudflare then
   * nginx, X-Forwarded-For's last entries are Cloudflare's edge, and every
   * visitor through one edge shared a limit. ONLY when every request really
   * comes through Cloudflare: anyone else can send that header.
   */
  cloudflare?: boolean;
}

/**
 * COPIED FROM @adminigloo/scheduling's handlers.ts; change both or neither.
 *
 * "ip:" + the caller's address as your proxies saw it, else X-Real-IP, else
 * null (no proxy headers at all: a laptop, a test). Not the FIRST entry of
 * X-Forwarded-For: that is whatever the client sent, so a script that made up
 * a new address each time would pass every per-caller limit. The entry
 * `trustProxy` places from the right is the one your own proxy wrote.
 */
export function clientIpKey(req: Request, options: ClientIpKeyOptions = {}): string | null {
  if (options.cloudflare) {
    const visitor = req.headers.get("cf-connecting-ip")?.trim();
    if (visitor) return `ip:${visitor}`;
  }
  const hops = Math.max(1, Math.trunc(Number.isFinite(options.trustProxy) ? (options.trustProxy as number) : 1));
  const chain = (req.headers.get("x-forwarded-for") ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (chain.length > 0) return `ip:${chain[Math.max(0, chain.length - hops)]}`;
  const real = req.headers.get("x-real-ip")?.trim();
  return real ? `ip:${real}` : null;
}

/** `clientIpKey` with options, for `requesterKey`: `createClientIpKey({ trustProxy: 2 })`. */
export function createClientIpKey(options: ClientIpKeyOptions): (req: Request) => string | null {
  return (req) => clientIpKey(req, options);
}

type Route =
  | { kind: "config" | "options" | "calculate" | "photo" | "takeoff" | "submit" }
  | { kind: "quote" | "accept" | "decline"; token: string };

function route(method: string, pathname: string): Route | null {
  const path = pathname.replace(/\/+$/, "");
  if (/\/v1\/admin(\/|$)/.test(path)) return null;
  if (method === "GET" && path.endsWith("/v1/config")) return { kind: "config" };
  if (method === "POST") {
    for (const kind of ["options", "calculate", "photo", "takeoff", "submit"] as const) {
      if (path.endsWith(`/v1/${kind}`)) return { kind };
    }
  }
  const quote = /\/v1\/quote\/([^/]+)(?:\/(accept|decline))?$/.exec(path);
  if (quote) {
    const token = safeDecode(quote[1] ?? "");
    if (!quote[2] && method === "GET") return { kind: "quote", token };
    if (quote[2] === "accept" && method === "POST") return { kind: "accept", token };
    if (quote[2] === "decline" && method === "POST") return { kind: "decline", token };
  }
  return null;
}

function bucketOf(kind: Route["kind"]): EstimatorRateLimitBucket {
  switch (kind) {
    case "calculate":
      return "calculate";
    case "photo":
      return "photo";
    case "takeoff":
      return "takeoff";
    case "submit":
      return "submit";
    case "accept":
    case "decline":
      return "respond";
    default:
      return "read";
  }
}

const SPAM_MESSAGE = "That was quicker than a person can fill in the form. Please check your details and send it again.";
const CLOSED_MESSAGE = "Instant estimates aren't available right now. Please call or email us.";

const legacyMeasurement = publicMeasurementSchema.optional();
const calculateBodySchema = z.object({
  productId: z.string().min(1, "Pick what you need.").max(200),
  inputs: customerInputsSchema.optional(),
  quantity: z.number().int().min(1).max(1000).optional(),
  optionValueIds: z.array(z.string().min(1).max(200)).max(50).optional(),
  takeoffId: z.string().max(200).nullish(),
  measurement: legacyMeasurement,
});
const photoBodySchema = z.object({
  imageBase64: z.string().max(MAX_PHOTO_BODY_CHARS),
  mediaType: z.string().max(40),
  productId: z.string().max(200).optional(),
});
const takeoffBodySchema = z.object({
  productId: z.string().min(1).max(200),
  imageBase64: z.string().max(MAX_PHOTO_BODY_CHARS),
  mediaType: z.string().max(40),
  inputs: customerInputsSchema.nullish(),
});
const optionsBodySchema = z.object({ productId: z.unknown().optional() });

/** The server's names → the wire's, for issues raised by `createPublicEstimate`. */
const SUBMIT_RENAMES = { customerName: "name", customerEmail: "email", customerPhone: "phone", jobAddress: "address" } as const;

function honeypotFilled(raw: Record<string, unknown>): boolean {
  const website = raw["website"];
  return website !== undefined && website !== null && !(typeof website === "string" && website.trim() === "");
}

export function createEstimatorHandlers(options: CreateEstimatorHandlersOptions): EstimatorHandlers {
  const minFillMs = options.minFillMs ?? 2000;
  if (!Number.isFinite(minFillMs) || minFillMs < 0) {
    throw new Error(`createEstimatorHandlers: minFillMs must be 0 or more (got ${String(options.minFillMs)})`);
  }
  const emailsEnabled = options.emailsEnabled ?? Boolean(options.onEvent);
  const clock = () => options.now?.() ?? new Date();
  const privateHeaders = { "referrer-policy": "no-referrer", "x-robots-tag": "noindex" };

  function respond(body: unknown, status: number, cors: Record<string, string>, tokenRoute: boolean): Response {
    return new Response(body === null ? null : JSON.stringify(body), {
      status,
      headers: {
        "cache-control": "no-store",
        ...(body === null ? {} : { "content-type": "application/json; charset=utf-8" }),
        ...cors,
        ...(tokenRoute ? privateHeaders : {}),
      },
    });
  }
  function failure(
    error: unknown,
    cors: Record<string, string>,
    tokenRoute: boolean,
    context: { tenantId: string | null; route: string },
    renames: Record<string, string> = {},
  ): Response {
    const wire = toWireError(error, renames);
    if (wire.unexpected) {
      try {
        if (options.onError) options.onError(error, context);
        else console.error("[@adminigloo/estimator] unexpected error", context, error);
      } catch {
        /* a broken reporter must not change the answer */
      }
    }
    return respond(
      { error: { code: wire.code, message: wire.message, ...(wire.issues ? { issues: wire.issues } : {}) } },
      wire.status,
      cors,
      tokenRoute,
    );
  }

  async function legacyTaxRate(tenantId: string, settings: EstimatorSettings): Promise<number> {
    if (settings.saved || options.taxRateBp === undefined) return effectiveTaxRateBp(settings);
    const legacy = typeof options.taxRateBp === "function" ? await options.taxRateBp(tenantId) : options.taxRateBp;
    return effectiveTaxRateBp(settings, legacy);
  }

  async function publicConfig(tenantId: string, settings: EstimatorSettings): Promise<PublicConfig> {
    // Closed until the business is set up (review EST-R02): the page says
    // "not available right now" with the business's phone, never a price
    // signed by nobody at a tax rate the owner never chose.
    const open = publicEstimatesOpen(settings);
    const reading = settings.photosEnabled && Boolean(options.takeoff) && settings.aiDailyBudgetCents > 0 && settings.aiPerRequesterDaily > 0;
    const rows = open ? await listProducts(options.db, tenantId, { publicOnly: true }) : [];
    const optionsByProduct = await publicOptionsFor(
      options.db,
      rows.map((row) => row.id),
    );
    const products: PublicProduct[] = rows.map((row) => {
      const { recipe, config } = recipeOf(row);
      const tip =
        recipe === "ramp_over_steps"
          ? (config as RampRecipeConfig).photoTip
          : recipe === "count"
            ? (config as CountRecipeConfig).photoTip
            : null;
      return {
        id: row.id,
        name: row.name,
        category: row.category,
        description: row.description,
        recipe,
        fields: customerFieldsFor(recipe, config),
        quantity: quantityQuestion(recipe, config, row),
        isEstimatable: row.isEstimatable,
        photo: { reading: reading && row.isEstimatable && recipeReadsPhotos(recipe, config), tip },
        options: optionsByProduct.get(row.id) ?? [],
        measurementMode: row.measurementMode === "linear" ? "linear" : row.measurementMode === "unit" ? "unit" : "area",
      };
    });
    return {
      businessName: settings.businessName,
      contactEmail: settings.contactEmail,
      contactPhone: settings.contactPhone,
      currency: settings.currency,
      locale: settings.locale,
      timeZone: settings.timeZone,
      brandColor: settings.brandColor,
      instantEstimatesEnabled: open,
      photos: {
        attach: settings.photosEnabled && Boolean(options.photoStore),
        reading,
        maxEdgePx: PHOTO_LIMITS.maxEdgePx,
        maxBytes: PHOTO_LIMITS.maxBytes,
        jpegQuality: PHOTO_LIMITS.jpegQuality,
      },
      emailsEnabled,
      minFillMs,
      products,
      logoUrl: settings.logoUrl ?? null,
    };
  }

  async function dispatch(
    req: Request,
    matched: Route,
    tenantId: string,
    keyed: boolean,
    settings: EstimatorSettings,
    now: Date,
    cors: Record<string, string>,
  ): Promise<Response> {
    const db = options.db;
    const events = {
      now,
      settings,
      ...(options.onEvent ? { onEvent: options.onEvent } : {}),
      ...(options.onEventError ? { onEventError: options.onEventError } : {}),
    };
    switch (matched.kind) {
      case "config":
        return respond(await publicConfig(tenantId, settings), 200, cors, false);
      case "options": {
        const body = optionsBodySchema.parse(await readJsonBody(req));
        if (typeof body.productId !== "string") return respond({ options: [] }, 200, cors, false);
        // Staff-only options never leave the server.
        return respond({ options: await listPublicOptions(db, tenantId, body.productId) }, 200, cors, false);
      }
      case "calculate": {
        if (!publicEstimatesOpen(settings)) throw new HttpError("estimates_closed", CLOSED_MESSAGE);
        const body = calculateBodySchema.parse(await readJsonBody(req));
        // Never calls the model: a reading is only READ, by takeoffId, and a
        // foreign one is ignored here (refused on submit).
        const priced = await priceProduct(
          db,
          tenantId,
          {
            productId: body.productId,
            inputs: body.inputs ?? null,
            measurement: body.inputs ? null : (body.measurement ?? null),
            ...(body.quantity !== undefined ? { quantity: body.quantity } : {}),
            optionValueIds: body.optionValueIds ?? [],
            takeoffId: body.takeoffId ?? null,
          },
          { audience: "public", settings },
        );
        let response: CalculateResponse;
        if (priced.status === "quote_only") response = { status: "quote_only", missing: [], price: null, result: null };
        else if (priced.status === "needs_inputs") response = { status: "needs_inputs", missing: priced.missing, price: null, result: null };
        else {
          response = {
            status: "priced",
            missing: [],
            price: toPublicPrice(priced, settings, await legacyTaxRate(tenantId, settings)),
            result: toLegacyRange(priced),
          };
        }
        return respond(response, 200, cors, false);
      }
      case "photo": {
        if (!publicEstimatesOpen(settings)) throw new HttpError("estimates_closed", CLOSED_MESSAGE);
        if (!settings.photosEnabled || !options.photoStore) {
          throw new HttpError("photos_disabled", "This estimator doesn't take photos.");
        }
        const body = photoBodySchema.parse(await readJsonBody(req, MAX_PHOTO_BODY_CHARS, MAX_PHOTO_BODY_BYTES));
        const photo = decodePhoto(body.imageBase64, body.mediaType);
        const requester = options.requesterKey ? await options.requesterKey(req) : clientIpKey(req);
        const kept = await keepPublicPhoto(db, options.photoStore, tenantId, { ...photo, sha256: await sha256Hex(photo.bytes) }, now, {
          requesterHash: await sha256Hex(`${tenantId}:${requester ?? "none"}`),
          ...(options.photoLimits ? { limits: options.photoLimits } : {}),
        });
        return respond({ photoId: kept.id } satisfies PhotoResponse, 201, cors, false);
      }
      case "takeoff": {
        const body = takeoffBodySchema.parse(await readJsonBody(req, MAX_PHOTO_BODY_CHARS, MAX_PHOTO_BODY_BYTES));
        const requesterKey = options.requesterKey ? await options.requesterKey(req) : clientIpKey(req);
        const response = await runPhotoTakeoff(
          db,
          {
            tenantId,
            productId: body.productId,
            imageBase64: body.imageBase64,
            mediaType: body.mediaType,
            inputs: body.inputs ?? null,
            requesterKey,
            now,
          },
          {
            settings,
            ...(options.takeoff ? { model: options.takeoff.model } : {}),
            ...(options.takeoff?.recordUsage ? { recordUsage: options.takeoff.recordUsage } : {}),
            ...(options.takeoff?.maxTokens !== undefined ? { maxTokens: options.takeoff.maxTokens } : {}),
            ...(options.photoStore ? { photoStore: options.photoStore } : {}),
            ...(options.photoLimits ? { photoLimits: options.photoLimits } : {}),
            ...(options.aiSiteBudgetCents !== undefined ? { siteDailyBudgetCents: options.aiSiteBudgetCents } : {}),
            onError: (error, context) => {
              try {
                options.onError?.(error, { tenantId: context.tenantId, route: `takeoff:${context.step}` });
              } catch {
                /* contained */
              }
            },
          },
        );
        return respond(response, 200, cors, false);
      }
      case "submit": {
        const raw = await readJsonBody(req);
        // Spam first, before any database work: a bot learns nothing and costs nothing.
        const rawFill = raw["fillMs"];
        const fillGiven = typeof rawFill === "number" && Number.isFinite(rawFill);
        const legacyBody = rawFill === undefined && keyed && options.allowLegacyWidgetBodies !== false;
        const tooFast = minFillMs > 0 && !legacyBody && (!fillGiven || (rawFill as number) < minFillMs);
        if (honeypotFilled(raw) || tooFast) throw new HttpError("spam_suspected", SPAM_MESSAGE);
        if (!publicEstimatesOpen(settings)) throw new HttpError("estimates_closed", CLOSED_MESSAGE);
        const pick = (wire: string, legacy: string) => (raw[wire] !== undefined ? raw[wire] : raw[legacy]);
        const email = pick("email", "customerEmail");
        const created = await createPublicEstimate(
          db,
          {
            customerName: pick("name", "customerName") as string,
            customerEmail: email as string | null | undefined,
            customerPhone: pick("phone", "customerPhone") as string | null | undefined,
            jobAddress: pick("address", "jobAddress") as string | null | undefined,
            notes: raw["notes"] as string | null | undefined,
            items: raw["items"] as never,
            photoIds: (raw["photoIds"] ?? []) as string[],
          },
          {
            tenantId,
            taxRateBp: await legacyTaxRate(tenantId, settings),
            requesterKey: options.requesterKey ? await options.requesterKey(req) : clientIpKey(req),
            ...events,
            // Tenancy 2b-1 (review BO-13): the customer's photos are put on
            // their estimate in the file store once the lead commits.
            ...(options.photoStore ? { photoStore: options.photoStore } : {}),
            onError: (error, context) => {
              try {
                if (options.onError) options.onError(error, { tenantId: context.tenantId, route: context.step });
                else console.error("[@adminigloo/estimator] a photo step failed", { tenantId: context.tenantId, step: context.step }, error);
              } catch {
                /* contained: the lead is saved */
              }
            },
          },
        );
        if (options.onLead) {
          try {
            await options.onLead({ tenantId, estimateId: created.id, estimateNumber: created.estimateNumber });
          } catch {
            // A broken listener must not fail the customer's submit.
          }
        }
        const response: SubmitResponse = {
          estimateId: created.id,
          estimateNumber: created.estimateNumber,
          range: { low: created.rangeLow, high: created.rangeHigh, single: created.rangeLow === created.rangeHigh },
          currency: settings.currency,
          emailed: emailsEnabled && typeof email === "string" && email.trim() !== "",
          id: created.id,
          subtotal: created.subtotal,
          taxAmount: created.taxAmount,
          total: created.total,
        };
        return respond(response, 201, cors, false);
      }
      case "quote": {
        const quote = await getQuoteByToken(db, tenantId, matched.token, events);
        if (!quote) throw new HttpError("not_found", NOT_FOUND_MESSAGE);
        return respond({ quote } satisfies QuoteResponse, 200, cors, true);
      }
      case "accept":
      case "decline": {
        const raw = await readJsonBody(req);
        // The honeypot only: a customer tapping Accept quickly is normal.
        if (honeypotFilled(raw)) throw new HttpError("spam_suspected", SPAM_MESSAGE);
        // The version of the quote the customer is looking at (review ADV-2):
        // an answer to a version staff have since revised is refused, and the
        // page shows the new one. Required: an answer that names no version
        // could bind the customer to a price they never saw.
        const version = raw["version"];
        const input = { version: version as number, note: raw["note"] as string | null };
        const quote =
          matched.kind === "accept"
            ? await acceptQuote(db, tenantId, matched.token, { ...input, name: raw["name"] as string | null }, events)
            : await declineQuote(db, tenantId, matched.token, input, events);
        if (!quote) throw new HttpError("not_found", NOT_FOUND_MESSAGE);
        return respond({ quote } satisfies QuoteResponse, 200, cors, true);
      }
    }
  }

  async function handle(req: Request): Promise<Response> {
    const origin = req.headers.get("origin");
    if (req.method === "OPTIONS") {
      // A preflight carries no key, so origins are checked on the real request.
      const preflight: Record<string, string> = origin
        ? {
            "access-control-allow-origin": origin,
            vary: "Origin",
            "access-control-allow-methods": "GET, POST, OPTIONS",
            "access-control-allow-headers": `content-type, ${ESTIMATOR_KEY_HEADER}`,
            "access-control-max-age": "86400",
          }
        : {};
      return respond(null, 204, preflight, false);
    }
    const url = new URL(req.url);
    const matched = route(req.method, url.pathname);
    const tokenRoute = matched !== null && "token" in matched;
    const routeName = matched?.kind ?? "unknown";
    const key = req.headers.get(ESTIMATOR_KEY_HEADER);
    let tenantId: string | null = null;
    let keyId: string | null = null;
    let cors: Record<string, string> = {};
    try {
      // 1. Who is asking.
      if (key !== null) {
        cors = { "access-control-allow-origin": origin ?? "*", vary: "Origin" };
        // A path that NAMES its company (`resolveTenant`: /api/t/{web address}/…)
        // answers as that company and no other (review SEC-2A-04). A key is a
        // company's own website's pass, not a way to borrow another company's
        // address: Green Acres' key under Summit's web address used to answer
        // as Green Acres under Summit's name, and anything that later trusts
        // the path's company (its throttle, its branding, its logs) would have
        // mixed the two up. So the key is checked AS the named company's: any
        // other is "not found", and its "last used" is left alone.
        const named = options.resolveTenant ? await options.resolveTenant(req) : undefined;
        if (named === null) throw new HttpError("not_found", NOT_FOUND_MESSAGE);
        const verified = await verifyClientKey(options.db, key, { now: clock(), ...(named !== undefined ? { tenantId: named } : {}) });
        if (!verified && named !== undefined) throw new HttpError("not_found", NOT_FOUND_MESSAGE);
        if (!verified) {
          throw new HttpError("unauthorized", "This estimator key isn't valid. Ask the business for a new one.");
        }
        if (!originAllowed(verified.allowedOrigins, origin)) {
          throw new HttpError("origin_not_allowed", "This estimator isn't set up for this website.");
        }
        tenantId = verified.tenantId;
        keyId = verified.keyId;
      } else {
        if (!options.tenantId && !options.resolveTenant) {
          throw new HttpError("unauthorized", "This estimator needs a key. Ask the business for one.");
        }
        // Before the tenant or any database work: a forged cross-site POST does nothing.
        if (req.method === "POST" && isCrossSiteRequest(req)) {
          throw new HttpError("forbidden", "This request came from another site, so it was refused.");
        }
        tenantId = options.resolveTenant ? await options.resolveTenant(req) : (options.tenantId ?? null);
        if (!tenantId) throw new HttpError("not_found", NOT_FOUND_MESSAGE);
      }
      // 1b. Is the business open (Tenancy 2a, D7)? On BOTH paths — the embed
      // on a suspended company's own website is refused too — before the
      // route, the rate limit and any estimator query. 409, not the usual
      // 403 of estimates_closed: the request was fine, the business is closed.
      if (options.admit) {
        const admission = await options.admit(tenantId, req);
        if (!admission.open) {
          return respond({ error: { code: "estimates_closed", message: admission.message } }, 409, cors, tokenRoute);
        }
      }
      // 2. The route.
      if (!matched) throw new HttpError("not_found", NOT_FOUND_MESSAGE);
      // 3. The rate limit. A throw is a 429 too: every bucket fails closed.
      if (options.rateLimit) {
        let allowed = false;
        try {
          allowed = await options.rateLimit(req, bucketOf(matched.kind), { tenantId, keyId });
        } catch {
          allowed = false;
        }
        if (!allowed) throw new HttpError("rate_limited", "Too many requests. Please slow down and try again shortly.");
      }
      // 4. Settings, once (with the company's basics and the site's ceiling
      // on photo reading), then the route.
      const scoped = tenantId;
      const settings = await resolveEstimatorSettings(options.db, tenantId, {
        ...(options.company ? { company: options.company } : {}),
        ...(options.aiBudgetCeilingCents !== undefined ? { aiBudgetCeilingCents: options.aiBudgetCeilingCents } : {}),
        onError: (error) => {
          try {
            options.onError?.(error, { tenantId: scoped, route: routeName });
          } catch {
            /* contained */
          }
        },
      });
      return await dispatch(req, matched, tenantId, key !== null, settings, clock(), cors);
    } catch (error) {
      return failure(error, cors, tokenRoute, { tenantId, route: routeName }, matched?.kind === "submit" ? SUBMIT_RENAMES : {});
    }
  }

  return { handle };
}
