import { describe, expect, it } from "vitest";
import * as admin from "../admin/index.js";
import * as root from "../index.js";

describe("@adminigloo/invoicing-widget skeleton", () => {
  it("speaks wire version v1 from both entries", () => {
    expect(root.INVOICING_WIRE_VERSION).toBe("v1");
    expect(admin.INVOICING_WIRE_VERSION).toBe(root.INVOICING_WIRE_VERSION);
  });
});
