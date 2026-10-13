import { describe, expect, it } from "vitest";
import { describeTenancyAuditEntry, tenancyAuditedActions } from "../index.js";

/**
 * Review T1-17: the operator console's activity list said "Changed a member's
 * role" and nothing else, so support couldn't answer "who removed me?" or
 * "who made Jake an admin?". These are the words the console now shows beside
 * the label, built from the metadata this package itself writes.
 */
describe("describeTenancyAuditEntry", () => {
  it("says who and to what for a role change", () => {
    expect(
      describeTenancyAuditEntry("member.role.changed", { member: "Jake Ruiz", from: "member", to: "admin", clearedOverrides: [] }),
    ).toBe("Jake Ruiz: Member → Admin");
    expect(
      describeTenancyAuditEntry("member.role.changed", { member: "Jake", from: "admin", to: "member", clearedOverrides: ["tenant.edit"] }),
    ).toBe("Jake: Admin → Member (their own extra access was cleared)");
  });

  it("names the person removed, and the role they had", () => {
    expect(describeTenancyAuditEntry("member.removed", { member: "maria@greenacres.test", role: "admin" })).toBe(
      "maria@greenacres.test (Admin)",
    );
    expect(describeTenancyAuditEntry("member.left", { member: "Sam", role: null })).toBe("Sam");
  });

  it("describes invitations without a token or a link", () => {
    expect(describeTenancyAuditEntry("invitation.sent", { email: "jo@x.test", roleKey: "viewer", resend: false })).toBe("jo@x.test as Viewer");
    expect(describeTenancyAuditEntry("invitation.sent", { email: "jo@x.test", roleKey: "member", resend: true })).toBe(
      "jo@x.test as Member (sent again)",
    );
    expect(
      describeTenancyAuditEntry("invitation.sent", { email: "jo@x.test", roleKey: "member", resend: true, previousRoleKey: "admin" }),
    ).toBe("jo@x.test as Member (was Admin)");
    expect(describeTenancyAuditEntry("invitation.revoked", { email: "alt@x.test", roleKey: "member", via: "member.removed" })).toBe(
      "alt@x.test: withdrawn because the person who sent it no longer could",
    );
  });

  it("covers the company's own changes", () => {
    expect(describeTenancyAuditEntry("company.created", { name: "Green Acres", slug: "green-acres" })).toBe("Green Acres (/green-acres)");
    expect(
      describeTenancyAuditEntry("company.profile.updated", {
        from: { name: "Green Acre", slug: "green-acre" },
        to: { name: "Green Acres", slug: "green-acres" },
      }),
    ).toBe("Name: Green Acre → Green Acres; Web address: green-acre → green-acres");
    expect(describeTenancyAuditEntry("company.suspended", { reason: "Payment needed" })).toBe("Reason: Payment needed");
    expect(describeTenancyAuditEntry("company.ownership.transferred", { from: "u1", to: "u2", via: "operator" })).toBe(
      "By platform staff",
    );
    expect(describeTenancyAuditEntry("company.ownership.transferred", { from: "u1", to: "u2", toName: "Bob" })).toBe("To Bob");
  });

  it("answers null, never throws, for an unknown action or a foreign shape", () => {
    expect(describeTenancyAuditEntry("permission.override.granted", { anything: 1 })).toBeNull();
    expect(describeTenancyAuditEntry("member.removed", "not an object")).toBeNull();
    expect(describeTenancyAuditEntry("invitation.sent", null)).toBeNull();
    // Every action this package audits has a branch (even if it can answer null).
    for (const action of Object.keys(tenancyAuditedActions)) {
      expect(() => describeTenancyAuditEntry(action, {})).not.toThrow();
    }
  });
});
