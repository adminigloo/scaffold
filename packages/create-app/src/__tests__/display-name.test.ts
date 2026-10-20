import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_ANSWERS } from "../answers.js";
import { planEmit } from "../emit.js";
import { TEMPLATE_DIR } from "./configurations.js";

/**
 * People read the site's name, not its slug: Igloo Back Office's landing page
 * said "igloo-backoffice keeps everything…". __DISPLAY_NAME__ is the title-cased
 * name; __PROJECT_NAME__ stays for logs, packages and files.
 */
describe("the name people read", () => {
  it("the landing page, the legal pages and the error page say it in words", async () => {
    const plan = await planEmit(TEMPLATE_DIR, "/out", {
      ...DEFAULT_ANSWERS,
      projectName: "igloo-backoffice",
      includeMarketing: true,
    });
    const hero = plan.files.get(join("src", "components", "marketing", "Hero.tsx"));
    expect(hero).toContain("Igloo Backoffice keeps everything");
    expect(hero).not.toContain("igloo-backoffice keeps");
    for (const [path, contents] of plan.files) {
      expect(contents, path).not.toContain("__DISPLAY_NAME__");
    }
  });
});
