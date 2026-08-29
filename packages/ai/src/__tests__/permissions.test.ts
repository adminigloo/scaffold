import { describe, expect, it } from "vitest";
import { definePermissions } from "@adminigloo/permissions";
import { aiPermissions } from "../permissions.js";

const catalog = definePermissions("tenant", aiPermissions);

describe("aiPermissions", () => {
  it("declares exactly the three AI capabilities", () => {
    expect([...catalog.keys].sort()).toEqual([
      "ai.chat.history.view",
      "ai.chat.use",
      "ai.config.manage",
    ]);
  });

  it("stays inside the ai.* namespace", () => {
    // AI spend lands on the same invoice as everything else, which makes
    // `billing.ai.*` tempting. It belongs to @adminigloo/stripe, and two
    // packages declaring one key means whichever spread runs last wins with no
    // error anywhere. Same for members.* and tenant.*, which tenancy owns.
    for (const key of catalog.keys) {
      expect(key.startsWith("ai.")).toBe(true);
    }
  });

  it("groups under one category, so the checklist has an AI section", () => {
    expect([...catalog.byCategory().keys()]).toEqual(["AI"]);
  });

  it("withholds chat from viewers, who cannot otherwise spend money", () => {
    // Viewer is the read-only template. A role that can run up a five-figure
    // inference bill is not read-only.
    expect(catalog.get("ai.chat.use").defaultFor).toEqual(["owner", "admin", "member"]);
  });

  it("treats reading other people's conversations as its own capability", () => {
    // Prompts are the least redacted text in most products. "Can chat" and "can
    // read everyone's chats" look adjacent in a checklist and are not.
    expect(catalog.get("ai.chat.history.view").defaultFor).toEqual(["owner", "admin"]);
    expect(catalog.get("ai.chat.history.view").defaultFor).not.toContain("member");
  });

  it("seeds model and spend-limit control to the owner alone", () => {
    expect(catalog.get("ai.config.manage").defaultFor).toEqual(["owner"]);
  });

  it("seals nothing", () => {
    // Sealing is for capabilities that must never be granted one person at a
    // time - refunds, impersonation, ownership transfer. Nothing here is
    // irreversible: an owner delegating model configuration for a week is a
    // normal thing to want, and sealing it would only push people to share the
    // owner account.
    for (const key of catalog.keys) {
      expect(catalog.isSealed(key)).toBe(false);
    }
  });

  it("gives every key a label and a description for the checklist editor", () => {
    for (const key of catalog.keys) {
      const definition = catalog.get(key);
      expect(definition.label.length).toBeGreaterThan(0);
      expect(definition.description?.length ?? 0).toBeGreaterThan(0);
    }
  });
});
