import { and, eq } from "drizzle-orm";
import { ZodError } from "zod";
import {
  calculateEstimate,
  createPublicEstimate,
  DEFAULT_TAX_RATE_BP,
  ESTIMATOR_KEY_HEADER,
  EstimatorInputError,
  listProducts,
  listPublicOptions,
  verifyClientKey,
  type CalculateEstimateInput,
  type EstimatorDb,
  type ProductRow,
  type PublicSubmitInput,
  type VerifiedClientKey,
} from "./index.js";
import { estimatorProducts } from "./schema.js";
import type { TakeoffResult } from "./takeoff.js";

/**
 * The embed platform: keyed, cross-origin HTTP the widget calls from a
 * customer's own website. Mirrors @adminigloo/feedback's handler factory — the
 * client key in `x-adminigloo-key` resolves the tenant, every read and write is
 * scoped to it, and only the quoted range and customer-facing option prices
 * leave the server (never the rate table). CORS is `*` because the key gates and
 * no cookies ride along.
 */

const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": `content-type, ${ESTIMATOR_KEY_HEADER}`,
  "access-control-max-age": "86400",
};

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...CORS_HEADERS },
  });
}

interface EmbedProduct {
  id: string;
  name: string;
  category: string | null;
  description: string | null;
  measurementMode: string;
  isEstimatable: boolean;
}

/**
 * The photo-takeoff call, injected by the host so the AI SDK, the metering, and
 * the rate limiting stay in the app — the package owns the contract, not the
 * provider. Absent, /v1/takeoff answers `{available:false}` and the widget
 * falls back to manual entry (configuration-not-flags, like storage's uploads).
 */
export interface EmbedTakeoffRequest {
  tenantId: string;
  productId: string;
  measurementMode: string;
  productContext: string;
  imageBase64: string;
  mediaType: string;
  ip: string | null;
}
export type EstimatorTakeoffRunner = (
  request: EmbedTakeoffRequest,
) => Promise<{ available: boolean; result: TakeoffResult | null }>;

export interface EstimatorHandlersOptions {
  db: EstimatorDb;
  runTakeoff?: EstimatorTakeoffRunner;
  /**
   * The sales-tax rate (bp) a submitted estimate is taxed at, per tenant — a
   * number for every tenant, or a lookup. The widget's body is never asked:
   * it used to carry `taxRateBp` (and `discount`, and a `unitPrice` per line)
   * straight into the saved estimate. Absent, `DEFAULT_TAX_RATE_BP` (8.25%)
   * applies — a documented default, not an error; set it for your jurisdiction.
   */
  taxRateBp?: number | ((tenantId: string) => number | Promise<number>);
  /**
   * Called after a lead is saved — the host wires its own notification. Awaited,
   * but a throw is swallowed: a broken listener must not fail the customer's
   * submit.
   */
  onLead?: (lead: {
    tenantId: string;
    estimateId: string;
    estimateNumber: string;
  }) => void | Promise<void>;
}

export interface EstimatorHandlers {
  handle: (request: Request) => Promise<Response>;
}

export function createEstimatorHandlers(options: EstimatorHandlersOptions): EstimatorHandlers {
  const { db, runTakeoff, onLead, taxRateBp } = options;

  async function authenticate(request: Request): Promise<VerifiedClientKey | Response> {
    const key = request.headers.get(ESTIMATOR_KEY_HEADER);
    if (!key) return jsonResponse({ error: `missing ${ESTIMATOR_KEY_HEADER} header` }, 401);
    const verified = await verifyClientKey(db, key);
    return verified ?? jsonResponse({ error: "unknown or revoked key" }, 401);
  }

  /** A product the PUBLIC may use: this key's tenant's, active, shown in the estimator. */
  async function publicProduct(productId: string, tenantId: string): Promise<ProductRow | null> {
    const [row] = await db
      .select()
      .from(estimatorProducts)
      .where(
        and(
          eq(estimatorProducts.id, productId),
          eq(estimatorProducts.tenantId, tenantId),
          eq(estimatorProducts.isActive, true),
          eq(estimatorProducts.showInEstimator, true),
        ),
      )
      .limit(1);
    return (row as ProductRow | undefined) ?? null;
  }

  async function tenantTaxRate(tenantId: string): Promise<number> {
    if (taxRateBp === undefined) return DEFAULT_TAX_RATE_BP;
    return typeof taxRateBp === "function" ? await taxRateBp(tenantId) : taxRateBp;
  }

  return {
    async handle(request: Request): Promise<Response> {
      if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: CORS_HEADERS });
      }

      const auth = await authenticate(request);
      if (auth instanceof Response) return auth;
      const { pathname } = new URL(request.url);

      try {
        if (request.method === "GET" && pathname.endsWith("/v1/config")) {
          const products = await listProducts(db, auth.tenantId, { publicOnly: true });
          const trimmed: EmbedProduct[] = products.map((p) => ({
            id: p.id,
            name: p.name,
            category: p.category,
            description: p.description,
            measurementMode: p.measurementMode,
            isEstimatable: p.isEstimatable,
          }));
          return jsonResponse({ products: trimmed });
        }

        if (request.method === "POST" && pathname.endsWith("/v1/options")) {
          const body = (await request.json()) as { productId?: unknown };
          if (typeof body.productId !== "string") return jsonResponse({ options: [] });
          // Staff-only options (showInEstimator: false) never leave the server.
          return jsonResponse({
            options: await listPublicOptions(db, auth.tenantId, body.productId),
          });
        }

        if (request.method === "POST" && pathname.endsWith("/v1/calculate")) {
          const body = (await request.json()) as CalculateEstimateInput;
          // Scoped to the key's tenant and the public audience: another
          // workspace's product, a hidden one, or a staff-only option prices
          // as nothing.
          return jsonResponse({
            result: await calculateEstimate(db, body, {
              tenantId: auth.tenantId,
              audience: "public",
            }),
          });
        }

        if (request.method === "POST" && pathname.endsWith("/v1/submit")) {
          const body = (await request.json()) as PublicSubmitInput;
          // The PUBLIC create: the body names products, measurements, quantities
          // and options only. Prices, labor, discount, tax and photo are the
          // server's; the tenant is the key's, and every product must be its.
          const created = await createPublicEstimate(db, body, {
            tenantId: auth.tenantId,
            taxRateBp: await tenantTaxRate(auth.tenantId),
          });
          if (onLead) {
            try {
              await onLead({
                tenantId: auth.tenantId,
                estimateId: created.id,
                estimateNumber: created.estimateNumber,
              });
            } catch {
              // A broken listener must not fail the customer's submit.
            }
          }
          return jsonResponse(created);
        }

        if (request.method === "POST" && pathname.endsWith("/v1/takeoff")) {
          if (!runTakeoff) return jsonResponse({ available: false, result: null });
          const body = (await request.json()) as {
            productId?: unknown;
            imageBase64?: unknown;
            mediaType?: unknown;
          };
          if (
            typeof body.productId !== "string" ||
            typeof body.imageBase64 !== "string" ||
            typeof body.mediaType !== "string"
          ) {
            return jsonResponse({ error: "bad request" }, 400);
          }
          const owned = await publicProduct(body.productId, auth.tenantId);
          if (!owned) return jsonResponse({ error: "unknown product" }, 404);
          const ip =
            request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
            request.headers.get("x-real-ip");
          const out = await runTakeoff({
            tenantId: auth.tenantId,
            productId: owned.id,
            measurementMode: owned.measurementMode,
            productContext: [owned.name, owned.description].filter(Boolean).join(" — "),
            imageBase64: body.imageBase64,
            mediaType: body.mediaType,
            ip,
          });
          return jsonResponse(out);
        }

        return jsonResponse({ error: "not found" }, 404);
      } catch (error) {
        // A refused submit says why (e.g. "product_unavailable"), so the widget
        // can tell a stale catalog from a missing contact detail.
        if (error instanceof EstimatorInputError) {
          return jsonResponse({ error: error.code }, 400);
        }
        if (error instanceof ZodError) {
          return jsonResponse({ error: "invalid request" }, 400);
        }
        return jsonResponse({ error: "bad request" }, 400);
      }
    },
  };
}
