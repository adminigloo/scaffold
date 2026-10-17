import { lookup } from "node:dns/promises";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";

/**
 * THE CRAWLER'S FRONT DOOR (0.2): every request the search check makes goes
 * through `createSafeFetcher`, because the addresses it fetches are typed by
 * a business owner — and a server that fetches whatever it is told is a
 * server that reads its own cloud's metadata, its database's admin port, or
 * a neighbour's internal dashboard on request (SSRF). So, for EVERY request
 * and every redirect hop:
 *
 *   1. http or https only, on the standard port, no user:password@ in it;
 *   2. the host must be one of the company's own addresses (`allowedHosts`),
 *      and on a host it shares (the app), the path must be one of its own
 *      (`allowUrl`: /t/{its web address}) — a redirect anywhere else is
 *      refused, not followed;
 *   3. the host's addresses are looked up (within a time limit), and ANY
 *      private, loopback, link-local, carrier-grade, documentation, multicast
 *      or metadata IPv4 address refuses the request — and any IPv6 address
 *      outside global unicast (2000::/3, minus its special ranges), so a
 *      mapped, translated or embedded IPv4 can't slip through;
 *   4. the connection is made TO THE ADDRESS THAT WAS CHECKED (the default
 *      transport pins it), so a name that answers differently the second time
 *      ("DNS rebinding") can't swap in 127.0.0.1 between check and connect;
 *   5. bytes per page and time per page are capped; the body stops being
 *      read at the cap and the page is marked cut short.
 *
 * Name lookup and the transport are injectable, so the tests drive all of it
 * with a fake resolver and a fake server — no network.
 */

/** The addresses a host name has (IPv4 and IPv6, as text). */
export type ResolveHost = (hostname: string) => Promise<readonly string[]>;

export interface TransportRequest {
  readonly url: URL;
  /** The checked address to connect to (the name stays in Host and SNI). */
  readonly address: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly signal: AbortSignal;
  readonly maxBytes: number;
}

export interface TransportResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
  /** The body went past `maxBytes` and was cut there. */
  readonly truncated: boolean;
}

/** One HTTP exchange, redirects NOT followed (the fetcher follows them, checking each). */
export type Transport = (request: TransportRequest) => Promise<TransportResponse>;

export interface SafeFetchOptions {
  /** The host names this fetcher may reach. "www." and bare forms both count. */
  readonly allowedHosts: readonly string[];
  readonly resolve?: ResolveHost;
  readonly transport?: Transport;
  /** Default 2 MB. */
  readonly maxBytes?: number;
  /** Default 8 seconds. */
  readonly timeoutMs?: number;
  /** Default 5. */
  readonly maxRedirects?: number;
  readonly userAgent?: string;
  /** Aborts everything in flight (the run's total time). */
  readonly signal?: AbortSignal;
  /**
   * A second rule after the host's: may THIS address be read? (On a host the
   * company shares, only its own pages are.) Asked of every hop. Default: yes.
   */
  readonly allowUrl?: (url: URL) => boolean;
  /** How long a name lookup may take, ms. Default 3 seconds. */
  readonly resolveTimeoutMs?: number;
}

export type RefusalReason =
  | "scheme"
  | "port"
  | "credentials"
  | "foreign_host"
  | "outside_pages"
  | "private_address"
  | "no_address"
  | "too_many_redirects"
  | "bad_address";

export interface FetchedPage {
  /** The address asked for. */
  readonly url: string;
  /** Where it ended up after redirects (the last one fetched). */
  readonly finalUrl: string;
  /** 0 when nothing came back (refused, timed out, unreachable). */
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly text: string;
  readonly bytes: number;
  readonly truncated: boolean;
  /** Why it was refused before or during the fetch; null when it wasn't. */
  readonly refused: RefusalReason | null;
  /** For a refusal: the address that was refused (a redirect's target, for instance). */
  readonly refusedUrl: string | null;
  /** A network failure or timeout, in a few words; null when there wasn't one. */
  readonly error: string | null;
}

export const DEFAULT_USER_AGENT = "AdminIgloo-SearchCheck/0.2 (a site check its owner asked for)";
export const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
export const DEFAULT_TIMEOUT_MS = 8_000;

// ---------------------------------------------------------------------------
// Which addresses are never fetched
// ---------------------------------------------------------------------------

function v4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    value = value * 256 + n;
  }
  return value;
}

const V4_BLOCKED: readonly (readonly [string, number])[] = [
  ["0.0.0.0", 8], // "this network"
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // carrier-grade NAT (and some clouds' metadata)
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local, the cloud metadata address
  ["172.16.0.0", 12], // private
  ["192.0.0.0", 24], // protocol assignments
  ["192.0.2.0", 24], // documentation
  ["192.88.99.0", 24], // 6to4 relay
  ["192.168.0.0", 16], // private
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // documentation
  ["203.0.113.0", 24], // documentation
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, and broadcast
];

function v4Blocked(ip: string): boolean {
  const value = v4ToInt(ip);
  if (value === null) return true;
  for (const [base, bits] of V4_BLOCKED) {
    const start = v4ToInt(base)!;
    const size = 2 ** (32 - bits);
    if (value >= start && value < start + size) return true;
  }
  return false;
}

/** An IPv6 address as eight 16-bit groups; null when it isn't one. */
function v6Groups(ip: string): number[] | null {
  let text = ip.toLowerCase();
  const zone = text.indexOf("%");
  if (zone >= 0) text = text.slice(0, zone);
  // A trailing dotted IPv4 (::ffff:1.2.3.4) becomes two groups.
  const dotted = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text);
  if (dotted) {
    const value = v4ToInt(dotted[1]!);
    if (value === null) return null;
    text = `${text.slice(0, -dotted[1]!.length)}${(value >>> 16).toString(16)}:${(value & 0xffff).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const parse = (part: string) => (part === "" ? [] : part.split(":"));
  const head = parse(halves[0]!);
  const tail = halves.length === 2 ? parse(halves[1]!) : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? head.length !== 8 : missing < 1) return null;
  const all = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...tail];
  const groups: number[] = [];
  for (const group of all) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
    groups.push(parseInt(group, 16));
  }
  return groups.length === 8 ? groups : null;
}

/**
 * IPv6: ONLY GLOBAL UNICAST (2000::/3) is ever connected to, minus its
 * special ranges. Everything else — ::, ::1, IPv4-mapped ::ffff:0:0/96 and
 * translated ::ffff:0:0:0/96, NAT64 64:ff9b::/96, unique local, link-local,
 * multicast, discard — is refused without asking what IPv4 it may carry.
 */
function v6Blocked(ip: string): boolean {
  const g = v6Groups(ip);
  if (!g) return true;
  const [a, b] = [g[0]!, g[1]!];
  if ((a & 0xe000) !== 0x2000) return true; // outside 2000::/3
  if (a === 0x2001 && b < 0x200) return true; // 2001::/23 protocol assignments (Teredo, ORCHID included)
  if (a === 0x2001 && b === 0xdb8) return true; // documentation
  if (a === 0x2002) return true; // 6to4: an IPv4 hiding inside
  if ((a & 0xfff0) === 0x3ff0) return true; // 3fff::/20 documentation
  return false;
}

/**
 * Is this IP address one the crawler must never connect to? True for
 * anything private, loopback, link-local, carrier-grade, reserved,
 * documentation or multicast — and for anything that doesn't parse.
 */
export function isBlockedAddress(ip: string): boolean {
  const bare = ip.startsWith("[") && ip.endsWith("]") ? ip.slice(1, -1) : ip;
  const kind = isIP(bare.split("%")[0] ?? "");
  if (kind === 4) return v4Blocked(bare);
  if (kind === 6) return v6Blocked(bare);
  return true;
}

/** Names that are never public whatever they resolve to. */
function blockedName(host: string): boolean {
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host.endsWith(".home.arpa") ||
    host === "metadata" ||
    !host.includes(".")
  );
}

/** A host name as compared: lower-cased, no trailing dot, no "www.". */
export function bareHostName(host: string): string {
  return host.toLowerCase().replace(/\.$/, "").replace(/^www\./, "");
}

// ---------------------------------------------------------------------------
// The default transport: node's own http/https, pinned to the checked address
// ---------------------------------------------------------------------------

function flattenHeaders(headers: IncomingHttpHeaders): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    out[name.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value;
  }
  return out;
}

/**
 * Connects to `address` — the one that was checked — never re-resolving the
 * name: `lookup` hands back exactly that address. The name still goes in the
 * Host header and in TLS (SNI and the certificate check), so https works as
 * it would for any visitor.
 */
export const nodeTransport: Transport = (req) =>
  new Promise<TransportResponse>((resolve, reject) => {
    const family = isIP(req.address) === 6 ? 6 : 4;
    const send = req.url.protocol === "https:" ? httpsRequest : httpRequest;
    const outgoing = send(
      req.url,
      {
        method: "GET",
        headers: req.headers,
        signal: req.signal,
        lookup: (_hostname, options, callback) => {
          // Node asks for every address when `all` is set; answer the one checked.
          if ((options as { all?: boolean }).all) {
            (callback as (err: null, addresses: { address: string; family: number }[]) => void)(null, [{ address: req.address, family }]);
          } else {
            (callback as (err: null, address: string, family: number) => void)(null, req.address, family);
          }
        },
      },
      (incoming) => {
        const chunks: Buffer[] = [];
        let total = 0;
        let truncated = false;
        incoming.on("data", (chunk: Buffer) => {
          if (truncated) return;
          const room = req.maxBytes - total;
          if (chunk.byteLength > room) {
            if (room > 0) chunks.push(chunk.subarray(0, room));
            total = req.maxBytes;
            truncated = true;
            incoming.destroy();
            resolve({ status: incoming.statusCode ?? 0, headers: flattenHeaders(incoming.headers), body: new Uint8Array(Buffer.concat(chunks)), truncated: true });
            return;
          }
          chunks.push(chunk);
          total += chunk.byteLength;
        });
        incoming.on("end", () => {
          if (!truncated) resolve({ status: incoming.statusCode ?? 0, headers: flattenHeaders(incoming.headers), body: new Uint8Array(Buffer.concat(chunks)), truncated: false });
        });
        incoming.on("error", (error) => {
          if (!truncated) reject(error);
        });
      },
    );
    outgoing.on("error", reject);
    outgoing.end();
  });

async function systemResolve(hostname: string): Promise<readonly string[]> {
  const found = await lookup(hostname, { all: true, verbatim: true });
  return found.map((entry) => entry.address);
}

// ---------------------------------------------------------------------------
// The fetcher
// ---------------------------------------------------------------------------

export interface SafeFetcher {
  fetch(url: string): Promise<FetchedPage>;
  /** Is this address one this fetcher may even try (scheme, port, host)? */
  mayFetch(url: string): boolean;
}

function refusedPage(url: string, finalUrl: string, reason: RefusalReason, refusedUrl: string): FetchedPage {
  return { url, finalUrl, status: 0, headers: {}, text: "", bytes: 0, truncated: false, refused: reason, refusedUrl, error: null };
}

/** A timer-and-parent signal, cleaned up by the caller. */
function timeoutSignal(ms: number, parent: AbortSignal | undefined): { signal: AbortSignal; done: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("timed out")), ms);
  const onParent = () => controller.abort(new Error("out of time"));
  if (parent) {
    if (parent.aborted) controller.abort(new Error("out of time"));
    else parent.addEventListener("abort", onParent, { once: true });
  }
  return {
    signal: controller.signal,
    done: () => {
      clearTimeout(timer);
      parent?.removeEventListener("abort", onParent);
    },
  };
}

export function createSafeFetcher(options: SafeFetchOptions): SafeFetcher {
  const allowed = new Set(options.allowedHosts.map(bareHostName).filter((host) => host !== ""));
  const resolveHost = options.resolve ?? systemResolve;
  const transport = options.transport ?? nodeTransport;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRedirects = options.maxRedirects ?? 5;
  const userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
  const resolveTimeoutMs = options.resolveTimeoutMs ?? 3_000;

  /** The first rule this address breaks, before any lookup; null when it breaks none. */
  function shapeRefusal(url: URL): RefusalReason | null {
    if (url.protocol !== "https:" && url.protocol !== "http:") return "scheme";
    // A port the URL keeps is never the standard one (the parser drops :80 and :443).
    if (url.port !== "") return "port";
    if (url.username !== "" || url.password !== "") return "credentials";
    const host = url.hostname.replace(/^\[|\]$/g, "");
    // An address typed as an IP is checked as one; a company's site is a name.
    if (isIP(host) !== 0) {
      if (isBlockedAddress(host)) return "private_address";
      if (!allowed.has(host)) return "foreign_host";
      return options.allowUrl && !options.allowUrl(url) ? "outside_pages" : null;
    }
    if (blockedName(host.toLowerCase().replace(/\.$/, ""))) return "private_address";
    if (!allowed.has(bareHostName(host))) return "foreign_host";
    if (options.allowUrl && !options.allowUrl(url)) return "outside_pages";
    return null;
  }

  async function addressFor(url: URL): Promise<{ address: string } | { refused: RefusalReason }> {
    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (isIP(host) !== 0) return { address: host };
    let addresses: readonly string[];
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      addresses = await Promise.race([
        resolveHost(host),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("the name lookup timed out")), resolveTimeoutMs);
        }),
      ]);
    } catch {
      return { refused: "no_address" };
    } finally {
      clearTimeout(timer);
    }
    if (addresses.length === 0) return { refused: "no_address" };
    // ANY bad address refuses: a name with one public and one private answer
    // is a name that can be made to point inside.
    if (addresses.some(isBlockedAddress)) return { refused: "private_address" };
    return { address: addresses[0]! };
  }

  return {
    mayFetch(raw: string): boolean {
      try {
        return shapeRefusal(new URL(raw)) === null;
      } catch {
        return false;
      }
    },

    async fetch(raw: string): Promise<FetchedPage> {
      let url: URL;
      try {
        url = new URL(raw);
      } catch {
        return refusedPage(raw, raw, "bad_address", raw);
      }
      url.hash = "";
      for (let hop = 0; hop <= maxRedirects; hop += 1) {
        const refusal = shapeRefusal(url);
        if (refusal) return refusedPage(raw, url.toString(), refusal, url.toString());
        const target = await addressFor(url);
        if ("refused" in target) return refusedPage(raw, url.toString(), target.refused, url.toString());
        const timer = timeoutSignal(timeoutMs, options.signal);
        let response: TransportResponse;
        try {
          response = await transport({
            url,
            address: target.address,
            headers: { "user-agent": userAgent, accept: "text/html,application/xhtml+xml,text/plain,application/xml;q=0.9,*/*;q=0.5" },
            signal: timer.signal,
            maxBytes,
          });
        } catch (error) {
          const why = timer.signal.aborted ? String((timer.signal.reason as Error | undefined)?.message ?? "timed out") : error instanceof Error ? error.message : String(error);
          return { url: raw, finalUrl: url.toString(), status: 0, headers: {}, text: "", bytes: 0, truncated: false, refused: null, refusedUrl: null, error: why.slice(0, 200) };
        } finally {
          timer.done();
        }
        const location = response.headers["location"];
        if (response.status >= 300 && response.status < 400 && location) {
          let next: URL;
          try {
            next = new URL(location, url);
          } catch {
            return refusedPage(raw, url.toString(), "bad_address", location);
          }
          next.hash = "";
          url = next;
          continue;
        }
        return {
          url: raw,
          finalUrl: url.toString(),
          status: response.status,
          headers: response.headers,
          text: new TextDecoder("utf-8", { fatal: false }).decode(response.body),
          bytes: response.body.byteLength,
          truncated: response.truncated,
          refused: null,
          refusedUrl: null,
          error: null,
        };
      }
      return refusedPage(raw, url.toString(), "too_many_redirects", url.toString());
    },
  };
}
