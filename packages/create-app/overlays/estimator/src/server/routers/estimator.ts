import { z } from "zod";
import {
  attachComponent,
  attachComponentSchema,
  calculateEstimate,
  calculateEstimateSchema,
  createComponent,
  createComponentSchema,
  createEstimate,
  createEstimateSchema,
  createOption,
  createOptionSchema,
  createOptionValue,
  createOptionValueSchema,
  createProduct,
  createProductSchema,
  deactivateComponent,
  deactivateProduct,
  detachComponent,
  getEstimate,
  getProductDetail,
  issueClientKey,
  listClientKeys,
  listComponents,
  listEstimates,
  listProducts,
  revokeClientKey,
  setEstimateStatus,
  setEstimateStatusSchema,
  updateProduct,
} from "__SCOPE__/estimator";
import { db } from "@/db";
import { ESTIMATOR_TENANT, ensureDemoCatalog } from "@/server/estimator-seed";
import { createTRPCRouter, publicProcedure, requireStaff } from "../trpc";

/**
 * The estimator, from __SCOPE__/estimator (0.1.0).
 *
 * This deployment is a single tenant, so a fixed tenant id is injected
 * server-side on every write — the public instant-estimate tool can never name
 * another workspace's catalog, and the public reads return trimmed DTOs so the
 * raw rate table (base price, price-per-sqft) never leaves the server. Only the
 * quoted RANGE and customer-facing option prices are public.
 *
 * Staff procedures are gated on `staff.dashboard.view`, like feedback/SEO/
 * assistant before it: editing a price book is operator work, not yet worth its
 * own key. All correctness — the pricing math, server-owned totals — lives in
 * the package, so this router stays a thin gate. The demo ramp catalog seeds on
 * first read of an empty catalog, so the tool works on every environment.
 */

/** What the public tool may see about a product — never the cost inputs. */
interface PublicProduct {
  id: string;
  name: string;
  category: string | null;
  description: string | null;
  measurementMode: string;
  isEstimatable: boolean;
}

export const estimatorRouter = createTRPCRouter({
  // --- Public: the instant-estimate tool -----------------------------------

  /** The estimatable catalog for the public tool — trimmed, no rate table. */
  publicProducts: publicProcedure.meta({ scope: "public" }).query(async (): Promise<PublicProduct[]> => {
    await ensureDemoCatalog(db);
    const products = await listProducts(db, ESTIMATOR_TENANT, { publicOnly: true });
    return products.map((p) => ({
      id: p.id,
      name: p.name,
      category: p.category,
      description: p.description,
      measurementMode: p.measurementMode,
      isEstimatable: p.isEstimatable,
    }));
  }),

  /** A product's customer-facing options (labels + price add-ons only). */
  publicOptions: publicProcedure
    .meta({ scope: "public" })
    .input(z.object({ productId: z.string().min(1) }))
    .query(async ({ input }) => {
      const detail = await getProductDetail(db, input.productId);
      if (!detail || detail.product.tenantId !== ESTIMATOR_TENANT) return [];
      return detail.options.map((o) => ({
        id: o.option.id,
        name: o.option.name,
        values: o.values.map((v) => ({
          id: v.id,
          label: v.label,
          priceModifier: v.priceModifier,
          isDefault: v.isDefault,
        })),
      }));
    }),

  /** The live "$X–$Y" the tool shows on every keystroke. */
  calculate: publicProcedure
    .meta({ scope: "public" })
    .input(calculateEstimateSchema)
    .query(async ({ input }) => {
      // Guard the product belongs to this tenant before pricing it.
      const detail = await getProductDetail(db, input.productId);
      if (!detail || detail.product.tenantId !== ESTIMATOR_TENANT) return null;
      return calculateEstimate(db, input);
    }),

  /** A customer saves their estimate — the lead. Tenant + source forced here. */
  submit: publicProcedure
    .meta({ scope: "public" })
    .input(
      createEstimateSchema
        .omit({ tenantId: true, source: true })
        .extend({ source: z.enum(["public_tool", "photo"]).default("public_tool") }),
    )
    .mutation(async ({ input }) => {
      const { source, ...rest } = input;
      // The productIds arrive from the browser. Verify each belongs to this
      // tenant before pricing — otherwise createEstimate would price and store a
      // line against another tenant's product. Mirrors the embed handler's check.
      for (const item of rest.items) {
        if (!item.productId) continue;
        const detail = await getProductDetail(db, item.productId);
        if (!detail || detail.product.tenantId !== ESTIMATOR_TENANT) {
          throw new Error("unknown product");
        }
      }
      return createEstimate(db, { ...rest, tenantId: ESTIMATOR_TENANT, source });
    }),

  // --- Staff: the catalog (price book) -------------------------------------

  products: requireStaff("staff.dashboard.view")
    .meta({ scope: "staff" })
    .query(async () => {
      await ensureDemoCatalog(db);
      return listProducts(db, ESTIMATOR_TENANT);
    }),

  productDetail: requireStaff("staff.dashboard.view")
    .meta({ scope: "staff" })
    .input(z.object({ productId: z.string().min(1) }))
    .query(({ input }) => getProductDetail(db, input.productId)),

  createProduct: requireStaff("staff.dashboard.view")
    .meta({ scope: "staff" })
    .input(createProductSchema.omit({ tenantId: true }))
    .mutation(({ input }) => createProduct(db, { ...input, tenantId: ESTIMATOR_TENANT })),

  updateProduct: requireStaff("staff.dashboard.view")
    .meta({ scope: "staff" })
    .input(z.object({ id: z.string().min(1), patch: createProductSchema.omit({ tenantId: true }).partial() }))
    .mutation(({ input }) => updateProduct(db, input.id, input.patch)),

  deactivateProduct: requireStaff("staff.dashboard.view")
    .meta({ scope: "staff" })
    .input(z.object({ id: z.string().min(1) }))
    .mutation(async ({ input }) => ({ ok: await deactivateProduct(db, input.id) })),

  components: requireStaff("staff.dashboard.view")
    .meta({ scope: "staff" })
    .query(() => listComponents(db, ESTIMATOR_TENANT)),

  createComponent: requireStaff("staff.dashboard.view")
    .meta({ scope: "staff" })
    .input(createComponentSchema.omit({ tenantId: true }))
    .mutation(({ input }) => createComponent(db, { ...input, tenantId: ESTIMATOR_TENANT })),

  deactivateComponent: requireStaff("staff.dashboard.view")
    .meta({ scope: "staff" })
    .input(z.object({ id: z.string().min(1) }))
    .mutation(async ({ input }) => ({ ok: await deactivateComponent(db, input.id) })),

  attachComponent: requireStaff("staff.dashboard.view")
    .meta({ scope: "staff" })
    .input(attachComponentSchema)
    .mutation(async ({ input }) => ({ id: await attachComponent(db, input) })),

  detachComponent: requireStaff("staff.dashboard.view")
    .meta({ scope: "staff" })
    .input(z.object({ assignmentId: z.string().min(1) }))
    .mutation(async ({ input }) => ({ ok: await detachComponent(db, input.assignmentId) })),

  createOption: requireStaff("staff.dashboard.view")
    .meta({ scope: "staff" })
    .input(createOptionSchema)
    .mutation(({ input }) => createOption(db, input)),

  createOptionValue: requireStaff("staff.dashboard.view")
    .meta({ scope: "staff" })
    .input(createOptionValueSchema)
    .mutation(({ input }) => createOptionValue(db, input)),

  // --- Staff: estimates ----------------------------------------------------

  estimates: requireStaff("staff.dashboard.view")
    .meta({ scope: "staff" })
    .input(z.object({ limit: z.number().int().min(1).max(200).default(100) }).optional())
    .query(({ input }) => listEstimates(db, ESTIMATOR_TENANT, input?.limit ?? 100)),

  estimate: requireStaff("staff.dashboard.view")
    .meta({ scope: "staff" })
    .input(z.object({ id: z.string().min(1) }))
    .query(({ input }) => getEstimate(db, input.id)),

  createEstimate: requireStaff("staff.dashboard.view")
    .meta({ scope: "staff" })
    .input(createEstimateSchema.omit({ tenantId: true }))
    .mutation(({ input, ctx }) =>
      createEstimate(db, { ...input, tenantId: ESTIMATOR_TENANT }, ctx.principal.userId),
    ),

  setEstimateStatus: requireStaff("staff.dashboard.view")
    .meta({ scope: "staff" })
    .input(setEstimateStatusSchema)
    .mutation(async ({ input }) => ({ ok: await setEstimateStatus(db, input) })),

  // --- Embed keys: the widget licence --------------------------------------

  clientKeys: requireStaff("staff.dashboard.view")
    .meta({ scope: "staff" })
    .query(() => listClientKeys(db, ESTIMATOR_TENANT)),

  issueClientKey: requireStaff("staff.dashboard.view")
    .meta({ scope: "staff" })
    .input(z.object({ label: z.string().min(1).max(120) }))
    .mutation(({ input }) => issueClientKey(db, { tenantId: ESTIMATOR_TENANT, label: input.label })),

  revokeClientKey: requireStaff("staff.dashboard.view")
    .meta({ scope: "staff" })
    .input(z.object({ id: z.string().min(1) }))
    .mutation(async ({ input }) => {
      await revokeClientKey(db, input.id);
      return { ok: true };
    }),
});
