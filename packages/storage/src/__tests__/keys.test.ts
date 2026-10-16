import { describe, expect, it } from "vitest";
import { assertStorageKey, isLegacyKey, newPrivateKey, newPublicKey, STORAGE_KEY_PATTERN, tenantFolder } from "../keys.js";
import { InvalidKeyError } from "../types.js";

/**
 * Keys (D10, review G7): no company id in any key, and nothing but a key this
 * package makes (or, for reading and deleting, a 0.1/2a shape) is ever
 * handed to a store. Every adapter's own refusal is in adapters.test.ts.
 */

const NOW = new Date("2026-10-15T12:00:00Z");

describe("the keys this package makes", () => {
  it("private: t/{16 hex of sha256(company)}/{YYYY}/{MM}/{32 hex}.{ext}", async () => {
    const key = await newPrivateKey("acme", "jpg", NOW);
    expect(key).toMatch(/^t\/[0-9a-f]{16}\/2026\/10\/[0-9a-f]{32}\.jpg$/);
    expect(STORAGE_KEY_PATTERN.test(key)).toBe(true);
    expect(key).not.toContain("acme");
    expect(key.split("/")[1]).toBe(await tenantFolder("acme"));
  });

  it("public: p/{32 base64url}.{ext}, with no company and no file name", () => {
    const key = newPublicKey("png");
    expect(key).toMatch(/^p\/[A-Za-z0-9_-]{32}\.png$/);
    expect(STORAGE_KEY_PATTERN.test(key)).toBe(true);
    expect(new Set(Array.from({ length: 50 }, () => newPublicKey("png"))).size).toBe(50);
  });

  it("a company id of a/../b or %2e%2e lands under its own hashed folder (review G7)", async () => {
    for (const id of ["a/../b", "%2e%2e", "../../etc", "C:\\x", "a b/c"]) {
      const key = await newPrivateKey(id, "png", NOW);
      expect(STORAGE_KEY_PATTERN.test(key), id).toBe(true);
      expect(key.split("/")[1], id).toBe(await tenantFolder(id));
      expect(key).not.toContain("..");
      expect(key).not.toContain("%");
    }
    expect(await tenantFolder("a/../b")).not.toBe(await tenantFolder("b"));
  });
});

describe("what a store is ever handed", () => {
  it("puts take only a key this package makes", async () => {
    expect(() => assertStorageKey(newPublicKey("png"), "put")).not.toThrow();
    expect(() => assertStorageKey(`t/acme/0b0e1a2f-0000-4000-8000-000000000001-a.png`, "put")).toThrow(InvalidKeyError);
  });

  it("get and delete also take 0.1's and 2a's shapes", () => {
    const legacy = ["t/acme/0b0e1a2f-0000-4000-8000-000000000001-Q3_report.pdf", "tenancy/logos/acme/01890a5d-ac96-774b-bcce-b302099a8057.png"];
    for (const key of legacy) {
      expect(isLegacyKey(key), key).toBe(true);
      expect(() => assertStorageKey(key, "get")).not.toThrow();
      expect(() => assertStorageKey(key, "delete")).not.toThrow();
    }
  });

  it("refuses ../, an encoded ..., an absolute path, a backslash and a control character", () => {
    const bad = [
      "t/../x.png",
      "t/abc/%2e%2e/x.png",
      "/etc/passwd",
      "t\\0000000000000000\\2026\\10\\x.png",
      "t/acme/../0b0e1a2f-0000-4000-8000-000000000001-a.png",
      "t/acme//0b0e1a2f-0000-4000-8000-000000000001-a.png",
      "t/acme/0b0e1a2f-0000-4000-8000-000000000001-a\u0000.png",
      "tenancy/logos/acme/../../etc/passwd",
      "tenancy/logos/x.png",
      "",
      "p/short.png",
    ];
    for (const key of bad) {
      expect(() => assertStorageKey(key, "get"), key).toThrow(InvalidKeyError);
      expect(() => assertStorageKey(key, "delete"), key).toThrow(InvalidKeyError);
      expect(() => assertStorageKey(key, "put"), key).toThrow(InvalidKeyError);
    }
  });

  it("the refusal never repeats the key", () => {
    try {
      assertStorageKey("t/../secret-name.png", "get");
    } catch (error) {
      expect(String((error as Error).message)).not.toContain("secret-name");
    }
  });
});

describe("0.1 file names with a % in them (review BUY-04)", () => {
  // 0.1's sanitizeFilename kept "%": "May%20invoice.pdf" stayed as it was,
  // and "100% done.pdf" became "100%_done.pdf". Refusing every "%" left those
  // files impossible to open and impossible to delete.
  const UUID = "0b0e1a2f-0000-4000-8000-000000000001";

  it("a plain % in a 0.1 or 2a key is read and deleted like any other", () => {
    for (const key of [`t/acme/${UUID}-May%20invoice.pdf`, `t/acme/${UUID}-100%_done.pdf`, `t/acme/${UUID}-50%off.png`, `t/*/${UUID}-Q3%.pdf`]) {
      expect(isLegacyKey(key), key).toBe(true);
      expect(() => assertStorageKey(key, "get"), key).not.toThrow();
      expect(() => assertStorageKey(key, "delete"), key).not.toThrow();
      expect(() => assertStorageKey(key, "put"), key).toThrow(InvalidKeyError);
    }
  });

  it("an escape that decodes to a dot, a slash, a backslash, a % or a control character is still refused, and so is one that isn't UTF-8", () => {
    for (const key of [
      `t/acme/%2e%2e/${UUID}-a.pdf`,
      `t/acme/${UUID}-a%2e%2e.pdf`,
      `t/acme/${UUID}-a%2Fb.pdf`,
      `t/acme/${UUID}-a%5cb.pdf`,
      `t/acme/${UUID}-a%252e%252e.pdf`,
      `t/acme/${UUID}-a%00.pdf`,
      `t/acme/${UUID}-a%c0%ae.pdf`,
      `tenancy/logos/%2e%2e/${UUID}.png`,
    ]) {
      expect(isLegacyKey(key), key).toBe(false);
      expect(() => assertStorageKey(key, "get"), key).toThrow(InvalidKeyError);
      expect(() => assertStorageKey(key, "delete"), key).toThrow(InvalidKeyError);
    }
  });
});
