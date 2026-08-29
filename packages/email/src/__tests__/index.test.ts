import { describe, expect, it } from "vitest";
import * as barrel from "../index.js";
import { emailEvents, emailSchema } from "../schema.js";

describe("the barrel", () => {
  it("does NOT re-export a table", () => {
    // Tables are reachable from "@adminigloo/email/schema" and nowhere else.
    // A pgTable in the barrel drags drizzle-orm/pg-core into every client
    // bundle that imports anything from this package, and because tsup does
    // not code-split CJS a require() consumer would then hold two distinct
    // objects for one physical table — at which point Drizzle's reference
    // equality quietly stops matching and joins compile to nonsense.
    const exported: unknown[] = Object.values(barrel);
    expect(exported).not.toContain(emailEvents);
    expect(exported).not.toContain(emailSchema);
    expect(Object.keys(barrel)).not.toContain("emailEvents");
    expect(Object.keys(barrel)).not.toContain("emailSchema");
  });

  it("exports the functions the app is meant to reach for", () => {
    for (const name of [
      "parseSenderAddress",
      "formatSenderAddress",
      "createEmailSender",
      "verifyDeliveryWebhook",
      "mapDeliveryStatus",
      "deliveryStatusRank",
      "shouldApplyDeliveryStatus",
      "emailServer",
      "EMAIL_ENV_GROUP",
    ]) {
      expect(Object.keys(barrel)).toContain(name);
    }
  });
});
