import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { brandColorReport } from "../color.js";
import { suggestSlug, validateSlug } from "../slug.js";

/**
 * Wire parity (contract 13.5). The widget declares the wire types itself
 * (src/types.ts) so it never imports the server package at runtime; the
 * server declares the same block in packages/tenancy/src/wire.ts. This test
 * reads BOTH files from disk and requires the region between the WIRE
 * markers to be byte-identical (line endings aside: a Windows checkout may
 * carry CRLF). A shape changed on one side only fails here, not in a
 * customer's browser.
 *
 * It also checks the widget's copies of the pure rules (suggestSlug,
 * validateSlug, brandColorReport) against `@adminigloo/tenancy`'s on 500
 * generated inputs. That import is the ONLY use of the devDependency.
 *
 * NO TODOS, NO SKIPS (review T1-13). These used to be `it.todo` while the
 * server half didn't exist yet, which let a release go out with the widget
 * talking to a server that wasn't there. Now a missing wire.ts or an
 * unbuilt @adminigloo/tenancy FAILS the suite.
 */

const here = dirname(fileURLToPath(import.meta.url));
const widgetTypes = resolve(here, "../types.ts");
const serverWire = resolve(here, "../../../tenancy/src/wire.ts");
const contractDoc = resolve(here, "../../../../docs/tenancy-1-contract.md");
const contract2aDoc = resolve(here, "../../../../docs/tenancy-2a-contract.md");

/** The text between `// WIRE:BEGIN` and `// WIRE:END`, LF line endings; null when the markers aren't there exactly once. */
export function wireRegion(source: string): string | null {
  const text = source.replace(/\r\n/g, "\n");
  const begin = text.split("// WIRE:BEGIN").length - 1;
  const end = text.split("// WIRE:END").length - 1;
  if (begin !== 1 || end !== 1) return null;
  const from = text.indexOf("// WIRE:BEGIN");
  const to = text.indexOf("// WIRE:END");
  return to > from ? text.slice(from, to + "// WIRE:END".length) : null;
}

/** The contract's own blocks (6.1's TenancyErrorCode, then 7.3), as the region is built from them. */
function regionFromContract(doc: string): string {
  const lines = doc.replace(/\r\n/g, "\n").split("\n");
  const ec: string[] = [];
  for (let i = lines.findIndex((l) => l.startsWith("export type TenancyErrorCode =")); i >= 0 && i < lines.length; i += 1) {
    ec.push(lines[i]!);
    if (lines[i]!.trim().endsWith(";")) break;
  }
  const heading = lines.findIndex((l) => l.startsWith("### 7.3 Wire types"));
  const open = lines.findIndex((l, k) => k > heading && l.startsWith("```ts"));
  const close = lines.findIndex((l, k) => k > open && l.startsWith("```"));
  return ["// WIRE:BEGIN", ...ec, "", ...lines.slice(open + 1, close), "// WIRE:END"].join("\n");
}

/** The fenced ```ts block that holds `marker`, dedented (a block inside a list item is indented). */
function blockHolding(doc: string, marker: string): string[] {
  const lines = doc.replace(/\r\n/g, "\n").split("\n");
  const at = lines.findIndex((l) => l.trimStart().startsWith(marker));
  let open = at;
  while (open >= 0 && !lines[open]!.trimStart().startsWith("```ts")) open -= 1;
  let close = at;
  while (close < lines.length && !lines[close]!.trimStart().startsWith("```")) close += 1;
  const indent = lines[open]!.length - lines[open]!.trimStart().length;
  return lines.slice(open + 1, close).map((l) => l.slice(Math.min(indent, l.length - l.trimStart().length)));
}

/**
 * Tenancy 2a's amendments to 7.3, applied to Tenancy 1's region: the widened
 * `RoleKey` (2a contract 4.1, with its comment) replaces T1's line, and
 * `PublicCompanyWire` (4.9) closes the region.
 */
function amendFor2a(region: string, doc2a: string): string {
  const lines = region.split("\n");
  const roleBlock = blockHolding(doc2a, "export type RoleKey");
  const roleLine = roleBlock.findIndex((l) => l.startsWith("export type RoleKey"));
  const roleStart = roleBlock.slice(0, roleLine).map((l) => l.startsWith("/**")).lastIndexOf(true);
  const roleKey = roleBlock.slice(roleStart, roleLine + 1);
  const at = lines.findIndex((l) => l.startsWith("export type RoleKey ="));
  lines.splice(at, 1, ...roleKey);
  const publicBlock = blockHolding(doc2a, "export interface PublicCompanyWire");
  lines.splice(lines.length - 1, 0, ...publicBlock);
  return lines.join("\n");
}

const mine = wireRegion(readFileSync(widgetTypes, "utf8"));

describe("wire region", () => {
  it("the widget's types.ts carries exactly one WIRE region", () => {
    expect(mine).not.toBeNull();
    expect(mine).toContain("export type TenancyErrorCode =");
    expect(mine).toContain("export interface AdminPeopleWire");
  });

  if (existsSync(contractDoc) && existsSync(contract2aDoc)) {
    it("matches the contract documents' blocks verbatim (Tenancy 1's 7.3, with Tenancy 2a's 4.1 and 4.9)", () => {
      expect(mine).toBe(amendFor2a(regionFromContract(readFileSync(contractDoc, "utf8")), readFileSync(contract2aDoc, "utf8")));
    });
  } else {
    it.todo("matches the contract document (docs/tenancy-1-contract.md isn't in this checkout)");
  }

  it("is byte-identical to packages/tenancy/src/wire.ts", () => {
    expect(existsSync(serverWire), "packages/tenancy/src/wire.ts is missing").toBe(true);
    const theirs = wireRegion(readFileSync(serverWire, "utf8"));
    expect(theirs, "packages/tenancy/src/wire.ts has no single WIRE:BEGIN … WIRE:END region").not.toBeNull();
    expect(mine).toBe(theirs);
  });
});

// ---------------------------------------------------------------------------
// The pure rules, against the server package's
// ---------------------------------------------------------------------------

type ServerRules = {
  suggestSlug?: (name: string) => string;
  validateSlug?: (slug: string) => string | null;
  brandColorReport?: (hex: string) => unknown;
};

const server: ServerRules | null = await import("@adminigloo/tenancy").then((m) => m as ServerRules).catch(() => null);

/** A seeded generator: the same 500 inputs every run, so a failure names its input. */
function generated(count: number, seed: number, make: (next: () => number) => string): string[] {
  let s = seed;
  const next = () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
  return Array.from({ length: count }, () => make(next));
}

const PIECES = ["Summit", "Window", "Co.", "Café", "&", "Ölmühle", "O'Brien's", "  ", "-", "ws", "admin", "Ünïcödé", "東京", "🙂", "A", "b", "123", "Plumbing", "—", "LLC", "t", "_next", "...", "x".repeat(45)];
const names = generated(500, 7, (next) =>
  Array.from({ length: 1 + Math.floor(next() * 6) }, () => PIECES[Math.floor(next() * PIECES.length)]).join(next() < 0.7 ? " " : ""),
);
const slugs = generated(500, 11, (next) => {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789--_ A";
  return Array.from({ length: Math.floor(next() * 44) }, () => alphabet[Math.floor(next() * alphabet.length)]).join("");
});
const colours = generated(500, 13, (next) => {
  const hex = Math.floor(next() * 0xffffff).toString(16).padStart(6, "0");
  const form = next();
  return form < 0.6 ? `#${hex}` : form < 0.8 ? hex.toUpperCase() : form < 0.9 ? `#${hex.slice(0, 3)}` : "not-a-colour";
});

describe("the pure rules agree with @adminigloo/tenancy (500 generated inputs each)", () => {
  it("the built @adminigloo/tenancy exports them (rebuild it if this fails)", () => {
    expect(typeof server?.suggestSlug).toBe("function");
    expect(typeof server?.validateSlug).toBe("function");
    expect(typeof server?.brandColorReport).toBe("function");
  });
  it("suggestSlug", () => {
    for (const name of names) expect(suggestSlug(name), JSON.stringify(name)).toBe(server!.suggestSlug!(name));
  });
  it("validateSlug", () => {
    for (const slug of [...slugs, ...names.map(suggestSlug)]) expect(validateSlug(slug), JSON.stringify(slug)).toBe(server!.validateSlug!(slug));
  });
  it("brandColorReport", () => {
    for (const colour of colours) expect(brandColorReport(colour), colour).toEqual(server!.brandColorReport!(colour));
  });
});
