/**
 * REFUNDS, DISPUTES AND THE STAFF ORDERS LIST, AS THE GENERATOR WRITES THEM
 * (create-app 0.44). Read from the PLAN as text; the money rules themselves
 * (shares, idempotency, never below zero, disputes) are proved on PGlite by
 * the generated project's own suite, overlays/shop/src/server/__tests__/
 * refunds.test.ts, which runs in every shop project's `pnpm test`.
 *
 *   - the webhook hands `charge.refunded` and `charge.dispute.created` to the
 *     shop, and without a shop the hooks are no-ops;
 *   - /admin/orders is mounted, linked and gated on a STAFF key;
 *   - DEPLOYMENT.md names every event to enable, for the project's model;
 *   - an older shop is told to enable the two events and seed the new key.
 */

import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { capabilitiesFor, DEFAULT_ANSWERS, type Answers } from "../answers.js";
import { planEmit, type EmitPlan } from "../emit.js";
import { stripeWebhookEvents } from "../shop-emit.js";
import { upgradeNotesFor } from "../upgrade-notes.js";
import { TEMPLATE_DIR } from "./configurations.js";

function answers(overrides: Partial<Answers> = {}): Answers {
  return { ...DEFAULT_ANSWERS, projectName: "igloo-refunds", ...overrides };
}

const cache = new Map<string, Promise<EmitPlan>>();
function plan(overrides: Partial<Answers> = {}): Promise<EmitPlan> {
  const key = JSON.stringify(answers(overrides));
  let found = cache.get(key);
  if (!found) {
    found = planEmit(TEMPLATE_DIR, "/out", answers(overrides));
    cache.set(key, found);
  }
  return found;
}
function file(p: EmitPlan, ...segments: string[]): string {
  const contents = p.files.get(join(...segments));
  if (contents === undefined) throw new Error(`the plan has no ${segments.join("/")}`);
  return contents;
}
const has = (p: EmitPlan, ...segments: string[]) => p.files.has(join(...segments));
const code = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/** The verify run's project: people buying from one site's shop, with the full admin. */
const SHOP: Partial<Answers> = { tenantNoun: "none", audience: "consumers", businessModel: "one-time", adminShell: "full" };
/** Plans and nothing for sale. */
const PLANS: Partial<Answers> = { tenantNoun: "none", audience: "consumers", businessModel: "subscription", adminShell: "full" };
/** Takes no money at all. */
const NOTHING: Partial<Answers> = { tenantNoun: "none", businessModel: "none", adminShell: "full" };

describe("refunds and disputes reach the shop", () => {
  it("the webhook registers both events and hands them to the shop's hooks", async () => {
    const route = code(file(await plan(SHOP), "app", "api", "webhooks", "stripe", "route.ts"));
    expect(route).toContain('registry.on("charge.refunded"');
    expect(route).toContain("await refundShopPayment(event.data.object);");
    expect(route).toContain('registry.on("charge.dispute.created"');
    expect(route).toContain("await disputeShopPayment(event.data.object);");

    const hooks = code(file(await plan(SHOP), "src", "server", "shop-hooks.ts"));
    expect(hooks).toContain("await refundPurchase({");
    expect(hooks).toContain("refundedMinor: charge.amount_refunded,");
    expect(hooks).toContain("await disputePurchase({");
    const fulfilment = code(file(await plan(SHOP), "src", "server", "fulfilment.ts"));
    expect(fulfilment).toContain("export async function refundPurchase(");
    expect(fulfilment).toContain("export async function disputePurchase(");
  });

  it("without a shop the hooks are no-ops, so the same route is safe on a plans-only project", async () => {
    const hooks = code(file(await plan(PLANS), "src", "server", "shop-hooks.ts"));
    expect(hooks).toContain("export async function refundShopPayment(_charge: Stripe.Charge): Promise<void> {}");
    expect(hooks).toContain("export async function disputeShopPayment(_dispute: Stripe.Dispute): Promise<void> {}");
    expect(hooks).not.toContain("refundPurchase");
    expect(has(await plan(PLANS), "src", "server", "fulfilment.ts")).toBe(false);
  });

  it("the refunds proof ships in every shop project's unit suite", async () => {
    expect(has(await plan(SHOP), "src", "server", "__tests__", "refunds.test.ts")).toBe(true);
    expect(has(await plan(PLANS), "src", "server", "__tests__", "refunds.test.ts")).toBe(false);
  });
});

describe("the staff orders list", () => {
  it("mounts the router, links the page and gates both on the STAFF key commerce contributes", async () => {
    const p = await plan(SHOP);
    const router = code(file(p, "src", "server", "routers", "_app.ts"));
    expect(router).toContain('import { ordersRouter } from "./orders";');
    expect(router).toContain("orders: ordersRouter,");
    expect(has(p, "src", "server", "routers", "orders.ts")).toBe(true);
    expect(has(p, "app", "admin", "orders", "page.tsx")).toBe(true);
    expect(has(p, "app", "admin", "orders", "[id]", "page.tsx")).toBe(true);

    expect(file(p, "src", "components", "admin", "AdminNav.tsx")).toContain('href: "/admin/orders"');
    const catalog = file(p, "src", "permissions", "catalog.ts");
    expect(catalog).toContain('import { shopOrderPermissions } from "@adminigloo/commerce";');
    const staff = /definePermissions\(\s*"staff",\s*\{([^}]*)\}/.exec(catalog)?.[1] ?? "";
    expect(staff).toContain("shopOrderPermissions");

    // The procedures are staff-scoped and gated on the same key as the pages.
    const orders = file(p, "src", "server", "routers", "orders.ts");
    expect(orders.match(/requireStaff\("shop\.orders\.view"\)/g)).toHaveLength(2);
    expect(file(p, "app", "admin", "orders", "page.tsx")).toContain('can("shop.orders.view")');
    expect(file(p, "app", "admin", "orders", "[id]", "page.tsx")).toContain('can("shop.orders.view")');
  });

  it("is in no project without a shop, and in no shop without an admin shell", async () => {
    for (const overrides of [PLANS, NOTHING]) {
      const p = await plan(overrides);
      expect(code(file(p, "src", "server", "routers", "_app.ts"))).not.toContain("ordersRouter");
      expect(file(p, "src", "permissions", "catalog.ts")).not.toContain("shopOrderPermissions");
      expect(has(p, "app", "admin", "orders", "page.tsx")).toBe(false);
    }
    const bare = await plan({ ...SHOP, adminShell: "none" });
    expect(has(bare, "app", "admin", "orders", "page.tsx")).toBe(false);
    // The router and its key stay: the proof above drives them, and a page added later finds both.
    expect(code(file(bare, "src", "server", "routers", "_app.ts"))).toContain("orders: ordersRouter,");
  });

  it("claims the two capabilities only where their evidence is", () => {
    expect(capabilitiesFor(answers(SHOP))).toEqual(expect.arrayContaining(["commerce.refunds", "admin.orders"]));
    expect(capabilitiesFor(answers({ ...SHOP, adminShell: "none" }))).not.toContain("admin.orders");
    expect(capabilitiesFor(answers(PLANS))).not.toContain("commerce.refunds");
  });
});

describe("DEPLOYMENT.md and the upgrade note", () => {
  it("names every event to enable on both endpoints, for the project's model", async () => {
    const shop = file(await plan(SHOP), "DEPLOYMENT.md");
    expect(shop).toContain("### Stripe's webhook (one per mode)");
    for (const event of stripeWebhookEvents(answers(SHOP))) expect(shop, event).toContain(`\`${event}\``);
    expect(shop).toContain("`charge.refunded`");
    expect(shop).toContain("`charge.dispute.created`");
    expect(shop).toContain("`https://<STAGING_DOMAIN>/api/webhooks/stripe`");
    expect(shop).toContain("`https://<your domain>/api/webhooks/stripe`");
    expect(shop).not.toContain("<!-- adminigloo:");

    // Plans alone: the subscription five, and nothing about a shop's refunds.
    const plans = file(await plan(PLANS), "DEPLOYMENT.md");
    expect(plans).toContain("### Stripe's webhook (one per mode)");
    expect(plans).toContain("`invoice.payment_failed`");
    expect(plans).not.toContain("`charge.refunded`");
    expect(plans).not.toContain("`payment_intent.succeeded`");

    const nothing = file(await plan(NOTHING), "DEPLOYMENT.md");
    expect(nothing).not.toContain("Stripe's webhook (one per mode)");
    expect(nothing).not.toContain("<!-- adminigloo:");
    // Not even a stray blank line where the section would be.
    expect(nothing).toContain("link still land on Vercel's login page.\n\n### Email");
    expect(shop).toContain("forwards every event.\n\n### Email");
  });

  it("lists exactly the events the route acts on", () => {
    expect(stripeWebhookEvents(answers(SHOP))).toEqual([
      "payment_intent.succeeded",
      "charge.refunded",
      "charge.dispute.created",
      "customer.subscription.created",
      "customer.subscription.updated",
      "customer.subscription.deleted",
      "invoice.paid",
      "invoice.payment_failed",
    ]);
    expect(stripeWebhookEvents(answers(PLANS))).toHaveLength(5);
    expect(stripeWebhookEvents(answers(NOTHING))).toEqual([]);
  });

  it("tells a 0.43 shop to enable the two events and seed the new key, and nobody else", () => {
    const shop = upgradeNotesFor(answers(SHOP), "0.43.0").join("\n");
    expect(shop).toContain("charge.refunded");
    expect(shop).toContain("charge.dispute.created");
    expect(shop).toContain("pnpm db:seed");
    expect(shop).toContain("/admin/orders");
    expect(upgradeNotesFor(answers(PLANS), "0.43.0").join("\n")).not.toContain("charge.dispute.created");
    // A project already past it is told nothing more.
    expect(upgradeNotesFor(answers(SHOP), "0.44.0").join("\n")).not.toContain("charge.dispute.created");
  });
});
