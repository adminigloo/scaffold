import { z } from "zod";
import {
  createSection,
  createSectionSchema,
  deactivateSection,
  listSectionVersions,
  listSections,
  publishSection,
  publishSectionSchema,
  rollbackSection,
  seedDefaultSections,
} from "__SCOPE__/assistant";
import {
  assistantChangeLog,
  assistantGlossary,
  assistantTenantRules,
} from "__SCOPE__/assistant/schema";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { createTRPCRouter, requireStaff } from "../trpc";

/**
 * The assistant's editable brain, staff side. Gated on `staff.dashboard.view`
 * — the key that says you may use this shell — like the feedback and SEO
 * routers before it: editing the assistant's personality is operator work,
 * not a privilege worth its own key until a team says otherwise.
 *
 * All correctness — budget enforcement, the 409 on a stale publish, the
 * required-phrase guard, the refuse-while-referenced rule — lives in
 * @__SCOPE_NAME__/assistant's server functions, so this router is a thin gate over
 * them and a fix ships by upgrading the package, not by editing this file.
 */
export const assistantRouter = createTRPCRouter({
  /** Sections, seeding the five guardrail defaults on first read of an empty table. */
  sections: requireStaff("staff.dashboard.view")
    .meta({ scope: "staff" })
    .query(async () => {
      await seedDefaultSections(db);
      return listSections(db);
    }),

  versions: requireStaff("staff.dashboard.view")
    .meta({ scope: "staff" })
    .input(z.object({ sectionId: z.string() }))
    .query(({ input }) => listSectionVersions(db, input.sectionId)),

  createSection: requireStaff("staff.dashboard.view")
    .meta({ scope: "staff" })
    .input(createSectionSchema)
    .mutation(({ input, ctx }) => createSection(db, input, ctx.principal.userId)),

  publishSection: requireStaff("staff.dashboard.view")
    .meta({ scope: "staff" })
    .input(publishSectionSchema)
    .mutation(({ input, ctx }) => publishSection(db, input, ctx.principal.userId)),

  rollbackSection: requireStaff("staff.dashboard.view")
    .meta({ scope: "staff" })
    .input(z.object({ sectionId: z.string(), toVersion: z.number().int().min(1) }))
    .mutation(({ input, ctx }) => rollbackSection(db, input, ctx.principal.userId)),

  deactivateSection: requireStaff("staff.dashboard.view")
    .meta({ scope: "staff" })
    .input(z.object({ sectionId: z.string() }))
    .mutation(({ input, ctx }) => deactivateSection(db, input.sectionId, ctx.principal.userId)),

  /** The change log — who changed the bot, when, and why. Newest first. */
  changeLog: requireStaff("staff.dashboard.view")
    .meta({ scope: "staff" })
    .input(z.object({ limit: z.number().int().min(1).max(200).default(50) }).optional())
    .query(({ input }) =>
      db
        .select({
          id: assistantChangeLog.id,
          entityType: assistantChangeLog.entityType,
          entityKey: assistantChangeLog.entityKey,
          action: assistantChangeLog.action,
          versionNumber: assistantChangeLog.versionNumber,
          changeSummary: assistantChangeLog.changeSummary,
          performedBy: assistantChangeLog.performedBy,
          createdAt: assistantChangeLog.createdAt,
        })
        .from(assistantChangeLog)
        .orderBy(desc(assistantChangeLog.id))
        .limit(input?.limit ?? 50),
    ),

  // --- Tenant overlays: the per-customer personality layer. This deployment
  // is one tenant (adminigloo-hq), so the UI edits that tenant's rules; the
  // package's assembly is what makes them layer onto the global sections.
  tenantRules: requireStaff("staff.dashboard.view")
    .meta({ scope: "staff" })
    .input(z.object({ tenantId: z.string().min(1).max(200) }))
    .query(({ input }) =>
      db
        .select()
        .from(assistantTenantRules)
        .where(eq(assistantTenantRules.tenantId, input.tenantId))
        .orderBy(assistantTenantRules.sortOrder),
    ),

  createTenantRule: requireStaff("staff.dashboard.view")
    .meta({ scope: "staff" })
    .input(
      z.object({
        tenantId: z.string().min(1).max(200),
        sectionKey: z.string().max(60).nullish(),
        label: z.string().min(1).max(80),
        instruction: z.string().min(1).max(2000),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const rows = await db
        .insert(assistantTenantRules)
        .values({
          tenantId: input.tenantId,
          sectionKey: input.sectionKey ?? null,
          label: input.label,
          instruction: input.instruction,
          createdBy: ctx.principal.userId,
        })
        .returning({ id: assistantTenantRules.id });
      return { id: rows[0]?.id };
    }),

  deactivateTenantRule: requireStaff("staff.dashboard.view")
    .meta({ scope: "staff" })
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input }) => {
      await db
        .update(assistantTenantRules)
        .set({ isActive: false })
        .where(eq(assistantTenantRules.id, input.id));
      return { ok: true };
    }),

  // --- Glossary.
  glossary: requireStaff("staff.dashboard.view")
    .meta({ scope: "staff" })
    .query(() =>
      db
        .select()
        .from(assistantGlossary)
        .where(eq(assistantGlossary.isActive, true))
        .orderBy(assistantGlossary.termKey),
    ),

  createGlossaryTerm: requireStaff("staff.dashboard.view")
    .meta({ scope: "staff" })
    .input(
      z.object({
        termKey: z
          .string()
          .min(1)
          .max(60)
          .regex(/^[a-z][a-z0-9_]*$/, "lowercase letters, digits and underscores"),
        preferred: z.string().min(1).max(120),
        aliases: z.array(z.string().min(1).max(60)).max(20).optional(),
        definition: z.string().max(500).nullish(),
        category: z.string().max(60).nullish(),
      }),
    )
    .mutation(async ({ input }) => {
      const rows = await db
        .insert(assistantGlossary)
        .values({
          termKey: input.termKey,
          preferred: input.preferred,
          aliases: input.aliases ?? [],
          definition: input.definition ?? null,
          category: input.category ?? null,
        })
        .returning({ id: assistantGlossary.id });
      return { id: rows[0]?.id };
    }),

  deactivateGlossaryTerm: requireStaff("staff.dashboard.view")
    .meta({ scope: "staff" })
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input }) => {
      await db
        .update(assistantGlossary)
        .set({ isActive: false })
        .where(and(eq(assistantGlossary.id, input.id)));
      return { ok: true };
    }),
});
