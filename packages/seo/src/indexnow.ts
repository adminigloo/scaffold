import { Issues, SeoError } from "./errors.js";
import { pathRule } from "./paths.js";
import { pageUrl, type Site } from "./site.js";

/**
 * IndexNow: tell Bing, Yandex, Seznam, Naver and the other participating
 * engines the moment a page is published or changed, instead of waiting for
 * a crawl. (Google does not take part; its sitemap still matters.)
 *
 * Two pieces:
 *   1. The key file. The engines fetch `https://{host}/{key}.txt` and expect
 *      the key as its whole body. `indexNowKeyFile(key)` gives the path and
 *      body; serve it from a route or your proxy.
 *   2. `submitUrls(site, urls, { key })` after a publish. Production only:
 *      off production it sends nothing. Batches of up to 10,000 URLs (the
 *      protocol's limit), one POST each, with an injectable `fetch`.
 *
 * The site's path list decides what may be announced, as it decides the
 * sitemap: a URL under a `private` path is a programming error (it throws),
 * and one under a `noindex` path is left out and reported in `excluded`.
 */

export const INDEXNOW_ENDPOINT = "https://api.indexnow.org/indexnow";
export const INDEXNOW_MAX_BATCH = 10_000;

const KEY = /^[A-Za-z0-9-]{8,128}$/;

export function isIndexNowKey(key: unknown): key is string {
  return typeof key === "string" && KEY.test(key);
}

/** The key file: serve `body` as text/plain at `path`. */
export function indexNowKeyFile(key: string): { path: string; body: string; contentType: "text/plain; charset=utf-8" } {
  if (!isIndexNowKey(key)) {
    throw new SeoError("invalid_config", "indexNowKeyFile", ["the key must be 8 to 128 letters, digits or dashes (INDEXNOW_KEY)"]);
  }
  return { path: `/${key}.txt`, body: key, contentType: "text/plain; charset=utf-8" };
}

export interface SubmitUrlsOptions {
  key: string;
  /**
   * Where the key file is, when not at `/{key}.txt`: a path, or a URL on the
   * site's own origin. Its folder bounds which URLs may be submitted (a key at
   * /catalog/key.txt covers /catalog/… only), and that is checked here rather
   * than left to the engine's 422.
   */
  keyLocation?: string;
  /** Default https://api.indexnow.org/indexnow (shared by every participating engine). */
  endpoint?: string;
  /** Default 10,000, the protocol's maximum. */
  batchSize?: number;
  /** Per request. Default 10 seconds. */
  timeoutMs?: number;
  /** Default globalThis.fetch. Inject one for tests or a proxy. */
  fetch?: typeof fetch;
}

export interface IndexNowBatch {
  count: number;
  /** HTTP status, or null when the request never got an answer. */
  status: number | null;
  ok: boolean;
  error?: string;
}

export interface IndexNowResult {
  /** Every batch was accepted (200, or 202 while the key is being checked). */
  ok: boolean;
  /** URLs in accepted batches. */
  submitted: number;
  /** Why nothing was sent, when nothing was. */
  skipped?: "not-indexable" | "no-urls";
  /** URLs left out because the path list marks them noindex (absolute, de-duplicated). */
  excluded?: string[];
  batches: IndexNowBatch[];
}

const STATUS_MEANING: Record<number, string> = {
  400: "bad request: the payload was not understood",
  403: "forbidden: the key file does not hold this key",
  422: "unprocessable: a URL is not on this host, or the key does not match it",
  429: "too many requests: submitting too often",
};

/**
 * Submit changed URLs. Never throws for an engine's answer (each batch
 * reports its status); throws `SeoError` for a bad key, a key file off the
 * site, or a URL that is not on this site, outside the key file's folder or
 * under a private path, which are programming errors. A URL under a noindex
 * path is left out and listed in `excluded`.
 */
export async function submitUrls(site: Site, urls: readonly string[], options: SubmitUrlsOptions): Promise<IndexNowResult> {
  const issues = new Issues("submitUrls", "invalid_config");
  issues.check(isIndexNowKey(options.key), "key must be 8 to 128 letters, digits or dashes (INDEXNOW_KEY)");
  const batchSize = options.batchSize ?? INDEXNOW_MAX_BATCH;
  issues.check(Number.isInteger(batchSize) && batchSize >= 1 && batchSize <= INDEXNOW_MAX_BATCH, `batchSize must be 1 to ${INDEXNOW_MAX_BATCH}`);
  let keyLocation: string | undefined;
  let keyFolder = `${site.url}/`;
  if (options.keyLocation) {
    let resolved: URL | null = null;
    try {
      resolved = new URL(options.keyLocation, `${site.url}/`);
    } catch {
      issues.add(`keyLocation "${options.keyLocation}" is not a path or URL`);
    }
    if (resolved && resolved.origin !== site.url) issues.add(`keyLocation ${resolved.href} is not on ${site.url}: the engines only accept a key file on the host they are told about`);
    else if (resolved) {
      keyLocation = resolved.href;
      keyFolder = `${resolved.origin}${resolved.pathname.slice(0, resolved.pathname.lastIndexOf("/") + 1)}`;
    }
  }
  issues.throwIfAny();

  if (!site.indexable) return { ok: true, submitted: 0, skipped: "not-indexable", batches: [] };

  const seen = new Set<string>();
  const excluded = new Set<string>();
  const bad: string[] = [];
  for (const raw of urls) {
    let url: string;
    try {
      url = pageUrl(site, raw);
    } catch {
      bad.push(`${raw} is not a page on ${site.url}`);
      continue;
    }
    const rule = pathRule(site.paths, url);
    if (rule === "private") bad.push(`${url} is under a private path in the site's path list; it must never be announced`);
    else if (!url.startsWith(keyFolder)) bad.push(`${url} is outside ${keyFolder}, the folder the key file at ${keyLocation} covers`);
    else if (rule === "noindex") excluded.add(url);
    else seen.add(url);
  }
  if (bad.length > 0) {
    throw new SeoError("invalid_input", "submitUrls", bad.slice(0, 5));
  }
  const unique = [...seen];
  const leftOut = excluded.size > 0 ? { excluded: [...excluded] } : {};
  if (unique.length === 0) return { ok: true, submitted: 0, skipped: "no-urls", ...leftOut, batches: [] };

  const doFetch = options.fetch ?? globalThis.fetch;
  const endpoint = options.endpoint ?? INDEXNOW_ENDPOINT;
  const batches: IndexNowBatch[] = [];
  for (let start = 0; start < unique.length; start += batchSize) {
    const urlList = unique.slice(start, start + batchSize);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 10_000);
    try {
      const response = await doFetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({ host: site.host, key: options.key, ...(keyLocation ? { keyLocation } : {}), urlList }),
        signal: controller.signal,
      });
      const ok = response.status === 200 || response.status === 202;
      batches.push({
        count: urlList.length,
        status: response.status,
        ok,
        ...(ok ? {} : { error: STATUS_MEANING[response.status] ?? `unexpected status ${response.status}` }),
      });
    } catch (error) {
      batches.push({
        count: urlList.length,
        status: null,
        ok: false,
        error: controller.signal.aborted ? "timed out" : `request failed: ${(error as Error).message}`,
      });
    } finally {
      clearTimeout(timer);
    }
  }
  return {
    ok: batches.every((batch) => batch.ok),
    submitted: batches.filter((batch) => batch.ok).reduce((sum, batch) => sum + batch.count, 0),
    ...leftOut,
    batches,
  };
}
