import { buildEstimatorEmbedHandlers } from "@/server/estimator";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * The estimate on a company's OWN website (the embed): requests carrying the
 * company's embed key, checked against the key's allowed websites, with CORS
 * for that page. Estimate settings → Website embed makes the key and shows the
 * snippet.
 *
 * KEYED REQUESTS ONLY. In a companies project there is no single business for
 * a keyless request to mean, so one without a key is told it needs one; the
 * company's own pages use /api/t/{web address}/estimator instead.
 */
const { handle } = buildEstimatorEmbedHandlers();

export const GET = handle;
export const POST = handle;
export const OPTIONS = handle;
