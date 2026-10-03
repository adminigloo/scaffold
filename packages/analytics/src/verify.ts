/**
 * Is a request that CLAIMS to be GPTBot really from OpenAI? Operators publish
 * the IP ranges their crawlers use; a claim from inside them is verified, a
 * claim from anywhere else is just a User-Agent string anybody can type. The
 * IP is checked in memory and never stored — only the boolean is.
 *
 * Lists are fetched on demand, cached (24h by default) and parsed leniently:
 * every published file so far is `{ prefixes: [{ ipv4Prefix | ipv6Prefix }] }`.
 * A list that cannot be fetched verifies nothing — "unverified" is the honest
 * answer when the evidence is missing, never "verified".
 */

/** Bot name (as classifyCrawler names it) → the operator's published range files. */
export const DEFAULT_CRAWLER_RANGE_SOURCES: Record<string, readonly string[]> = {
  GPTBot: ["https://openai.com/gptbot.json"],
  "OAI-SearchBot": ["https://openai.com/searchbot.json"],
  "ChatGPT-User": ["https://openai.com/chatgpt-user.json"],
  PerplexityBot: ["https://www.perplexity.com/perplexitybot.json"],
  "Perplexity-User": ["https://www.perplexity.com/perplexity-user.json"],
  Googlebot: [
    "https://developers.google.com/static/search/apis/ipranges/googlebot.json",
    "https://developers.google.com/static/search/apis/ipranges/special-crawlers.json",
  ],
  GoogleOther: ["https://developers.google.com/static/search/apis/ipranges/googlebot.json"],
  Bingbot: ["https://www.bing.com/toolbox/bingbot.json"],
  Applebot: ["https://search.developer.apple.com/applebot.json"],
};

export interface CrawlerVerifier {
  /** True only when `ip` is inside a published range for `botName`. */
  verify: (botName: string, ip: string | null | undefined) => Promise<boolean>;
}

type Range = { v6: false; base: number; bits: number } | { v6: true; base: bigint; bits: number };

export function parseIPv4(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value;
}

export function parseIPv6(ip: string): bigint | null {
  let address = ip.trim().toLowerCase();
  const zone = address.indexOf("%");
  if (zone >= 0) address = address.slice(0, zone);
  // An embedded IPv4 tail (::ffff:1.2.3.4) becomes two hextets.
  const v4 = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(address);
  if (v4?.[1]) {
    const value = parseIPv4(v4[1]);
    if (value === null) return null;
    address = address.slice(0, -v4[1].length) + `${(value >>> 16).toString(16)}:${(value & 0xffff).toString(16)}`;
  }
  const halves = address.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? head.length !== 8 : missing < 1) return null;
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...tail];
  let value = 0n;
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
    value = (value << 16n) | BigInt(parseInt(group, 16));
  }
  return value;
}

export function parseCidr(cidr: string): Range | null {
  const [address, bitsText] = cidr.trim().split("/");
  if (!address) return null;
  const v6 = address.includes(":");
  const bits = bitsText === undefined ? (v6 ? 128 : 32) : Number(bitsText);
  if (!Number.isInteger(bits) || bits < 0 || bits > (v6 ? 128 : 32)) return null;
  if (v6) {
    const base = parseIPv6(address);
    return base === null ? null : { v6: true, base, bits };
  }
  const base = parseIPv4(address);
  return base === null ? null : { v6: false, base, bits };
}

export function ipInRange(ip: string, range: Range): boolean {
  if (range.v6) {
    const value = parseIPv6(ip);
    if (value === null) return false;
    const shift = BigInt(128 - range.bits);
    return value >> shift === range.base >> shift;
  }
  const value = parseIPv4(ip.startsWith("::ffff:") ? ip.slice(7) : ip);
  if (value === null) return false;
  if (range.bits === 0) return true;
  const shift = 32 - range.bits;
  return Math.floor(value / 2 ** shift) === Math.floor(range.base / 2 ** shift);
}

/** Pull every CIDR out of a published list, whatever its exact shape. */
export function extractPrefixes(body: unknown): string[] {
  const out: string[] = [];
  const visit = (node: unknown) => {
    if (typeof node === "string") {
      if (/^[0-9a-f:.]+\/\d{1,3}$/i.test(node)) out.push(node);
    } else if (Array.isArray(node)) {
      node.forEach(visit);
    } else if (node && typeof node === "object") {
      Object.values(node as Record<string, unknown>).forEach(visit);
    }
  };
  visit(body);
  return out;
}

export function createCrawlerVerifier(
  options: { fetchImpl?: typeof fetch; sources?: Record<string, readonly string[]>; ttlMs?: number; timeoutMs?: number } = {},
): CrawlerVerifier {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sources = options.sources ?? DEFAULT_CRAWLER_RANGE_SOURCES;
  const ttl = options.ttlMs ?? 24 * 60 * 60 * 1000;
  const timeout = options.timeoutMs ?? 4000;
  const cache = new Map<string, { at: number; ranges: Range[]; pending?: Promise<Range[]> }>();

  async function load(url: string): Promise<Range[]> {
    const hit = cache.get(url);
    if (hit && Date.now() - hit.at < ttl) return hit.pending ?? hit.ranges;
    const pending = (async () => {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeout);
        const res = await fetchImpl(url, { signal: controller.signal });
        clearTimeout(timer);
        if (!res.ok) return hit?.ranges ?? [];
        const ranges = extractPrefixes(await res.json()).map(parseCidr).filter((range): range is Range => range !== null);
        cache.set(url, { at: Date.now(), ranges });
        return ranges;
      } catch {
        // Keep the last good list on a failed refresh; nothing on a first failure.
        cache.set(url, { at: Date.now() - ttl + 5 * 60 * 1000, ranges: hit?.ranges ?? [] });
        return hit?.ranges ?? [];
      }
    })();
    cache.set(url, { at: Date.now(), ranges: hit?.ranges ?? [], pending });
    return pending;
  }

  return {
    async verify(botName, ip) {
      if (!ip) return false;
      const urls = sources[botName];
      if (!urls?.length) return false;
      for (const url of urls) {
        const ranges = await load(url);
        if (ranges.some((range) => ipInRange(ip, range))) return true;
      }
      return false;
    },
  };
}
