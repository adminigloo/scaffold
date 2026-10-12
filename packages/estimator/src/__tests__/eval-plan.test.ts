import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * EST-R13: the accuracy eval measures what production sends. It refuses to
 * run without `sharp` (a full-size phone photo reports another accuracy and
 * 2–3× the cost), and says plainly when there is no real photo to score.
 * The eval itself spends money and never runs here; this is its planning.
 */

const here = dirname(fileURLToPath(import.meta.url));
const planPath = join(here, "..", "..", "eval", "takeoff", "plan.mjs");

interface Plan {
  present: Array<{ file: string }>;
  real: Array<{ file: string }>;
  lines: string[];
  refusal: string | null;
}
type PlanRun = (input: { fixtures: Array<{ file: string }>; onDisk: (file: string) => boolean; sharpAvailable: boolean; allowFullSize?: boolean }) => Plan;

async function load(): Promise<PlanRun> {
  const mod = (await import(/* @vite-ignore */ pathToFileURL(planPath).href)) as { planRun: PlanRun };
  return mod.planRun;
}

const fixtures = [
  { file: "photos/porch-2-steps-plus-deck.jpg" },
  { file: "photos/two-steps-front.jpg" },
  { file: "photos/synthetic-3-risers-deck.png" },
];

describe("EST-R13: the takeoff eval's plan", () => {
  it("refuses without sharp, unless --full-size says so on purpose", async () => {
    const planRun = await load();
    const refused = planRun({ fixtures, onDisk: () => true, sharpAvailable: false });
    expect(refused.refusal).toMatch(/sharp isn't installed/);
    expect(planRun({ fixtures, onDisk: () => true, sharpAvailable: false, allowFullSize: true }).refusal).toBeNull();
    expect(planRun({ fixtures, onDisk: () => true, sharpAvailable: true }).refusal).toBeNull();
  });

  it("says when there is no real photo, and where to put one", async () => {
    const planRun = await load();
    const onlyDiagrams = planRun({ fixtures, onDisk: (file) => file.includes("synthetic"), sharpAvailable: true });
    expect(onlyDiagrams.real).toEqual([]);
    expect(onlyDiagrams.lines[0]).toBe(
      "0 real photos found: this run would score only the 1 synthetic diagram, not a customer's photo. Add your porch photos at photos/porch-2-steps-plus-deck.jpg, photos/two-steps-front.jpg (eval/takeoff/).",
    );
    const withPorch = planRun({ fixtures, onDisk: (file) => !file.includes("two-steps"), sharpAvailable: true });
    expect(withPorch.lines[0]).toBe("1 of 2 real photos found, and 1 synthetic diagram.");
  });
});
