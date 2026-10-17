import { z } from "zod";
import {
  ASSISTANT_PLATFORM,
  createGlossaryTerm,
  createGlossaryTermSchema,
  createSection,
  createSectionSchema,
  createTenantRule,
  deactivateGlossaryTerm,
  deactivateSection,
  deactivateTenantRule,
  listChangeLog,
  listGlossary,
  listSectionVersions,
  listSections,
  listTenantRules,
  publishSection,
  publishSectionSchema,
  rollbackSection,
  seedDefaultSections,
} from "__SCOPE__/assistant";
import { db } from "@/db";
import { createTRPCRouter, requireStaff } from "../trpc";

/**
 * THIS SITE'S OWN assistant's editable brain, staff side (/admin/assistant):
 * its personality sections, house rules, glossary and change log — the
 * assistant this site's staff talk to at /admin/assistant/chat. It is
 * `ASSISTANT_PLATFORM` ("*"), never a company's: each company edits its own
 * assistant's profile, answers, rules and words at /app/assistant, over the
 * package's own handler (src/server/assistant.ts), and nothing here can reach
 * them.
 *
 * Gated on `staff.assistant.manage` (one key per job), not the shell's
 * staff.dashboard.view. All correctness — budgets, the stale-publish refusal,
 * the required-phrase guard, the referenced-section rule, the change log —
 * lives in @__SCOPE_NAME__/assistant's functions, so this router is a thin
 * gate over them and a fix ships by upgrading the package.
 */
const SITE = ASSISTANT_PLATFORM;

export const assistantRouter = createTRPCRouter({
  /** Sections, seeding the five guardrail defaults on first read. */
  sections: requireStaff("staff.assistant.manage")
    .meta({ scope: "staff" })
    .query(async () => {
      await seedDefaultSections(db, SITE);
      return listSections(db, SITE);
    }),

  versions: requireStaff("staff.assistant.manage")
    .meta({ scope: "staff" })
    .input(z.object({ sectionId: z.string() }))
    .query(({ input }) => listSectionVersions(db, SITE, input.sectionId)),

  createSection: requireStaff("staff.assistant.manage")
    .meta({ scope: "staff" })
    .input(createSectionSchema)
    .mutation(({ input, ctx }) => createSection(db, SITE, input, ctx.principal.userId)),

  publishSection: requireStaff("staff.assistant.manage")
    .meta({ scope: "staff" })
    .input(publishSectionSchema)
    .mutation(({ input, ctx }) => publishSection(db, SITE, input, ctx.principal.userId)),

  rollbackSection: requireStaff("staff.assistant.manage")
    .meta({ scope: "staff" })
    .input(z.object({ sectionId: z.string(), toVersion: z.number().int().min(1) }))
    .mutation(({ input, ctx }) => rollbackSection(db, SITE, input, ctx.principal.userId)),

  deactivateSection: requireStaff("staff.assistant.manage")
    .meta({ scope: "staff" })
    .input(z.object({ sectionId: z.string() }))
    .mutation(({ input, ctx }) => deactivateSection(db, SITE, input.sectionId, ctx.principal.userId)),

  /** The change log — who changed the site's assistant, when, and why. Newest first. */
  changeLog: requireStaff("staff.assistant.manage")
    .meta({ scope: "staff" })
    .input(z.object({ limit: z.number().int().min(1).max(200).default(50) }).optional())
    .query(({ input }) => listChangeLog(db, SITE, input?.limit ?? 50)),

  // --- House rules: what the site's assistant must always (or never) do,
  // optionally tied to one of its sections.
  tenantRules: requireStaff("staff.assistant.manage")
    .meta({ scope: "staff" })
    .query(() => listTenantRules(db, SITE)),

  createTenantRule: requireStaff("staff.assistant.manage")
    .meta({ scope: "staff" })
    .input(
      z.object({
        sectionKey: z.string().max(60).nullish(),
        label: z.string().min(1).max(80),
        instruction: z.string().min(1).max(2000),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      // Through the package, so the rule's token budget is enforced and the
      // change log gets its line.
      const out = await createTenantRule(db, { tenantId: SITE, ...input }, ctx.principal.userId);
      return "id" in out ? { id: out.id } : { error: "That rule is too long for the assistant to keep in mind. Shorten it." };
    }),

  deactivateTenantRule: requireStaff("staff.assistant.manage")
    .meta({ scope: "staff" })
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input, ctx }) => ({ ok: await deactivateTenantRule(db, SITE, input.id, ctx.principal.userId) })),

  // --- Glossary.
  glossary: requireStaff("staff.assistant.manage")
    .meta({ scope: "staff" })
    .query(() => listGlossary(db, SITE)),

  createGlossaryTerm: requireStaff("staff.assistant.manage")
    .meta({ scope: "staff" })
    .input(createGlossaryTermSchema)
    .mutation(({ input, ctx }) => createGlossaryTerm(db, SITE, input, ctx.principal.userId)),

  deactivateGlossaryTerm: requireStaff("staff.assistant.manage")
    .meta({ scope: "staff" })
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input, ctx }) => ({ ok: await deactivateGlossaryTerm(db, SITE, input.id, ctx.principal.userId) })),
});
