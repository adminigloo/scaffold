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
    // The landing page's words live in src/marketing-copy.ts (create-app 0.36),
    // built from SITE_NAME, which is the name in words.
    const copy = plan.files.get(join("src", "marketing-copy.ts"));
    expect(copy).toContain("${SITE_NAME} runs the office side of your business");
    expect(plan.files.get(join("src", "seo.ts"))).toContain('export const SITE_NAME = "Igloo Backoffice";');
    expect(copy).not.toContain("igloo-backoffice");
    for (const [path, contents] of plan.files) {
      expect(contents, path).not.toContain("__DISPLAY_NAME__");
    }
  });
});
