// Written here, not re-exported: Next reads a route's segment config from the
// file itself and refuses one passed through from another module.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * The 0.2 embed's address, kept: a widget pasted onto a company's website
 * before estimator 0.3 calls /api/estimator/embed/v1/…, and it must keep
 * working without anybody touching that website. The SAME keyed handler as
 * /api/estimator; it routes by the path's ending, so both answer identically.
 */
export { GET, OPTIONS, POST } from "../../[...path]/route";
