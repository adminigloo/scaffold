import { describe, expect, it } from "vitest";
import * as admin from "../admin/index.js";
import * as root from "../index.js";

describe("@adminigloo/comms-widget skeleton", () => {
  it("speaks wire version v1 from both entries", () => {
    expect(root.COMMS_WIRE_VERSION).toBe("v1");
    expect(admin.COMMS_WIRE_VERSION).toBe(root.COMMS_WIRE_VERSION);
  });
});
