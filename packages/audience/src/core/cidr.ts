/**
 * IP and CIDR matching for `network` rules, ported from
 * @adminigloo/analytics `verify.ts` (same parsing, same edge cases) so this
 * package has no dependency on analytics — analytics 0.2 will depend on this
 * one, not the other way round.
 *
 * An IP is only ever held in memory for the length of one `observe()` call:
 * matched against the active ranges, then dropped. Nothing here stores it.
 */

export type IpRange =
  | { v6: false; base: number; bits: number }
  | { v6: true; base: bigint; bits: number };

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
  if (address.startsWith("[") && address.endsWith("]")) address = address.slice(1, -1);
  const zone = address.indexOf("%");
  if (zone >= 0) address = address.slice(0, zone);
  // An embedded IPv4 tail (::ffff:1.2.3.4) becomes two hextets.
  const v4 = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(address);
  if (v4?.[1]) {
    const value = parseIPv4(v4[1]);
    if (value === null) return null;
    address =
      address.slice(0, -v4[1].length) + `${(value >>> 16).toString(16)}:${(value & 0xffff).toString(16)}`;
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

/** "203.0.113.0/24", "2001:db8::/32", or a bare address (a /32 or /128). */
export function parseCidr(cidr: string): IpRange | null {
  const [address, bitsText, extra] = cidr.trim().split("/");
  if (!address || extra !== undefined) return null;
  const v6 = address.includes(":");
  if (bitsText !== undefined && !/^\d{1,3}$/.test(bitsText)) return null;
  const bits = bitsText === undefined ? (v6 ? 128 : 32) : Number(bitsText);
  if (!Number.isInteger(bits) || bits < 0 || bits > (v6 ? 128 : 32)) return null;
  if (v6) {
    const base = parseIPv6(address);
    return base === null ? null : { v6: true, base, bits };
  }
  const base = parseIPv4(address);
  return base === null ? null : { v6: false, base, bits };
}

/** Unwrap what proxies send: brackets, a port, an IPv4-mapped IPv6 prefix. */
export function cleanIp(ip: string): string {
  let value = ip.trim();
  if (value.startsWith("[")) {
    const end = value.indexOf("]");
    if (end > 0) value = value.slice(1, end);
  } else if (/^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(value)) {
    value = value.slice(0, value.lastIndexOf(":"));
  }
  return value;
}

export function ipInRange(ip: string, range: IpRange): boolean {
  const address = cleanIp(ip);
  if (range.v6) {
    const value = parseIPv6(address);
    if (value === null) return false;
    const shift = BigInt(128 - range.bits);
    return value >> shift === range.base >> shift;
  }
  const value = parseIPv4(address.toLowerCase().startsWith("::ffff:") ? address.slice(7) : address);
  if (value === null) return false;
  if (range.bits === 0) return true;
  const shift = 32 - range.bits;
  return Math.floor(value / 2 ** shift) === Math.floor(range.base / 2 ** shift);
}

/** The canonical text of a range: network address + prefix ("10.1.2.3/8" → "10.0.0.0/8"). */
export function canonicalCidr(cidr: string): string | null {
  const range = parseCidr(cidr);
  if (!range) return null;
  if (range.v6) {
    const shift = BigInt(128 - range.bits);
    const base = range.bits === 0 ? 0n : (range.base >> shift) << shift;
    const groups: string[] = [];
    for (let i = 7; i >= 0; i -= 1) groups.push(((base >> BigInt(i * 16)) & 0xffffn).toString(16));
    return `${compressV6(groups)}/${range.bits}`;
  }
  const size = 2 ** (32 - range.bits);
  const base = range.bits === 0 ? 0 : Math.floor(range.base / size) * size;
  const octets = [base >>> 24, (base >>> 16) & 255, (base >>> 8) & 255, base & 255];
  return `${octets.join(".")}/${range.bits}`;
}

function compressV6(groups: string[]): string {
  // Longest run of zero groups (length ≥ 2) becomes "::".
  let bestStart = -1;
  let bestLength = 0;
  for (let i = 0; i < groups.length; ) {
    if (groups[i] !== "0") {
      i += 1;
      continue;
    }
    let j = i;
    while (j < groups.length && groups[j] === "0") j += 1;
    if (j - i > bestLength && j - i >= 2) {
      bestStart = i;
      bestLength = j - i;
    }
    i = j;
  }
  if (bestStart < 0) return groups.join(":");
  const head = groups.slice(0, bestStart).join(":");
  const tail = groups.slice(bestStart + bestLength).join(":");
  return `${head}::${tail}`;
}
