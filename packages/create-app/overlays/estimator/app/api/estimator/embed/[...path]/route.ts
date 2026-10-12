// Written here, not re-exported: Next reads a route's segment config from the
// file itself and refuses one passed through from another module.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * The 0.2 embed's address, kept: a widget pasted onto another website before
 * estimator 0.3 calls /api/estimator/embed/v1/…, and it must keep working
 * without anybody touching that website.
 *
 * The SAME handler as /api/estimator — one factory serves the business's own
 * pages and the keyed embed (a request carrying `x-adminigloo-key` is checked
 * against the key's allowed websites and gets CORS for that page; one without
 * a key is same-site only). The handler routes by the path's ending, so both
 * addresses answer identically. New embeds use /api/estimator (Estimate
 * settings → Website embed shows the snippet).
 */
export { GET, OPTIONS, POST } from "../../[...path]/route";
