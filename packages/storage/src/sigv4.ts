import { createHash, createHmac } from "node:crypto";

/**
 * AWS Signature Version 4 for S3, by hand (`node:crypto`), so the package
 * needs no AWS SDK (D14: no vendor dependency). R2, MinIO and AWS S3 all
 * speak it.
 *
 * Proven against AWS's own documented examples (review BO-16), not against a
 * server that checks with this same signer (that would prove nothing):
 *   1. the presigned GET of `examplebucket/test.txt` (query-string auth);
 *   2. the header-signed GET Object of the same, with `Range: bytes=0-9`.
 * Both live in src/__tests__/adapters.test.ts.
 *
 * The request path is signed exactly as it is sent: each key segment is
 * encoded with RFC 3986's rules (encodeURIComponent plus `!'()*`), once, by
 * the caller (s3.ts) — never normalised by `new URL()`.
 */

export const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

/** encodeURIComponent plus the characters RFC 3986 reserves that it leaves alone. */
export function rfc3986(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

/** "20130524T000000Z" */
export function amzDate(now: Date): string {
  return now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

function signingKey(secret: string, date: string, region: string): Buffer {
  return hmac(hmac(hmac(hmac(`AWS4${secret}`, date), region), "s3"), "aws4_request");
}

/**
 * The URL's path as SigV4 wants it. The path is taken from the raw string,
 * not from `new URL(url).pathname`, so a segment is never re-encoded or
 * normalised on the way to the signature.
 */
function rawPath(url: string): string {
  const match = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*([^?#]*)/i.exec(url);
  const path = match?.[1] ?? "";
  return path === "" ? "/" : path;
}

function hostOf(url: string): string {
  const parsed = new URL(url);
  return parsed.host;
}

function canonicalQuery(params: ReadonlyArray<readonly [string, string]>): string {
  return [...params]
    .map(([k, v]) => [rfc3986(k), rfc3986(v)] as const)
    .sort(([a, av], [b, bv]) => (a < b ? -1 : a > b ? 1 : av < bv ? -1 : av > bv ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
}

function existingQuery(url: string): Array<[string, string]> {
  const at = url.indexOf("?");
  if (at < 0) return [];
  return [...new URLSearchParams(url.slice(at + 1).split("#")[0]).entries()];
}

/** Query-string SigV4 (exported for the test vector and for hosts that presign elsewhere; the package itself never redirects to a presigned URL, D10). */
export function presignS3Url(input: {
  readonly method: "GET" | "PUT";
  readonly url: string;
  readonly region: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly expiresInSeconds: number;
  readonly now: Date;
  readonly query?: Readonly<Record<string, string>>;
}): string {
  const date = amzDate(input.now);
  const day = date.slice(0, 8);
  const scope = `${day}/${input.region}/s3/aws4_request`;
  const params: Array<[string, string]> = [
    ...existingQuery(input.url),
    ...Object.entries(input.query ?? {}),
    ["X-Amz-Algorithm", "AWS4-HMAC-SHA256"],
    ["X-Amz-Credential", `${input.accessKeyId}/${scope}`],
    ["X-Amz-Date", date],
    ["X-Amz-Expires", String(input.expiresInSeconds)],
    ["X-Amz-SignedHeaders", "host"],
  ];
  const query = canonicalQuery(params);
  const canonical = [input.method, rawPath(input.url), query, `host:${hostOf(input.url)}`, "", "host", "UNSIGNED-PAYLOAD"].join("\n");
  const toSign = ["AWS4-HMAC-SHA256", date, scope, sha256Hex(canonical)].join("\n");
  const signature = createHmac("sha256", signingKey(input.secretAccessKey, day, input.region)).update(toSign, "utf8").digest("hex");
  const base = input.url.split("?")[0]?.split("#")[0] ?? input.url;
  return `${base}?${query}&X-Amz-Signature=${signature}`;
}

/** Header SigV4 for one request (exported for the second test vector, review BO-16). */
export function signS3Request(input: {
  readonly method: "GET" | "PUT" | "DELETE";
  readonly url: string;
  readonly region: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly now: Date;
  readonly headers: Readonly<Record<string, string>>;
  /** Hex sha256 of the body ("e3b0c442…b855" for none). */
  readonly payloadHash: string;
}): Readonly<Record<string, string>> {
  const date = amzDate(input.now);
  const day = date.slice(0, 8);
  const scope = `${day}/${input.region}/s3/aws4_request`;
  const toSend: Record<string, string> = {};
  for (const [name, value] of Object.entries(input.headers)) {
    const lower = name.toLowerCase();
    if (lower === "host" || lower === "authorization") continue;
    toSend[lower] = String(value).trim().replace(/\s+/g, " ");
  }
  toSend["x-amz-date"] = date;
  toSend["x-amz-content-sha256"] = input.payloadHash;
  // Host is signed but never sent by us: fetch sets it from the URL, the same value.
  const signed: Record<string, string> = { ...toSend, host: hostOf(input.url) };
  const names = Object.keys(signed).sort();
  const canonicalHeaders = names.map((name) => `${name}:${signed[name]}\n`).join("");
  const signedHeaders = names.join(";");
  const canonical = [input.method, rawPath(input.url), canonicalQuery(existingQuery(input.url)), canonicalHeaders, signedHeaders, input.payloadHash].join("\n");
  const toSign = ["AWS4-HMAC-SHA256", date, scope, sha256Hex(canonical)].join("\n");
  const signature = createHmac("sha256", signingKey(input.secretAccessKey, day, input.region)).update(toSign, "utf8").digest("hex");
  return {
    ...toSend,
    authorization: `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}
