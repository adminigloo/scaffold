import { NextResponse } from "next/server";
import { z } from "zod";
import { getProductDetail } from "__SCOPE__/estimator";
import { isDbConfigured } from "__SCOPE__/db";
import { db } from "@/db";
import { ESTIMATOR_TENANT, ensureDemoCatalog } from "@/server/estimator-seed";
import { runEstimatorTakeoff } from "@/server/estimator-takeoff";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Photo-assisted takeoff for the SAME-ORIGIN public tool on this site (the
 * embed on a customer's own site goes through the keyed platform handler at
 * /api/estimator/embed). Both call the one shared `runEstimatorTakeoff`, which
 * owns the configured/rate-limit/meter order; this route only resolves the
 * product for the fixed dogfood tenant and shapes the response.
 */
const MEDIA_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"] as const;

const Body = z
  .object({
    productId: z.string().min(1).max(200),
    imageBase64: z.string().min(16).max(7_000_000),
    mediaType: z.enum(MEDIA_TYPES),
  })
  .strict();

function clientIp(request: Request): string | null {
  const fwd = request.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0]!.trim();
  return request.headers.get("x-real-ip");
}

export async function POST(request: Request): Promise<Response> {
  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await request.json());
  } catch {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }

  // Degrade, don't 500: with no database the tool falls back to manual entry,
  // the same contract the AI side honors when there's no key.
  if (!isDbConfigured(db)) {
    return NextResponse.json({ available: false, result: null });
  }

  await ensureDemoCatalog(db);
  const detail = await getProductDetail(db, body.productId);
  if (!detail || detail.product.tenantId !== ESTIMATOR_TENANT) {
    return NextResponse.json({ error: "unknown product" }, { status: 404 });
  }

  const out = await runEstimatorTakeoff({
    tenantId: ESTIMATOR_TENANT,
    measurementMode: detail.product.measurementMode,
    productContext: [detail.product.name, detail.product.description].filter(Boolean).join(" — "),
    imageBase64: body.imageBase64,
    mediaType: body.mediaType,
    ip: clientIp(request),
  });

  if (out.rateLimited) {
    return NextResponse.json(
      { error: "Too many photo estimates for now — try again shortly, or enter the measurement by hand." },
      { status: 429, headers: out.headers },
    );
  }
  return NextResponse.json({ available: out.available, result: out.result });
}
