/**
 * The scheduling overlay's public procedures stay on the package's public API.
 *
 * THE HEADLINE FIX OF SCHEDULING 0.3 HAD NO GUARD ON THE GENERATED SIDE. 0.2's
 * router returned `findAvailableSlots` from the anonymous `slots` procedure —
 * the staff finder, whose slots carry the previous customer's street address —
 * and its `requestBooking` wrote client-chosen times as `confirmed`. The
 * package now has `findPublicSlots` and `requestPublicBooking`, but nothing
 * here noticed which ones the router calls: restoring the staff finder in
 * `slots` left all 1499 create-app tests green, and the capability evidence
 * accepted it because it only looked for the word `requestBooking`.
 *
 * The router itself can't run here (it reaches `@/db` and the rendered app
 * router), so this reads it as text — the same way the generator does — and
 * checks which package functions the public section calls.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CAPABILITY_EVIDENCE } from "../capabilities.js";
import type { EmitPlan } from "../emit.js";

const ROUTER = join(__dirname, "..", "..", "overlays", "scheduling", "src", "server", "routers", "scheduling.ts");

/** The names the router imports from the scheduling package. */
function packageImports(source: string): string[] {
  const block = /import\s*\{([^}]*)\}\s*from\s*"__SCOPE__\/scheduling"/.exec(source);
  if (!block?.[1]) throw new Error("the router no longer imports from __SCOPE__/scheduling — has it moved?");
  return block[1]
    .split(",")
    .map((name) => name.trim().replace(/^type\s+/, ""))
    .filter(Boolean);
}

/** The text between the public marker and the staff marker. */
function publicSection(source: string): string {
  const start = source.indexOf("// --- Public");
  const end = source.indexOf("// --- Staff");
  if (start === -1 || end === -1 || end < start) {
    throw new Error("the router's '// --- Public' / '// --- Staff' markers are gone — this test can't find the public procedures");
  }
  return source.slice(start, end);
}

/** Package functions called in a stretch of source: `name(`. */
function calledIn(section: string, names: readonly string[]): string[] {
  return names.filter((name) => new RegExp(`\\b${name}\\(`).test(section)).sort();
}

function planWithRouter(contents: string): EmitPlan {
  return { targetDir: "/out", files: new Map([[join("src", "server", "routers", "scheduling.ts"), contents]]) };
}

describe("the generated scheduling router", () => {
  it("calls only findPublicSlots and requestPublicBooking from its public procedures", async () => {
    const source = await readFile(ROUTER, "utf8");
    const names = packageImports(source);
    expect(calledIn(publicSection(source), names)).toEqual(["findPublicSlots", "requestPublicBooking"]);
  });

  it("does not import the staff finder at all", async () => {
    expect(packageImports(await readFile(ROUTER, "utf8"))).not.toContain("findAvailableSlots");
  });

  it("is what the scheduling.booking evidence accepts — and the 0.2 router is not", async () => {
    const evidence = CAPABILITY_EVIDENCE.find((row) => row.capability === "scheduling.booking");
    if (!evidence) throw new Error("no scheduling.booking evidence");
    expect(evidence.provenBy(planWithRouter(await readFile(ROUTER, "utf8")))).toBe(true);

    // The shape of 0.2's public half: the staff finder returned from `slots`,
    // client times written straight in from `requestBooking`.
    const leaking = [
      "import { createBooking, findAvailableSlots } from \"__SCOPE__/scheduling\";",
      "  // --- Public",
      "  slots: publicProcedure.query(() => findAvailableSlots(db, input, maps)),",
      "  requestBooking: publicProcedure.mutation(({ input }) => createBooking(db, input)),",
      "  // --- Staff",
    ].join("\n");
    expect(evidence.provenBy(planWithRouter(leaking))).toBe(false);
    // And a router that calls both is still refused: the public calls are not
    // enough while the staff finder is called anywhere in the file.
    const both = `${leaking}\nfindPublicSlots(db, input); requestPublicBooking(db, input);`;
    expect(evidence.provenBy(planWithRouter(both))).toBe(false);
  });
});
