import { and, eq, isNotNull, isNull } from "drizzle-orm";
import { estimatorClientKeys, estimatorProducts, estimatorSettings } from "./schema.js";
import type { EstimatorDb } from "./types.js";

/**
 * The estimator's items on the company setup checklist (Tenancy 2a, 7.6).
 * Structural (D4): the same shape as tenancy's `SetupChecklistItem`, declared
 * here so the estimator never imports tenancy; `defineSetupChecklist`
 * accepts it as is. Each `isDone` is one `select … limit 1`, by tenant.
 */
export interface EstimatorChecklistItem {
  readonly key: string;
  readonly title: string;
  readonly description: string;
  readonly actionLabel: string;
  readonly href: string;
  readonly order: number;
  readonly permission?: string;
  isDone(ctx: { readonly db: unknown; readonly tenantId: string }): Promise<boolean>;
}

export function estimatorChecklistItems(hrefs: {
  readonly priceBook: string;
  readonly settings: string;
  readonly embed: string;
}): readonly EstimatorChecklistItem[] {
  return [
    {
      key: "estimator.prices",
      order: 60,
      permission: "estimator.pricebook.manage",
      title: "Add the work you sell and its prices",
      description: "Build your price book, or load the sample to start from. Customers only see prices for what you add.",
      actionLabel: "Open the price book",
      href: hrefs.priceBook,
      // An active product the estimator shows customers: what makes the
      // estimate page more than an empty form.
      isDone: async (ctx) => {
        const db = ctx.db as EstimatorDb;
        const [row] = await db
          .select({ id: estimatorProducts.id })
          .from(estimatorProducts)
          .where(and(eq(estimatorProducts.tenantId, ctx.tenantId), eq(estimatorProducts.isActive, true), eq(estimatorProducts.showInEstimator, true)))
          .limit(1);
        return row !== undefined;
      },
    },
    {
      key: "estimator.settings",
      order: 70,
      permission: "estimator.settings.manage",
      title: "Set your tax rate and quote rules",
      description: "Instant estimates stay closed until you save these once.",
      actionLabel: "Estimate settings",
      href: hrefs.settings,
      isDone: async (ctx) => {
        const db = ctx.db as EstimatorDb;
        const [row] = await db
          .select({ id: estimatorSettings.tenantId })
          .from(estimatorSettings)
          .where(and(eq(estimatorSettings.tenantId, ctx.tenantId), isNotNull(estimatorSettings.savedAt)))
          .limit(1);
        return row !== undefined;
      },
    },
    {
      key: "estimator.embed",
      order: 90,
      permission: "estimator.settings.manage",
      // In an owner's terms (review T2A-BO-02 / TB-2): a lawn or cleaning
      // business's website is Wix, Squarespace or WordPress, so the item
      // offers a BUTTON it can paste anywhere, not code for a developer.
      title: "Add an estimate button to your website",
      // A pasted button leaves no trace here (it needs no key), so only a
      // website key ticks this item by itself: the owner who pastes the button
      // is told to dismiss it, rather than left with an item that never ends.
      description:
        "Copy a ready-made button that opens your estimate page. It works on Wix, Squarespace, WordPress or any site. Once it is on your website, or if customers only use your page here, dismiss this.",
      actionLabel: "Get the button",
      href: hrefs.embed,
      isDone: async (ctx) => {
        const db = ctx.db as EstimatorDb;
        const [row] = await db
          .select({ id: estimatorClientKeys.id })
          .from(estimatorClientKeys)
          .where(and(eq(estimatorClientKeys.tenantId, ctx.tenantId), isNull(estimatorClientKeys.revokedAt)))
          .limit(1);
        return row !== undefined;
      },
    },
  ];
}
