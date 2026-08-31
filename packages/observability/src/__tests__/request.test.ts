import { describe, expect, it } from "vitest";
import {
  clientIpFromHeaders,
  resolveRequestId,
  REQUEST_ID_HEADER,
  type HeaderSource,
} from "../request.js";

function headers(values: Record<string, string>): HeaderSource {
  const lowered = new Map(
    Object.entries(values).map(([k, v]) => [k.toLowerCase(), v] as const),
  );
  return { get: (name) => lowered.get(name.toLowerCase()) ?? null };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe("resolveRequestId", () => {
  it("prefers the inbound id", () => {
    // The platform in front of the app already minted one. Generating our own
    // regardless means the trace and the logs carry different ids for the same
    // request and cannot be joined at all.
    expect(resolveRequestId(headers({ [REQUEST_ID_HEADER]: "req_abc-123" }))).toBe(
      "req_abc-123",
    );
  });

  it("is case-insensitive about the header name", () => {
    expect(resolveRequestId(headers({ "X-Request-ID": "req_abc" }))).toBe("req_abc");
  });

  it("generates one when there is no header at all", () => {
    expect(resolveRequestId()).toMatch(UUID);
    expect(resolveRequestId(null)).toMatch(UUID);
    expect(resolveRequestId(headers({}))).toMatch(UUID);
  });

  it("generates a fresh one every time", () => {
    expect(resolveRequestId()).not.toBe(resolveRequestId());
  });

  it("ignores an empty or whitespace-only header", () => {
    expect(resolveRequestId(headers({ [REQUEST_ID_HEADER]: "   " }))).toMatch(UUID);
  });

  it("refuses an id carrying a newline", () => {
    // Log injection. With line-delimited JSON the second line is a record the
    // caller wrote, and the aggregator has no way to tell.
    const forged = 'a\n{"level":"info","msg":"payment captured"}';
    const resolved = resolveRequestId(headers({ [REQUEST_ID_HEADER]: forged }));
    expect(resolved).toMatch(UUID);
    expect(resolved).not.toContain("\n");
  });

  it("refuses an absurdly long id", () => {
    // Otherwise one header writes a megabyte into every line of the request.
    expect(resolveRequestId(headers({ [REQUEST_ID_HEADER]: "a".repeat(500) }))).toMatch(
      UUID,
    );
  });

  it("accepts the shapes real platforms send", () => {
    for (const id of [
      "9f2c1f6a-6f8f-4a70-9a1b-2b9c4a1d7e30",
      "iad1::abcde-1700000000000-0a1b2c3d4e5f",
      "4f8a1b2c3d4e5f60",
      "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
    ]) {
      expect(resolveRequestId(headers({ [REQUEST_ID_HEADER]: id }))).toBe(id);
    }
  });
});

describe("clientIpFromHeaders", () => {
  it("takes the leftmost forwarded address", () => {
    expect(
      clientIpFromHeaders(
        headers({ "x-forwarded-for": "203.0.113.7, 70.41.3.18, 150.172.238.178" }),
      ),
    ).toBe("203.0.113.7");
  });

  it("falls back to x-real-ip", () => {
    expect(clientIpFromHeaders(headers({ "x-real-ip": "203.0.113.9" }))).toBe(
      "203.0.113.9",
    );
  });

  it("is null when nothing identifies the caller", () => {
    // Null rather than "unknown": a shared placeholder bucket would rate-limit
    // a developer out of their own dev server, where no proxy sets the header.
    expect(clientIpFromHeaders(headers({}))).toBeNull();
    expect(clientIpFromHeaders()).toBeNull();
    expect(clientIpFromHeaders(headers({ "x-forwarded-for": " , " }))).toBeNull();
  });
});
