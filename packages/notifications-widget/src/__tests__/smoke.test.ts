import { describe, expect, it } from "vitest";
import * as admin from "../admin/index.js";
import * as root from "../index.js";

describe("@adminigloo/notifications-widget skeleton", () => {
  it("speaks wire version v1 from both entries", () => {
    expect(root.NOTIFICATIONS_WIRE_VERSION).toBe("v1");
    expect(admin.NOTIFICATIONS_WIRE_VERSION).toBe(root.NOTIFICATIONS_WIRE_VERSION);
  });
});
