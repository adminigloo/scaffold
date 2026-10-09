/**
 * May this deployment be indexed? PRODUCTION ONLY, and failing closed.
 *
 * A preview or staging deployment carries the real copy at a URL nobody
 * guards; once crawled it competes with the real site for its own brand
 * terms, and undoing that is a removal request and weeks of waiting. So
 * anything that is not positively production is not indexable: a missing
 * env, a missing host, localhost, an IP address, a platform preview host.
 *
 * `env` is your deployment environment: `VERCEL_ENV`, or `APP_ENV`, or
 * `resolveAppEnv()` from @adminigloo/env. Never `NODE_ENV`: it is
 * "production" in every `next build`, previews included.
 *
 * `host` is the hostname the site is served on, or its URL
 * (`NEXT_PUBLIC_APP_URL`), or the request's Host header.
 *
 * `productionHosts` pins the answer to your real domain(s). With it, ONLY
 * those hosts are indexable, so `www.riddlergo.com` serving a duplicate of
 * `riddlergo.com` (until the www redirect is set) refuses crawlers too.
 * Without it, well-known preview and local hosts are refused.
 */
export interface IndexableInput {
  env: string | null | undefined;
  host: string | null | undefined;
  productionHosts?: string | readonly string[];
}

const NON_PRODUCTION_SUFFIXES = [
  ".localhost",
  ".local",
  ".test",
  ".example",
  ".invalid",
  ".internal",
  ".vercel.app",
  ".netlify.app",
  ".pages.dev",
  ".workers.dev",
  ".ngrok.io",
  ".ngrok-free.app",
  ".ngrok.app",
  ".trycloudflare.com",
];

/** "https://Example.com:443/x" or "example.com:3000" → "example.com". */
export function hostnameOf(value: string): string {
  let host = value.trim().toLowerCase();
  if (/^[a-z][a-z0-9+.-]*:\/\//.test(host)) {
    try {
      host = new URL(host).hostname;
    } catch {
      return "";
    }
  } else {
    host = host.split("/")[0] ?? "";
    if (host.startsWith("[")) host = host.slice(0, host.indexOf("]") + 1);
    else if (host.split(":").length === 2) host = host.split(":")[0] ?? "";
  }
  return host.replace(/\.$/, "");
}

function isIpLiteral(host: string): boolean {
  if (host.startsWith("[") || host.includes(":")) return true;
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
}

export function isIndexable(input: IndexableInput): boolean {
  const env = typeof input.env === "string" ? input.env.trim().toLowerCase() : "";
  if (env !== "production") return false;
  const host = typeof input.host === "string" ? hostnameOf(input.host) : "";
  if (host === "" || !host.includes(".") || isIpLiteral(host)) return false;
  if (input.productionHosts !== undefined) {
    const allowed = (typeof input.productionHosts === "string" ? [input.productionHosts] : input.productionHosts).map(hostnameOf);
    return allowed.includes(host);
  }
  if (host === "localhost") return false;
  return !NON_PRODUCTION_SUFFIXES.some((suffix) => host.endsWith(suffix));
}
