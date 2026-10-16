import { describe, expect, it } from "vitest";
import * as admin from "../admin/index.js";
import * as root from "../index.js";

describe("@adminigloo/storage-widget skeleton", () => {
  it("speaks wire version v1 from both entries", () => {
    expect(root.STORAGE_WIRE_VERSION).toBe("v1");
    expect(admin.STORAGE_WIRE_VERSION).toBe(root.STORAGE_WIRE_VERSION);
  });
});
