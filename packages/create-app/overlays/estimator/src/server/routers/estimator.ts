import { z } from "zod";
import {
  allowedNextStatuses,
  attachComponent,
  attachComponentSchema,
  calculateEstimate,
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
  createPublicEstimate,
  deactivateComponent,
  deactivateProduct,
  detachComponent,
  EstimatorInputError,
  getEstimate,
  getProductDetail,
  issueClientKey,
  listClientKeys,
  listComponents,
  listEstimates,
  listProducts,
  listPublicOptions,
  publicCalculateEstimateSchema,
  publicSubmitSchema,
  revokeClientKey,
  setEstimateStatus,
  setEstimateStatusSchema,
  updateProduct,
  updateProductSchema,
} from "__SCOPE__/estimator";
import { db } from "@/db";
import { ESTIMATOR_TAX_RATE_BP, ESTIMATOR_TENANT, ensureDemoCatalog } from "@/server/estimator-seed";
import { createTRPCRouter, publicProcedure, requireStaff, TRPCError } from "../trpc";

/**
 * The estimator, from __SCOPE__/estimator (0.2.0).
 *
 * This deployment is a single tenant, so a fixed tenant id is injected
 * server-side on every call — the public instant-estimate tool can never name
 * another workspace's catalog, and the public reads return trimmed DTOs so the
 * raw rate table (base price, price-per-sqft) never leaves the server. Only the
 * quoted RANGE and customer-facing option prices are public.
 *
 * The public submit goes through `createPublicEstimate`, whose input has no
 * price, labor, discount, tax or photo field at all: the browser names the job
 * and the package prices it, taxed at this deployment's rate
 * (`ESTIMATOR_TAX_RATE_BP`). Every by-id call passes the tenant, and the
 * package filters by it — reads, estimate moves, and the catalog writes
 * (options, values, materials, attachments, embed keys) alike, so an id from
 * another workspace is "not found", never an edit to its price book.
 *
 * Staff procedures are gated on `staff.dashboard.view`, like feedback/SEO/
 * assistant before it: editing a price book is operator work, not yet worth its
 * own key. All correctness — the pricing math, server-owned totals, the status
 * lifecycle — lives in the package, so this router stays a thin gate. The demo
 * ramp catalog seeds on first read of an empty catalog, so the tool works on
 * every environment.
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

/**
 * A refusal from the package (an unavailable product, an unpriceable
 * measurement, a discount bigger than the work) is the caller's mistake: answer
 * 400 with its reason, not a 500 that reads like an outage.
 */
async function refusalsAsBadRequest<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof EstimatorInputError) {
      throw new TRPCError({ code: "BAD_REQUEST", message: error.message, cause: error });
    }
    throw error;
  }
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

  /** A product's customer-facing options (labels + price add-ons; staff-only options left out). */
  publicOptions: publicProcedure
    .meta({ scope: "public" })
    .input(z.object({ productId: z.string().min(1) }))
    .query(({ input }) => listPublicOptions(db, ESTIMATOR_TENANT, input.productId)),

  /** The live "$X–$Y" the tool shows on every keystroke. */
  calculate: publicProcedure
    .meta({ scope: "public" })
    // The public schema drops `measurement.units` rather than refusing it: the
    // package prices a public line with units = 1 whatever the body says.
    .input(publicCalculateEstimateSchema)
    .query(({ input }) =>
      // Tenant-scoped and public: another workspace's product, a hidden one,
      // or a staff-only option prices as nothing, and an area needs width ×
      // height (a bare sqFt left the perimeter out of the price).
      calculateEstimate(db, input, { tenantId: ESTIMATOR_TENANT, audience: "public" }),
    ),

  /** A customer saves their estimate — the lead. Priced, taxed and tenanted on the server. */
  submit: publicProcedure
    .meta({ scope: "public" })
    .input(publicSubmitSchema)
    .mutation(({ input }) =>
      refusalsAsBadRequest(() =>
        createPublicEstimate(db, input, {
          tenantId: ESTIMATOR_TENANT,
          taxRateBp: ESTIMATOR_TAX_RATE_BP,
        }),
      ),
    ),

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
    .query(({ input }) => getProductDetail(db, ESTIMATOR_TENANT, input.productId)),

  createProduct: requireStaff("staff.dashboard.view")
    .meta({ scope: "staff" })
    .input(createProductSchema.omit({ tenantId: true }))
    .mutation(({ input }) =>
      refusalsAsBadRequest(() => createProduct(db, { ...input, tenantId: ESTIMATOR_TENANT })),
    ),

  updateProduct: requireStaff("staff.dashboard.view")
    .meta({ scope: "staff" })
    // updateProductSchema, not createProductSchema.omit().partial(): under zod 4
    // the latter refills every defaulted field a partial patch left out.
    .input(z.object({ id: z.string().min(1), patch: updateProductSchema }))
    .mutation(({ input }) =>
      refusalsAsBadRequest(() => updateProduct(db, ESTIMATOR_TENANT, input.id, input.patch)),
    ),

  deactivateProduct: requireStaff("staff.dashboard.view")
    .meta({ scope: "staff" })
    .input(z.object({ id: z.string().min(1) }))
    .mutation(async ({ input }) => ({ ok: await deactivateProduct(db, ESTIMATOR_TENANT, input.id) })),

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
    .mutation(async ({ input }) => ({ ok: await deactivateComponent(db, ESTIMATOR_TENANT, input.id) })),

  attachComponent: requireStaff("staff.dashboard.view")
    .meta({ scope: "staff" })
    .input(attachComponentSchema)
    .mutation(({ input }) =>
      refusalsAsBadRequest(async () => ({ id: await attachComponent(db, ESTIMATOR_TENANT, input) })),
    ),

  detachComponent: requireStaff("staff.dashboard.view")
    .meta({ scope: "staff" })
    .input(z.object({ assignmentId: z.string().min(1) }))
    .mutation(async ({ input }) => ({
      ok: await detachComponent(db, ESTIMATOR_TENANT, input.assignmentId),
    })),

  createOption: requireStaff("staff.dashboard.view")
    .meta({ scope: "staff" })
    .input(createOptionSchema)
    .mutation(({ input }) => refusalsAsBadRequest(() => createOption(db, ESTIMATOR_TENANT, input))),

  createOptionValue: requireStaff("staff.dashboard.view")
    .meta({ scope: "staff" })
    .input(createOptionValueSchema)
    .mutation(({ input }) =>
      refusalsAsBadRequest(() => createOptionValue(db, ESTIMATOR_TENANT, input)),
    ),

  // --- Staff: estimates ----------------------------------------------------

  estimates: requireStaff("staff.dashboard.view")
    .meta({ scope: "staff" })
    .input(z.object({ limit: z.number().int().min(1).max(200).default(100) }).optional())
    .query(({ input }) => listEstimates(db, ESTIMATOR_TENANT, input?.limit ?? 100)),

  /**
   * One estimate, with the statuses staff may move it to next (the lifecycle
   * lives in the package). `converted` is never offered: it means an invoice
   * exists, so only the invoicing claim (`markEstimateConverted`) sets it —
   * set by hand, the estimate could never be invoiced (the bridge refuses a
   * converted one), and `setEstimateStatus` refuses it anyway.
   */
  estimate: requireStaff("staff.dashboard.view")
    .meta({ scope: "staff" })
    .input(z.object({ id: z.string().min(1) }))
    .query(async ({ input }) => {
      const detail = await getEstimate(db, ESTIMATOR_TENANT, input.id);
      return detail
        ? {
            ...detail,
            nextStatuses: allowedNextStatuses(detail.estimate.status).filter((s) => s !== "converted"),
          }
        : null;
    }),

  createEstimate: requireStaff("staff.dashboard.view")
    .meta({ scope: "staff" })
    .input(createEstimateSchema.omit({ tenantId: true }))
    .mutation(({ input, ctx }) =>
      refusalsAsBadRequest(() =>
        createEstimate(db, { ...input, tenantId: ESTIMATOR_TENANT }, ctx.principal.userId),
      ),
    ),

  /** `ok: false` when the move is not in the lifecycle (e.g. out of `converted`), or is to `converted`. */
  setEstimateStatus: requireStaff("staff.dashboard.view")
    .meta({ scope: "staff" })
    .input(setEstimateStatusSchema)
    .mutation(async ({ input }) => ({ ok: await setEstimateStatus(db, ESTIMATOR_TENANT, input) })),

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
    // `ok: false` when the key is not this deployment's — never another's revoked.
    .mutation(async ({ input }) => ({ ok: await revokeClientKey(db, ESTIMATOR_TENANT, input.id) })),
});
