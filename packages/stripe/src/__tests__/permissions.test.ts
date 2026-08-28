import { describe, expect, it } from "vitest";
import { definePermissions } from "@adminigloo/permissions";
import { stripePermissions } from "../permissions.js";

const catalog = definePermissions("tenant", stripePermissions);

describe("stripePermissions", () => {
  it("declares exactly the three billing capabilities", () => {
    expect([...catalog.keys].sort()).toEqual([
      "billing.invoices.view",
      "billing.portal.open",
      "billing.refund.issue",
    ]);
  });

  it("SEALS refunds, so a template's deny cannot be reopened per person", () => {
    // Refunds move real money out of the account. The failure mode is somebody
    // granting it to one person "just for today" during an incident and nobody
    // ever taking it away.
    expect(catalog.isSealed("billing.refund.issue")).toBe(true);
  });

  it("does not seal the read-only capabilities", () => {
    expect(catalog.isSealed("billing.portal.open")).toBe(false);
    expect(catalog.isSealed("billing.invoices.view")).toBe(false);
  });

  it("seeds the two read/manage keys and withholds the money-moving one", () => {
    // Owning the whole billing namespace means owning its defaults too. While
    // @adminigloo/tenancy also shipped a billing.manage, the safe move was to
    // seed nothing here — but that left a seeded owner holding NO billing key
    // at all, so the portal was unreachable until someone hand-edited a
    // template. Now that this package owns the namespace outright, the
    // defaults have to be here or they exist nowhere.
    expect(catalog.get("billing.portal.open").defaultFor).toEqual(["owner"]);
    expect(catalog.get("billing.invoices.view").defaultFor).toEqual([
      "owner",
      "admin",
    ]);
  });

  it("never seeds the sealed refund key into any template", () => {
    // Refunds move money out. Sealed means an override cannot grant it; not
    // seeding it means no template starts with it either.
    expect(catalog.get("billing.refund.issue").defaultFor).toBeUndefined();
    expect(catalog.isSealed("billing.refund.issue")).toBe(true);
  });

  it("groups under one category so the checklist stays readable", () => {
    expect([...(catalog.byCategory().get("Billing") ?? [])].sort()).toEqual([
      "billing.invoices.view",
      "billing.portal.open",
      "billing.refund.issue",
    ]);
  });
});
