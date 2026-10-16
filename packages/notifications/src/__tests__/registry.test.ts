import { describe, expect, it } from "vitest";
import {
  defineAlertKinds,
  defineAlertRegistry,
  DuplicateAlertKindError,
  InvalidAlertKindError,
  type AlertKindSpec,
  type AlertRoutingSpec,
} from "../registry.js";
import { commsKinds, estimatorKinds, invoicingKinds, REGISTRY, schedulingKinds, tenancyKinds } from "./fixtures.js";

/**
 * The registry (Tenancy 2b-1, 4.2; D3): fragments checked at definition, the
 * project's registry composed and ordered, every refusal in words.
 */

const kind = (extra: Partial<AlertKindSpec> = {}): AlertKindSpec => ({
  key: "estimator.lead",
  label: "Someone asks for an estimate",
  category: "Estimates",
  audience: { permission: "estimates.view" },
  defaultChannel: "in_app",
  ...extra,
});
const routing = (extra: Partial<AlertRoutingSpec> = {}): AlertRoutingSpec => ({
  key: "estimates",
  label: "New estimate requests and quote answers",
  permission: "estimates.view",
  ...extra,
});

describe("defineAlertKinds refuses, at definition time", () => {
  const refusals: [string, Partial<AlertKindSpec>][] = [
    ["a key failing the pattern", { key: "Estimator.Lead" }],
    ["a one-part key", { key: "estimator" }],
    ["a key with five parts", { key: "a.b.c.d.e" }],
    ["a key over 64 characters", { key: `estimator.${"x".repeat(60)}` }],
    ["an empty label", { label: "" }],
    ["a label over 80", { label: "x".repeat(81) }],
    ["an empty category", { category: "" }],
    ["a category over 40", { category: "x".repeat(41) }],
    ["a description over 200", { description: "x".repeat(201) }],
    ["an empty permission", { audience: { permission: "" } }],
    ["an empty assigned permission", { audience: { permission: "schedule.view", assigned: { permission: " " } } }],
    ["a bad routing key", { audience: { permission: "estimates.view", routing: "Estimates!" } }],
    ["a channel that doesn't exist", { defaultChannel: "sms" as never }],
    ['defaultChannel "email" on a never-emailed kind', { email: false, defaultChannel: "email" }],
    ['emailBy "producer" on a never-emailed kind', { email: false, emailBy: "producer" }],
  ];
  for (const [what, extra] of refusals) {
    it(what, () => {
      expect(() => defineAlertKinds({ kinds: [kind(extra)] })).toThrow(InvalidAlertKindError);
    });
  }

  it("a routing key failing its pattern", () => {
    expect(() => defineAlertKinds({ kinds: [], routings: [routing({ key: "x" })] })).toThrow(InvalidAlertKindError);
    expect(() => defineAlertKinds({ kinds: [], routings: [routing({ key: "has space" })] })).toThrow(InvalidAlertKindError);
  });

  it("a key declared twice in one fragment", () => {
    expect(() => defineAlertKinds({ kinds: [kind(), kind()] })).toThrow(DuplicateAlertKindError);
  });

  it("names the kind in the refusal", () => {
    expect(() => defineAlertKinds({ kinds: [kind({ label: "" })] })).toThrow(/estimator\.lead: the label/);
  });

  it("hands a good fragment back as it is", () => {
    const fragment = { kinds: [kind()], routings: [routing()] };
    expect(defineAlertKinds(fragment)).toBe(fragment);
  });
});

describe("defineAlertRegistry", () => {
  it("refuses a duplicate kind or routing across fragments", () => {
    expect(() => defineAlertRegistry([{ kinds: [kind()] }, { kinds: [kind()] }])).toThrow(DuplicateAlertKindError);
    expect(() => defineAlertRegistry([{ kinds: [], routings: [routing()] }, { kinds: [], routings: [routing()] }])).toThrow(
      DuplicateAlertKindError,
    );
  });

  it("refuses a kind naming a routing group no fragment declares", () => {
    expect(() => defineAlertRegistry([{ kinds: [kind({ audience: { permission: "estimates.view", routing: "estimates" } })] }])).toThrow(
      /routing group estimates, which no package declares/,
    );
  });

  it("orders by category (first seen), then order, then key", () => {
    expect(REGISTRY.categories).toEqual(["Team", "Visits", "Estimates", "Invoices", "Messages"]);
    expect(REGISTRY.kinds.map((k) => k.key)).toEqual([
      "tenancy.member.joined",
      "scheduling.visit.requested",
      "scheduling.visit.moved",
      "scheduling.request.expiring",
      "estimator.lead",
      "estimator.quote.accepted",
      "invoicing.invoice.paid",
      "comms.message.failed",
    ]);
    const tie = defineAlertRegistry([
      { kinds: [kind({ key: "x.b" }), kind({ key: "x.a" }), kind({ key: "x.c", order: 1 })] },
    ]);
    expect(tie.kinds.map((k) => k.key)).toEqual(["x.c", "x.a", "x.b"]);
    expect(REGISTRY.routings.map((r) => r.key)).toEqual(["estimates", "visits", "invoices"]);
  });

  it("lists every distinct permission the kinds, their assigned and the routings name, sorted", () => {
    expect(REGISTRY.permissions).toEqual(["comms.view", "estimates.view", "invoices.view", "members.invite", "schedule.route", "schedule.view"]);
  });

  it("looks kinds and groups up by key", () => {
    expect(REGISTRY.kind("estimator.lead")?.label).toBe("Someone asks for an estimate");
    expect(REGISTRY.kind("estimator.leed")).toBeUndefined();
    expect(REGISTRY.routing("visits")?.permission).toBe("schedule.view");
    expect(REGISTRY.routing("nope")).toBeUndefined();
  });

  it("is frozen", () => {
    expect(Object.isFrozen(REGISTRY.kinds)).toBe(true);
    expect(Object.isFrozen(REGISTRY.permissions)).toBe(true);
  });

  it("composes the 2a packages' fragments in any order into the same ordering by category of first sight", () => {
    const other = defineAlertRegistry([commsKinds, invoicingKinds, estimatorKinds, schedulingKinds, tenancyKinds]);
    expect(other.categories).toEqual(["Messages", "Invoices", "Estimates", "Visits", "Team"]);
    expect(other.permissions).toEqual(REGISTRY.permissions);
  });
});
