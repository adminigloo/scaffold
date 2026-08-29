import { describe, expect, it } from "vitest";
import {
  DuplicateAuditActionError,
  UnknownAuditActionError,
  auditEntry,
  defineAuditedActions,
  type AuditActionKeyOf,
  type AuditedActionMap,
} from "../audit.js";
import { REDACTED } from "../logger.js";

const billingActions = {
  "billing.portal.opened": { label: "Opened the billing portal" },
  "billing.invoice.downloaded": {
    label: "Downloaded an invoice",
    sensitive: true,
  },
} as const satisfies AuditedActionMap;

const tenancyActions = {
  "members.invited": { label: "Invited a member" },
  "members.removed": { label: "Removed a member" },
} as const satisfies AuditedActionMap;

const registry = defineAuditedActions({
  ...billingActions,
  ...tenancyActions,
  "support.impersonation.started": {
    label: "Started an impersonated session",
    sensitive: true,
  },
});

type ActionKey = AuditActionKeyOf<typeof registry>;

/**
 * The action askLou names with a string literal at the call site.
 *
 * Laundered through `string` so the cast compiles, which is exactly what a
 * real call site does when someone reaches for `as` to silence the type
 * error. The runtime throw is the only thing standing behind it.
 */
const UNDECLARED: string = "invoice.exported";

describe("defineAuditedActions", () => {
  it("exposes every declared key", () => {
    expect(registry.keys).toEqual([
      "billing.portal.opened",
      "billing.invoice.downloaded",
      "members.invited",
      "members.removed",
      "support.impersonation.started",
    ]);
  });

  it("narrows a string with has()", () => {
    expect(registry.has("members.invited")).toBe(true);
    expect(registry.has("members.banished")).toBe(false);
  });

  it("returns the definition", () => {
    expect(registry.get("members.invited")).toEqual({
      label: "Invited a member",
    });
  });

  it("throws for a key it has never heard of", () => {
    // The one enforcement that makes the registry worth having. An action
    // named at the call site has to fail here rather than becoming a row no
    // audit query can find.
    expect(() => registry.get(UNDECLARED as ActionKey)).toThrow(
      UnknownAuditActionError,
    );
  });

  it("reports sensitivity, defaulting to false", () => {
    expect(registry.isSensitive("billing.invoice.downloaded")).toBe(true);
    expect(registry.isSensitive("support.impersonation.started")).toBe(true);
    expect(registry.isSensitive("members.invited")).toBe(false);
  });

  it("reports an unrecognised key as not sensitive rather than throwing", () => {
    // Matches `Catalog.isSealed`. A predicate used to render a list must not
    // take the page down over one stale key.
    expect(registry.isSensitive("nope")).toBe(false);
  });
});

describe("defineAuditedActions — collisions between packages", () => {
  it("throws when two fragments claim the same key", () => {
    // Unspottable without this check: the spread keeps the last one, so both
    // packages typecheck, both look installed, and whichever `sensitive` flag
    // happened to be second decides whether the action appears in the
    // compliance report.
    const commerce = { "order.refunded": { label: "Refunded an order" } };
    const finance = {
      "order.refunded": { label: "Issued a refund", sensitive: true },
    };
    expect(() =>
      defineAuditedActions(
        { ...commerce, ...finance },
        { contributedBy: [commerce, finance] },
      ),
    ).toThrow(DuplicateAuditActionError);
  });

  it("names the colliding key in the error", () => {
    const a = { "order.refunded": { label: "A" } };
    const b = { "order.refunded": { label: "B" } };
    expect(() =>
      defineAuditedActions({ ...a, ...b }, { contributedBy: [a, b] }),
    ).toThrow(/order\.refunded/);
  });

  it("accepts distinct fragments", () => {
    expect(() =>
      defineAuditedActions(
        { ...billingActions, ...tenancyActions },
        { contributedBy: [billingActions, tenancyActions] },
      ),
    ).not.toThrow();
  });
});

describe("auditEntry", () => {
  it("builds the row from the actor and the resource", () => {
    expect(
      auditEntry(registry, {
        action: "members.removed",
        actor: { userId: "u_1" },
        scope: "tenant",
        tenantId: "t_42",
        resourceType: "user",
        resourceId: "u_9",
        request: { ipAddress: "203.0.113.7", userAgent: "curl/8.6" },
      }),
    ).toEqual({
      action: "members.removed",
      actorUserId: "u_1",
      actorImpersonatedBy: null,
      scope: "tenant",
      tenantId: "t_42",
      resourceType: "user",
      resourceId: "u_9",
      isSensitive: false,
      ipAddress: "203.0.113.7",
      userAgent: "curl/8.6",
      metadata: null,
    });
  });

  it("records the impersonator separately from the actor", () => {
    // Both ids, always. The staff id alone loses whose data was touched; the
    // customer id alone produces a log that says the customer did it.
    const entry = auditEntry(registry, {
      action: "support.impersonation.started",
      actor: { userId: "u_customer", impersonatedBy: "u_staff" },
    });
    expect(entry.actorUserId).toBe("u_customer");
    expect(entry.actorImpersonatedBy).toBe("u_staff");
  });

  it("accepts a Principal-shaped actor unchanged", () => {
    // Structurally what @adminigloo/auth hands a route.
    const principal = {
      userId: "u_1",
      externalId: "user_2abc",
      email: "ada@example.com",
      impersonatedBy: "u_staff",
    };
    expect(auditEntry(registry, { action: "members.invited", actor: principal })).toMatchObject(
      { actorUserId: "u_1", actorImpersonatedBy: "u_staff" },
    );
  });

  it("takes isSensitive from the registry, not from the caller", () => {
    // The compliance query is a partial index on this column. A caller who
    // could pass `false` would not mislabel the row, they would delete it from
    // the only report anyone runs.
    expect(
      auditEntry(registry, { action: "billing.invoice.downloaded" }).isSensitive,
    ).toBe(true);
  });

  it("allows a null actor, for a cron job or a webhook", () => {
    const entry = auditEntry(registry, { action: "members.removed", actor: null });
    expect(entry.actorUserId).toBeNull();
    expect(entry.actorImpersonatedBy).toBeNull();
  });

  it("refuses an action the registry does not declare", () => {
    expect(() =>
      auditEntry(registry, { action: UNDECLARED as ActionKey }),
    ).toThrow(UnknownAuditActionError);
  });

  it("redacts metadata before it reaches the jsonb column", () => {
    // Caller-supplied, never redacted on read, and the audit log is the one
    // table deliberately kept longer than everything else.
    const entry = auditEntry(registry, {
      action: "billing.portal.opened",
      metadata: {
        returnUrl: "https://app.example.com/billing",
        stripeKey: "sk_live_51H8xKzABCDEFGHijklmnop",
      },
    });
    expect(entry.metadata).toEqual({
      returnUrl: "https://app.example.com/billing",
      stripeKey: REDACTED,
    });
  });

  it("does not mutate the metadata it was handed", () => {
    const metadata = { key: "sk_live_51H8xKzABCDEFGHijklmnop" };
    auditEntry(registry, { action: "members.invited", metadata });
    expect(metadata.key).toBe("sk_live_51H8xKzABCDEFGHijklmnop");
  });

  it("is pure — the same input twice produces the same row", () => {
    const input = { action: "members.invited", actor: { userId: "u_1" } } as const;
    expect(auditEntry(registry, input)).toEqual(auditEntry(registry, input));
  });
});
