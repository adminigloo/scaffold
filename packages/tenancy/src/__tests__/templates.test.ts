import { describe, expect, it } from "vitest";
import {
  canManageTemplate,
  canManageTemplateKey,
  templateRank,
  TENANT_ROLE_TEMPLATES,
} from "../templates.js";

describe("TENANT_ROLE_TEMPLATES", () => {
  it("ships owner, admin, member and viewer", () => {
    expect(TENANT_ROLE_TEMPLATES.map((t) => t.key)).toEqual([
      "owner",
      "admin",
      "member",
      "viewer",
    ]);
  });

  it("ranks them 40/30/20/10", () => {
    expect(TENANT_ROLE_TEMPLATES.map((t) => t.rank)).toEqual([40, 30, 20, 10]);
  });

  it("has no duplicate key and no duplicate rank", () => {
    // A duplicate rank would make canManageTemplate deny between two distinct
    // templates, which reads as a permissions bug and not as a seed-data bug.
    expect(new Set(TENANT_ROLE_TEMPLATES.map((t) => t.key)).size).toBe(
      TENANT_ROLE_TEMPLATES.length,
    );
    expect(new Set(TENANT_ROLE_TEMPLATES.map((t) => t.rank)).size).toBe(
      TENANT_ROLE_TEMPLATES.length,
    );
  });

  it("leaves a gap between adjacent ranks so one can be inserted later", () => {
    for (let i = 1; i < TENANT_ROLE_TEMPLATES.length; i += 1) {
      const above = TENANT_ROLE_TEMPLATES[i - 1];
      const below = TENANT_ROLE_TEMPLATES[i];
      expect(above).toBeDefined();
      expect(below).toBeDefined();
      expect((above?.rank ?? 0) - (below?.rank ?? 0)).toBeGreaterThan(1);
    }
  });

  it("describes every template — the checklist renders these verbatim", () => {
    for (const template of TENANT_ROLE_TEMPLATES) {
      expect(template.name.length).toBeGreaterThan(0);
      expect(template.description.length).toBeGreaterThan(0);
    }
  });
});

describe("templateRank", () => {
  it("resolves shipped keys", () => {
    expect(templateRank("owner")).toBe(40);
    expect(templateRank("viewer")).toBe(10);
  });

  it("returns undefined rather than a default for an unknown key", () => {
    expect(templateRank("superuser")).toBeUndefined();
    expect(templateRank("")).toBeUndefined();
    expect(templateRank("Owner")).toBeUndefined();
  });
});

describe("canManageTemplate — the privilege-escalation guard", () => {
  it("lets a higher rank manage a lower one", () => {
    expect(canManageTemplate(40, 30)).toBe(true);
    expect(canManageTemplate(40, 10)).toBe(true);
    expect(canManageTemplate(20, 10)).toBe(true);
  });

  it("refuses a lower rank managing a higher one", () => {
    expect(canManageTemplate(10, 20)).toBe(false);
    expect(canManageTemplate(30, 40)).toBe(false);
  });

  it("REFUSES EQUAL RANKS — including a principal managing its own", () => {
    for (const { rank } of TENANT_ROLE_TEMPLATES) {
      expect(canManageTemplate(rank, rank)).toBe(false);
    }
    expect(canManageTemplate(0, 0)).toBe(false);
    expect(canManageTemplate(-5, -5)).toBe(false);
  });

  it("refuses owner-on-owner, the case a founder dispute reaches for", () => {
    const owner = templateRank("owner") ?? Number.NaN;
    expect(canManageTemplate(owner, owner)).toBe(false);
  });

  it("is strict by one — 31 manages 30, 30 does not manage 30", () => {
    expect(canManageTemplate(31, 30)).toBe(true);
    expect(canManageTemplate(30, 30)).toBe(false);
    expect(canManageTemplate(29.9999, 30)).toBe(false);
  });

  it("denies when either rank is NaN, in BOTH directions", () => {
    expect(canManageTemplate(Number.NaN, 10)).toBe(false);
    expect(canManageTemplate(40, Number.NaN)).toBe(false);
    expect(canManageTemplate(Number.NaN, Number.NaN)).toBe(false);
  });

  it("denies an Infinity rank — no value may outrank the table itself", () => {
    expect(canManageTemplate(Number.POSITIVE_INFINITY, 40)).toBe(false);
    expect(canManageTemplate(40, Number.NEGATIVE_INFINITY)).toBe(false);
  });
});

describe("canManageTemplateKey", () => {
  it("mirrors the rank comparison for shipped keys", () => {
    expect(canManageTemplateKey("owner", "admin")).toBe(true);
    expect(canManageTemplateKey("admin", "member")).toBe(true);
    expect(canManageTemplateKey("member", "owner")).toBe(false);
    expect(canManageTemplateKey("viewer", "member")).toBe(false);
  });

  it("refuses a key managing itself", () => {
    for (const { key } of TENANT_ROLE_TEMPLATES) {
      expect(canManageTemplateKey(key, key)).toBe(false);
    }
  });

  it("FAILS CLOSED on an unknown actor key", () => {
    // An unknown key must never fall back to rank 0 and be treated as either
    // harmless or all-powerful; both readings are exploitable.
    expect(canManageTemplateKey("superuser", "viewer")).toBe(false);
    expect(canManageTemplateKey("", "viewer")).toBe(false);
  });

  it("FAILS CLOSED on an unknown target key", () => {
    expect(canManageTemplateKey("owner", "superuser")).toBe(false);
    expect(canManageTemplateKey("owner", "")).toBe(false);
  });

  it("fails closed when both keys are unknown", () => {
    expect(canManageTemplateKey("a", "b")).toBe(false);
  });

  it("is case sensitive — 'Owner' is not the owner template", () => {
    expect(canManageTemplateKey("Owner", "viewer")).toBe(false);
    expect(canManageTemplateKey("owner", "Viewer")).toBe(false);
  });

  it("denies every pair where the actor does not strictly outrank the target", () => {
    for (const actor of TENANT_ROLE_TEMPLATES) {
      for (const target of TENANT_ROLE_TEMPLATES) {
        expect(canManageTemplateKey(actor.key, target.key)).toBe(
          actor.rank > target.rank,
        );
      }
    }
  });
});
