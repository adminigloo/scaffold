/**
 * Is this a place on the public internet? The busy reader fetches a URL that
 * staff typed (a host's secret iCal address), on the SERVER, and shows what
 * came back — busy blocks in the public slot list, an event count and the
 * error text on "Test connection". Pointed at the server's own metadata
 * endpoint or a box on its private network, that is an SSRF read, so every
 * hop of every fetch is checked here: the literal host, every address it
 * resolves to, and every redirect target.
 *
 * WHY A PARSER AND NOT A REGEX. The first version matched the host as typed
 * ("127.", "10.", "::1") and missed every other spelling of the same place:
 * [::ffff:127.0.0.1] (IPv4-mapped), [::] (unspecified), [0:0:0:0:0:0:0:1],
 * 64:ff9b::a9fe:a9fe (NAT64 of 169.254.169.254), CGNAT's 100.64/10 — where
 * Alibaba Cloud keeps its metadata at 100.100.100.200 — and "localhost."
 * with a trailing dot. Addresses are parsed into numbers and checked by
 * range, so a spelling cannot slip past. (The URL parser already folds the
 * IPv4 tricks — "2130706433", "0x7f.1", "127.1" — into dotted quads.)
 *
 * Pure and dependency-free: no node:net, so it runs on any runtime.
 */

/** "a.b.c.d" → four bytes, or null. Only the canonical dotted form (what URL and DNS hand back). */
export function parseIpv4(text: string): [number, number, number, number] | null {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (!match) return null;
  const bytes = match.slice(1).map(Number) as [number, number, number, number];
  return bytes.every((byte) => byte <= 255) ? bytes : null;
}

/**
 * Any IPv6 spelling → eight 16-bit groups, or null: "::" compression, an
 * embedded dotted IPv4 tail ("::ffff:127.0.0.1"), surrounding brackets and a
 * zone id ("fe80::1%eth0") are all understood.
 */
export function parseIpv6(text: string): number[] | null {
  let value = text.trim().toLowerCase().replace(/^\[|\]$/g, "");
  const zone = value.indexOf("%");
  if (zone >= 0) value = value.slice(0, zone);
  if (!value.includes(":")) return null;
  const lastColon = value.lastIndexOf(":");
  const last = value.slice(lastColon + 1);
  if (last.includes(".")) {
    const v4 = parseIpv4(last);
    if (!v4) return null;
    value = `${value.slice(0, lastColon + 1)}${((v4[0] << 8) | v4[1]).toString(16)}:${((v4[2] << 8) | v4[3]).toString(16)}`;
  }
  const halves = value.split("::");
  if (halves.length > 2) return null;
  const group = (part: string): number[] | null => {
    if (part === "") return [];
    const out: number[] = [];
    for (const piece of part.split(":")) {
      if (!/^[0-9a-f]{1,4}$/.test(piece)) return null;
      out.push(parseInt(piece, 16));
    }
    return out;
  };
  const head = group(halves[0] ?? "");
  const tail = halves.length === 2 ? group(halves[1] ?? "") : [];
  if (!head || !tail) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  if (head.length + tail.length > 7) return null;
  return [...head, ...Array<number>(8 - head.length - tail.length).fill(0), ...tail];
}

/** True for every IPv4 range that is not the public internet. */
function reservedV4([a, b, c]: readonly number[]): boolean {
  if (a === undefined || b === undefined || c === undefined) return true;
  return (
    a === 0 || //                                   0/8 "this network" (0.0.0.0 reaches the local host)
    a === 10 || //                                  10/8 private
    (a === 100 && b >= 64 && b <= 127) || //        100.64/10 CGNAT — includes Alibaba's metadata 100.100.100.200
    a === 127 || //                                 127/8 loopback
    (a === 169 && b === 254) || //                  169.254/16 link-local — the cloud metadata address
    (a === 172 && b >= 16 && b <= 31) || //         172.16/12 private
    (a === 192 && b === 0 && (c === 0 || c === 2)) || // 192.0.0/24 protocol assignments, 192.0.2/24 documentation
    (a === 192 && b === 168) || //                  192.168/16 private
    (a === 198 && (b === 18 || b === 19)) || //     198.18/15 benchmarking
    (a === 198 && b === 51 && c === 100) || //      documentation
    (a === 203 && b === 0 && c === 113) || //       documentation
    a >= 224 //                                     multicast, reserved, broadcast
  );
}

function reservedV6(groups: readonly number[]): boolean {
  const g = (index: number) => groups[index] ?? 0;
  const embedded = (hi: number, lo: number) => reservedV4([hi >> 8, hi & 0xff, lo >> 8, lo & 0xff]);
  // ::/96 — unspecified (::), loopback (::1) and the deprecated IPv4-compatible form.
  if ([0, 1, 2, 3, 4, 5].every((i) => g(i) === 0)) return true;
  // ::ffff:0:0/96 IPv4-mapped and ::ffff:0:0:0/96 IPv4-translated. A calendar
  // host never publishes one; refusing the whole range means no mapping trick
  // reaches an IPv4 address the checks above would have refused.
  if ([0, 1, 2, 3].every((i) => g(i) === 0) && ((g(4) === 0 && g(5) === 0xffff) || (g(4) === 0xffff && g(5) === 0))) return true;
  // 64:ff9b::/96 NAT64: the IPv4 address rides in the last 32 bits.
  if (g(0) === 0x64 && g(1) === 0xff9b && [2, 3, 4, 5].every((i) => g(i) === 0)) return embedded(g(6), g(7));
  if (g(0) === 0x64 && g(1) === 0xff9b && g(2) === 1) return true; // 64:ff9b:1::/48 local-use NAT64
  if (g(0) === 0x100 && g(1) === 0 && g(2) === 0 && g(3) === 0) return true; // 100::/64 discard
  if (g(0) === 0x2001 && g(1) === 0) return true; // 2001::/32 Teredo (the client address is obfuscated)
  if (g(0) === 0x2001 && g(1) === 0x0db8) return true; // 2001:db8::/32 documentation
  if (g(0) === 0x2002) return embedded(g(1), g(2)); // 2002::/16 6to4: IPv4 in bits 16–48
  if ((g(0) & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local (ULA)
  if ((g(0) & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g(0) & 0xffc0) === 0xfec0) return true; // fec0::/10 site-local (deprecated)
  if ((g(0) & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  return false;
}

/** Is this text an IP address literal (either family, brackets allowed)? */
export function isIpLiteral(text: string): boolean {
  return parseIpv4(text) !== null || parseIpv6(text) !== null;
}

/**
 * True only for a parseable IP address on the public internet. Anything
 * else — a private, loopback, link-local, CGNAT, documentation, multicast or
 * otherwise reserved address in any spelling, or text that is not an address
 * at all — is false, so a caller that refuses "not public" fails closed.
 */
export function isPublicAddress(address: string): boolean {
  const v4 = parseIpv4(address.trim());
  if (v4) return !reservedV4(v4);
  const v6 = parseIpv6(address);
  if (v6) return !reservedV6(v6);
  return false;
}

/**
 * Names that are private by construction, whatever DNS says: localhost and
 * its subdomains, mDNS (.local), the cloud-internal suffixes (.internal is
 * where GCP's metadata.google.internal lives), home networks (.home.arpa,
 * RFC 8375), and any single-label name — a real calendar host always has a
 * dot, while "metadata" or "intranet" would be completed by the server's DNS
 * search domains into somewhere inside.
 */
const PRIVATE_SUFFIXES = [".localhost", ".local", ".internal", ".localdomain", ".home.arpa"];

/**
 * The verdict on a URL's host BEFORE any resolution: null when it may be
 * fetched (subject to the DNS check for names), or the reason it may not.
 * A trailing dot ("localhost.", "example.com.") is the same name; it is
 * stripped before the checks so it cannot be used to step around them.
 */
export function privateHostReason(hostname: string): string | null {
  const host = hostname.trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/\.+$/, "");
  if (host === "") return "calendar address has no host";
  if (isIpLiteral(host)) return isPublicAddress(host) ? null : "calendar address points at a private network";
  if (host === "localhost" || PRIVATE_SUFFIXES.some((suffix) => host.endsWith(suffix)) || !host.includes(".")) {
    return "calendar address points at a private network";
  }
  return null;
}
