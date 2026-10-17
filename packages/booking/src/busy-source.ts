/**
 * The busy-source seam: where a host's REAL calendar comes in.
 *
 * Internal bookings are always busy; this adds the meetings the booking
 * system never heard about — the dentist, the board call — so a prospect is
 * never offered a time the host is already spending elsewhere. It is the one
 * double-booking that neither the .ics invite nor the host feed can prevent.
 *
 * ONE INTERFACE, INJECTED. The handler factory and the services take a
 * `BusySource`; they never import a calendar vendor. The shipped
 * implementation reads a secret iCal address (Google's "Secret address in
 * iCal format", Outlook's published ICS, Fastmail, iCloud public calendars);
 * an OAuth-backed Google or Microsoft source later is one more implementation
 * of the same method, with no call-site change. Squire's equivalent seam was a
 * registry keyed by provider name; an argument is simpler and cannot be
 * forgotten by a refactor (D23's lesson).
 *
 * THE FAILURE CONTRACT. `busy()` THROWS on any failure — network, timeout, a
 * non-calendar body. The caller catches, serves internal-only availability
 * for that request, and records the error on the host so the admin can see
 * "Calendar sync failing since …". A prospect never sees the error. (Squire
 * logged and swallowed inside the provider, which left nobody able to tell
 * that the founder's calendar had stopped being read for a week.)
 *
 * SSRF. The address is typed by staff and fetched by the server, and what
 * comes back is shown (busy blocks in public slots, an event count and the
 * error text in the admin). So the reader refuses anything that is not the
 * public internet, at every hop: the literal host (address.ts, every
 * spelling), every address the name resolves to, and every redirect target —
 * redirects are followed by hand, at most three, each re-validated, never by
 * fetch's `redirect: "follow"` (which went wherever a Location said,
 * 127.0.0.1 included). The body is streamed with a running byte cap, so a
 * server that lies about its length (or sends none) cannot fill memory.
 *
 * THE CHECKED ADDRESS IS THE ONE CONNECTED TO (0.2, the seo-reports net.ts
 * standard). The name is resolved, EVERY answer must be public (one private
 * answer refuses the name), and the request is then made with node's own
 * https pinned to that checked address — so a hostile DNS server answering
 * public, then private, has nothing to rebind. The certificate is still
 * checked against the name. Only an IPv6 address in global unicast
 * (2000::/3) is public. No port may be named (a calendar is on 443). On a
 * runtime without node:dns and node:https the fetch is REFUSED (fail closed)
 * unless the app supplies `resolveHost` and `fetchImpl` — and a custom
 * `fetchImpl` resolves the name again on its own, so with one the check is
 * best-effort against rebinding (it still closes every name that simply
 * points inside). `resolveHost: null` turns the DNS check off deliberately,
 * e.g. behind an egress proxy that already refuses private space.
 */

import { privateHostReason, isPublicAddress } from "./address.js";
import type { Interval } from "./engine.js";
import { expandBusy, FEED_TOO_LARGE_MESSAGE, IcsBudgetError, IcsParseError, parseIcsCalendar, type ParsedCalendar } from "./ical.js";

export interface BusySourceHost {
  id: string;
  timezone: string;
  busyIcsUrl: string | null;
}

export interface BusySource {
  /** Absolute busy intervals overlapping [from, to). Throws on failure — see the module doc. */
  busy(input: { host: BusySourceHost; from: Date; to: Date }): Promise<Array<{ start: Date; end: Date }>>;
}

export class BusySourceError extends Error {
  readonly name = "BusySourceError";
}

/**
 * The host's calendar is too big to read within the budget (0.2). Unlike any
 * other failure, this one FAILS CLOSED: the host is offered no times at all
 * until the address is changed (slots.ts), because a feed that can't be read
 * in full can't be trusted to show the host free.
 */
export class BusyFeedTooLargeError extends BusySourceError {
  readonly tooLarge = true;
  constructor() {
    super(FEED_TOO_LARGE_MESSAGE);
  }
}

export function isFeedTooLarge(error: unknown): boolean {
  return error instanceof BusyFeedTooLargeError || error instanceof IcsBudgetError;
}

/** One GET to `url`, connected to `address` (already checked) — the pinned request (0.2). */
export interface PinnedRequest {
  url: URL;
  /** The checked address to connect to; null only when the DNS check was turned off (`resolveHost: null`). */
  address: string | null;
  headers: Record<string, string>;
  signal: AbortSignal;
  maxBytes: number;
}

/** What a pinned request answers: the status, the Location (if any), and the body read up to `maxBytes` — more throws. */
export interface PinnedResponse {
  status: number;
  location: string | null;
  text: string;
}

export type PinnedTransport = (request: PinnedRequest) => Promise<PinnedResponse>;

let nodeHttps: Promise<typeof import("node:https") | null> | null = null;

/** node's https, pinned to the checked address through `lookup`; null on a runtime without it. */
async function nodePinnedTransport(): Promise<PinnedTransport | null> {
  nodeHttps ??= import("node:https").then(
    (https) => https,
    () => null,
  );
  const https = await nodeHttps;
  if (!https) return null;
  return (req) =>
    new Promise<PinnedResponse>((resolve, reject) => {
      const family = req.address?.includes(":") ? 6 : 4;
      const outgoing = https.request(
        req.url,
        {
          method: "GET",
          headers: req.headers,
          signal: req.signal,
          ...(req.address
            ? {
                lookup: ((_hostname: string, options: { all?: boolean }, callback: (...args: unknown[]) => void) => {
                  // Node asks for every address when `all` is set; answer the one checked.
                  if (options.all) callback(null, [{ address: req.address, family }]);
                  else callback(null, req.address, family);
                }) as never,
              }
            : {}),
        },
        (incoming) => {
          const status = incoming.statusCode ?? 0;
          const location = typeof incoming.headers.location === "string" ? incoming.headers.location : null;
          const declared = Number(incoming.headers["content-length"] ?? "0");
          if (declared > req.maxBytes) {
            incoming.destroy();
            reject(new BusySourceError(`calendar is larger than ${req.maxBytes} bytes`));
            return;
          }
          const chunks: Buffer[] = [];
          let total = 0;
          let failed = false;
          incoming.on("data", (chunk: Buffer) => {
            if (failed) return;
            total += chunk.byteLength;
            if (total > req.maxBytes) {
              failed = true;
              incoming.destroy();
              reject(new BusySourceError(`calendar is larger than ${req.maxBytes} bytes`));
              return;
            }
            chunks.push(chunk);
          });
          incoming.on("end", () => {
            if (!failed) resolve({ status, location, text: Buffer.concat(chunks).toString("utf8") });
          });
          incoming.on("error", (error) => {
            if (!failed) reject(error);
          });
        },
      );
      outgoing.on("error", reject);
      outgoing.end();
    });
}

export interface CreateIcsBusySourceOptions {
  /**
   * A fetch of the app's own, for a runtime without node:https (or a test).
   * It resolves the name again by itself, so the address check is then
   * best-effort against DNS rebinding. Default: node's https, pinned to the
   * checked address.
   */
  fetchImpl?: typeof fetch;
  /** Replaces the pinned node transport (tests). Ignored when `fetchImpl` is given. */
  transport?: PinnedTransport;
  /** How long a fetched feed is reused, per URL. Default 5 minutes. */
  ttlMs?: number;
  /** Per-fetch timeout. Default 5 seconds — a slot page must not hang on Google. */
  timeoutMs?: number;
  /** Largest body accepted. Default 5 MB; a decade of a busy calendar is well under. */
  maxBytes?: number;
  /** Cap on expanded instances per call. Default 5,000. */
  maxInstances?: number;
  /** Clock for the cache. */
  now?: () => number;
  /**
   * Resolves a hostname to every address it answers with, so each can be
   * checked before the fetch. Defaults to node:dns `lookup(…, { all: true })`,
   * loaded lazily; on a runtime without node:dns the check is skipped. Pass
   * one to supply a resolver there (or a fake in tests); pass `null` to turn
   * the check off deliberately — e.g. behind an egress proxy that already
   * refuses private space.
   */
  resolveHost?: ((hostname: string) => Promise<readonly string[]>) | null;
  /** Redirects followed per fetch, each re-validated. Default 3. */
  maxRedirects?: number;
}

/**
 * `webcal://` is how calendar apps hand out subscription links; it is https
 * underneath. Anything that is not https after that is refused — a plain-http
 * secret URL leaks the secret to every hop, and a `file:` or `data:` URL is
 * not a calendar. A host that is private by its spelling (address.ts —
 * loopback, private, link-local, CGNAT, ULA, IPv4-mapped, unspecified, a
 * single-label or .local/.internal name, a trailing dot) is refused here,
 * before any network; a NAME that resolves inside is caught by the DNS check
 * at fetch time.
 */
export function normalizeIcsUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw.trim().replace(/^webcals?:\/\//i, "https://"));
  } catch {
    throw new BusySourceError("calendar address is not a URL");
  }
  if (url.protocol !== "https:") throw new BusySourceError("calendar address must be https");
  if (url.username || url.password) throw new BusySourceError("calendar address must not carry a username or password");
  // The URL parser drops :443, so any port left is a non-standard one (0.2).
  if (url.port !== "") throw new BusySourceError("calendar address must not name a port");
  const reason = privateHostReason(url.hostname);
  if (reason) throw new BusySourceError(reason);
  return url;
}

type Resolver = (hostname: string) => Promise<readonly string[]>;

let nodeResolver: Promise<Resolver | null> | null = null;

/**
 * node:dns, imported on first use rather than at module load, so the package
 * still imports where there is no node:dns (an edge runtime, a worker). There
 * this answers null and the DNS check is skipped — those runtimes' egress is
 * not the server's private network.
 */
function defaultResolver(): Promise<Resolver | null> {
  nodeResolver ??= import("node:dns/promises").then(
    (dns): Resolver =>
      async (hostname) =>
        (await dns.lookup(hostname, { all: true, verbatim: true })).map((entry) => entry.address),
    () => null,
  );
  return nodeResolver;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

interface CacheEntry {
  fetchedAt: number;
  calendar: ParsedCalendar;
}

/** Rejects when the signal aborts — for awaits (like dns.lookup) that cannot be cancelled themselves. */
function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new DOMException("aborted", "AbortError"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new DOMException("aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/**
 * The body as text, counting bytes as they arrive and stopping the moment
 * the cap is passed — `response.text()` would buffer whatever a hostile or
 * broken server sent before the size could be checked.
 */
async function readCapped(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new BusySourceError(`calendar is larger than ${maxBytes} bytes`);
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new BusySourceError(`calendar is larger than ${maxBytes} bytes`);
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

/**
 * The shipped busy source: fetch a host's secret iCal address, parse it once
 * per TTL per URL, and expand it per request across exactly the window asked
 * for. Concurrent requests for the same URL share one fetch. A host with no
 * `busyIcsUrl` has no external busy (an empty list, not an error).
 */
export function createIcsBusySource(options: CreateIcsBusySourceOptions = {}): BusySource {
  const ttlMs = options.ttlMs ?? 300_000;
  const timeoutMs = options.timeoutMs ?? 5_000;
  const maxBytes = options.maxBytes ?? 5 * 1024 * 1024;
  const maxRedirects = options.maxRedirects ?? 3;
  const clock = options.now ?? (() => Date.now());
  const cache = new Map<string, CacheEntry>();
  const inFlight = new Map<string, Promise<ParsedCalendar>>();

  /**
   * Every address the name answers with must be public; the first is the one
   * connected to. An IP literal was already judged by normalizeIcsUrl. With
   * no resolver available the fetch is refused (fail closed); with the check
   * turned off (`resolveHost: null`) there is nothing to pin (null).
   */
  async function assertResolvesPublic(url: URL, signal: AbortSignal): Promise<string | null> {
    const hostname = url.hostname.replace(/^\[|\]$/g, "").replace(/\.+$/, "");
    if (/^[\d.]+$/.test(hostname) || hostname.includes(":")) return hostname;
    if (options.resolveHost === null) return null;
    const resolve = options.resolveHost === undefined ? await defaultResolver() : options.resolveHost;
    if (!resolve) throw new BusySourceError("calendar host could not be checked on this server");
    let addresses: readonly string[];
    try {
      addresses = await abortable(resolve(hostname), signal);
    } catch (error) {
      if (signal.aborted) throw error;
      throw new BusySourceError("calendar host could not be found");
    }
    if (addresses.length === 0) throw new BusySourceError("calendar host could not be found");
    if (!addresses.every((address) => isPublicAddress(address))) {
      throw new BusySourceError("calendar address points at a private network");
    }
    return addresses[0] ?? null;
  }

  /** One hop through the app's own fetch: status, Location, and the body only when it is the answer. */
  async function hopByFetch(fetchImpl: typeof fetch, url: URL, signal: AbortSignal): Promise<PinnedResponse | Response> {
    return fetchImpl(url.toString(), { signal, headers: { accept: "text/calendar, text/plain;q=0.5" }, redirect: "manual" });
  }

  /** GET with redirects followed by hand: at most `maxRedirects`, each target re-validated in full. */
  async function fetchCalendarText(start: URL, signal: AbortSignal): Promise<string> {
    const fetchImpl = options.fetchImpl;
    const transport = fetchImpl ? null : (options.transport ?? (await nodePinnedTransport()));
    if (!fetchImpl && !transport) throw new BusySourceError("no way to fetch a calendar on this server");
    let url = start;
    for (let hop = 0; ; hop += 1) {
      const address = await assertResolvesPublic(url, signal);
      const response: PinnedResponse | Response = fetchImpl
        ? await hopByFetch(fetchImpl, url, signal)
        : await transport!({ url, address, headers: { accept: "text/calendar, text/plain;q=0.5" }, signal, maxBytes });
      const pinned = !(response instanceof Response);
      if (REDIRECT_STATUSES.has(response.status)) {
        const location = pinned ? (response as PinnedResponse).location : (response as Response).headers.get("location");
        if (!pinned) await (response as Response).body?.cancel().catch(() => undefined);
        if (!location) throw new BusySourceError(`calendar fetch failed: HTTP ${response.status} without a Location`);
        if (hop >= maxRedirects) throw new BusySourceError(`calendar address redirected more than ${maxRedirects} times`);
        let next: string;
        try {
          next = new URL(location, url).toString();
        } catch {
          throw new BusySourceError("calendar address redirected to something that is not a URL");
        }
        // The same rules as the address itself: https, no credentials, not private.
        url = normalizeIcsUrl(next);
        continue;
      }
      if (pinned) {
        const answer = response as PinnedResponse;
        if (answer.status < 200 || answer.status >= 300) throw new BusySourceError(`calendar fetch failed: HTTP ${answer.status}`);
        return answer.text;
      }
      // A browser-style runtime hides manual redirects behind an opaque response.
      if (response.type === "opaqueredirect" || response.status === 0) {
        throw new BusySourceError("calendar address redirected, and the redirect could not be checked here");
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new BusySourceError(`calendar fetch failed: HTTP ${response.status}`);
      }
      return readCapped(response, maxBytes);
    }
  }

  async function load(url: URL, fallbackZone: string): Promise<ParsedCalendar> {
    const key = url.toString();
    const cached = cache.get(key);
    if (cached && clock() - cached.fetchedAt < ttlMs) return cached.calendar;
    const pending = inFlight.get(key);
    if (pending) return pending;
    const run = (async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let text: string;
      try {
        text = await fetchCalendarText(url, controller.signal);
      } catch (error) {
        if (error instanceof BusySourceError) throw error;
        if (controller.signal.aborted) throw new BusySourceError(`calendar fetch timed out after ${timeoutMs} ms`);
        throw new BusySourceError(`calendar fetch failed: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        clearTimeout(timer);
      }
      let calendar: ParsedCalendar;
      try {
        calendar = parseIcsCalendar(text, { fallbackZone });
      } catch (error) {
        throw new BusySourceError(
          error instanceof IcsParseError ? `calendar could not be read: ${error.message}` : "calendar could not be read",
        );
      }
      cache.set(key, { fetchedAt: clock(), calendar });
      if (cache.size > 500) cache.delete(cache.keys().next().value as string);
      return calendar;
    })();
    inFlight.set(key, run);
    try {
      return await run;
    } finally {
      inFlight.delete(key);
    }
  }

  /**
   * The expanded busy list, per feed, zone and whole-UTC-day window (0.2):
   * a slot page asks for "now + notice" to the horizon, which moves every
   * millisecond, so the window is widened to whole days and the result reused
   * while the parsed feed is. A feed too large to expand is remembered too,
   * so it is refused without being walked again.
   */
  const expanded = new Map<string, { fetchedAt: number; calendar: ParsedCalendar; busy: Interval[] | null }>();
  const DAY = 86_400_000;

  return {
    async busy({ host, from, to }): Promise<Interval[]> {
      if (!host.busyIcsUrl) return [];
      const url = normalizeIcsUrl(host.busyIcsUrl);
      const calendar = await load(url, host.timezone);
      const dayFrom = Math.floor(from.getTime() / DAY) * DAY;
      const dayTo = Math.ceil(to.getTime() / DAY) * DAY;
      const key = `${url.toString()}|${host.timezone}|${dayFrom}|${dayTo}`;
      let entry = expanded.get(key);
      if (!entry || entry.calendar !== calendar || clock() - entry.fetchedAt >= ttlMs) {
        let busy: Interval[] | null;
        try {
          busy = expandBusy(calendar, {
            from: new Date(dayFrom),
            to: new Date(dayTo),
            timezone: host.timezone,
            maxInstances: options.maxInstances ?? 5_000,
          });
        } catch (error) {
          if (!(error instanceof IcsBudgetError)) throw error;
          busy = null;
        }
        entry = { fetchedAt: clock(), calendar, busy };
        expanded.set(key, entry);
        if (expanded.size > 500) expanded.delete(expanded.keys().next().value as string);
      }
      if (entry.busy === null) throw new BusyFeedTooLargeError();
      const fromMs = from.getTime();
      const toMs = to.getTime();
      return entry.busy
        .filter((interval) => interval.end.getTime() > fromMs && interval.start.getTime() < toMs)
        .map((interval) => ({ start: interval.start, end: interval.end }));
    },
  };
}
