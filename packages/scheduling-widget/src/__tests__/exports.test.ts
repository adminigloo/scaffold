import { describe, expect, it } from "vitest";
import { SCHEDULING_WIRE_VERSION } from "../index.js";
import { SCHEDULING_WIRE_VERSION as ADMIN_WIRE_VERSION } from "../admin/index.js";

/**
 * Both entries speak the same wire version, and it is the one the server's
 * routes carry (`{base}/v1/...`). A smoke test so the skeleton's `pnpm test`
 * is green before the components exist; the builder's suites join it.
 */
describe("scheduling-widget entries", () => {
  it("speak wire version v1 from both entries", () => {
    expect(SCHEDULING_WIRE_VERSION).toBe("v1");
    expect(ADMIN_WIRE_VERSION).toBe(SCHEDULING_WIRE_VERSION);
  });
});
