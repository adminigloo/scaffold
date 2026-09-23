import { createEstimatorHandlers } from "__SCOPE__/estimator";
import { db } from "@/db";
import { runEstimatorTakeoff } from "@/server/estimator-takeoff";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The estimator's embed platform — the keyed, cross-origin API the
 * __SCOPE__/estimator-widget calls from a customer's own website. Thin app
 * code that mounts the package's handler factory (which owns auth, tenant
 * resolution, CORS, and the wire contract) and injects the two things that must
 * live in the app: the photo takeoff (AI + metering + rate limiting, shared with
 * the same-origin route) and — later — a lead notification. Mirrors how
 * /api/igloo mounts the feedback handlers.
 */
const handlers = createEstimatorHandlers({
  db,
  runTakeoff: async (request) => {
    const out = await runEstimatorTakeoff({
      tenantId: request.tenantId,
      measurementMode: request.measurementMode,
      productContext: request.productContext,
      imageBase64: request.imageBase64,
      mediaType: request.mediaType,
      ip: request.ip,
    });
    // A rate-limited embed call degrades to manual entry, like a missing key.
    return { available: out.available, result: out.rateLimited ? null : out.result };
  },
});

export const GET = handlers.handle;
export const POST = handlers.handle;
export const OPTIONS = handlers.handle;
