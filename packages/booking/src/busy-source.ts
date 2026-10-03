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
 * The DNS check is BEST-EFFORT against rebinding: the name is resolved and
 * every answer checked just before each fetch, but fetch resolves again on
 * its own, so a hostile DNS server answering public then private within that
 * gap is not stopped. Pinning the checked address would need a runtime
 * specific HTTP agent; the check still closes every name that simply points
 * inside (localtest.me, a typo'd internal host). node:dns is loaded lazily,
 * so this module imports on runtimes without it; there the check is skipped
 * (pass `resolveHost` to supply one).
 */

import { privateHostReason, isPublicAddress } from "./address.js";
import type { Interval } from "./engine.js";
import { expandBusy, IcsParseError, parseIcsCalendar, type ParsedCalendar } from "./ical.js";

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

export interface CreateIcsBusySourceOptions {
  /** Injected for tests and for runtimes with their own fetch; defaults to global fetch. */
  fetchImpl?: typeof fetch;
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
   * Every address the name answers with must be public. An IP literal was
   * already judged by normalizeIcsUrl; a name with no resolver available is
   * let through (see the module doc — best-effort).
   */
  async function assertResolvesPublic(url: URL, signal: AbortSignal): Promise<void> {
    const hostname = url.hostname.replace(/^\[|\]$/g, "").replace(/\.+$/, "");
    if (/^[\d.]+$/.test(hostname) || hostname.includes(":")) return;
    const resolve = options.resolveHost === undefined ? await defaultResolver() : options.resolveHost;
    if (!resolve) return;
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
  }

  /** GET with redirects followed by hand: at most `maxRedirects`, each target re-validated in full. */
  async function fetchCalendarText(start: URL, signal: AbortSignal): Promise<string> {
    const fetchImpl = options.fetchImpl ?? globalThis.fetch;
    if (typeof fetchImpl !== "function") throw new BusySourceError("no fetch implementation available");
    let url = start;
    for (let hop = 0; ; hop += 1) {
      await assertResolvesPublic(url, signal);
      const response = await fetchImpl(url.toString(), {
        signal,
        headers: { accept: "text/calendar, text/plain;q=0.5" },
        redirect: "manual",
      });
      if (REDIRECT_STATUSES.has(response.status)) {
        const location = response.headers.get("location");
        await response.body?.cancel().catch(() => undefined);
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

  return {
    async busy({ host, from, to }): Promise<Interval[]> {
      if (!host.busyIcsUrl) return [];
      const url = normalizeIcsUrl(host.busyIcsUrl);
      const calendar = await load(url, host.timezone);
      return expandBusy(calendar, {
        from,
        to,
        timezone: host.timezone,
        maxInstances: options.maxInstances ?? 5_000,
      });
    },
  };
}
