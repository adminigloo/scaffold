import {
  calculateEstimate,
  createEstimate,
  ESTIMATOR_KEY_HEADER,
  getProductDetail,
  listProducts,
  verifyClientKey,
  type CalculateEstimateInput,
  type CreateEstimateInput,
  type EstimatorDb,
  type ProductRow,
  type VerifiedClientKey,
} from "./index.js";
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
  const { db, runTakeoff, onLead } = options;

  async function authenticate(request: Request): Promise<VerifiedClientKey | Response> {
    const key = request.headers.get(ESTIMATOR_KEY_HEADER);
    if (!key) return jsonResponse({ error: `missing ${ESTIMATOR_KEY_HEADER} header` }, 401);
    const verified = await verifyClientKey(db, key);
    return verified ?? jsonResponse({ error: "unknown or revoked key" }, 401);
  }

  async function ownedProduct(productId: string, tenantId: string): Promise<ProductRow | null> {
    const detail = await getProductDetail(db, productId);
    if (!detail || detail.product.tenantId !== tenantId) return null;
    return detail.product;
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
          const detail = await getProductDetail(db, body.productId);
          if (!detail || detail.product.tenantId !== auth.tenantId) return jsonResponse({ options: [] });
          return jsonResponse({
            options: detail.options.map((o) => ({
              id: o.option.id,
              name: o.option.name,
              values: o.values.map((v) => ({
                id: v.id,
                label: v.label,
                priceModifier: v.priceModifier,
                isDefault: v.isDefault,
              })),
            })),
          });
        }

        if (request.method === "POST" && pathname.endsWith("/v1/calculate")) {
          const body = (await request.json()) as CalculateEstimateInput;
          const owned = await ownedProduct(body.productId, auth.tenantId);
          if (!owned) return jsonResponse({ result: null });
          return jsonResponse({ result: await calculateEstimate(db, body) });
        }

        if (request.method === "POST" && pathname.endsWith("/v1/submit")) {
          const body = (await request.json()) as Omit<CreateEstimateInput, "tenantId" | "source"> & {
            source?: "public_tool" | "photo";
          };
          // Every referenced product must belong to this key's tenant, so one
          // key cannot price another workspace's catalog into a saved estimate.
          const ownedIds = new Set((await listProducts(db, auth.tenantId)).map((p) => p.id));
          for (const item of body.items ?? []) {
            if (item.productId && !ownedIds.has(item.productId)) {
              return jsonResponse({ error: "unknown product" }, 400);
            }
          }
          const created = await createEstimate(db, {
            ...body,
            tenantId: auth.tenantId,
            source: body.source === "photo" ? "photo" : "public_tool",
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
          const owned = await ownedProduct(body.productId, auth.tenantId);
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
      } catch {
        return jsonResponse({ error: "bad request" }, 400);
      }
    },
  };
}
