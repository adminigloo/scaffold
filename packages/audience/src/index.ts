import { verifyLicense, type LicenseMode } from "@adminigloo/license";
import { z } from "zod";
import { createAudienceCore, type CreateAudienceOptions } from "./core/audience.js";
import { RULE_KINDS, type RuleKind, type SubjectKind } from "./core/labels.js";
import type { AudienceUser } from "./core/types.js";
import {
  countedSubjectSql,
  countedVisitorSql,
  type DrizzleColumnInput,
  type DrizzleCountedOptions,
  type DrizzleCountedVisitorOptions,
} from "./drizzle-sql.js";

/**
 * @adminigloo/audience — keep staff, testers, automation and a named list of
 * people out of an app's numbers, and clean the numbers already polluted.
 *
 * This root entry is `./core` (rules, classifier, `createAudience` over any
 * store) plus what a Drizzle + Postgres app wants: the default store
 * (`createDrizzleAudienceStore`), the anti-join as Drizzle `sql`
 * (`countedVisitorSql`, `countedSubjectSql`), a zod schema for the add-rule
 * form, and the AdminIgloo license gate. Tables live in `./schema`, the admin
 * components in `./ui`, the source guard in `./testing`.
 */

export * from "./core.js";
export { createDrizzleAudienceStore } from "./drizzle-store.js";
export type { AudienceDb } from "./drizzle-store.js";
export { countedSubjectSql, countedVisitorSql, toDrizzleSql } from "./drizzle-sql.js";
export type { DrizzleColumnInput, DrizzleCountedOptions, DrizzleCountedVisitorOptions } from "./drizzle-sql.js";

export interface AudienceLicenseOptions {
  /** ADMINIGLOO_LICENSE_KEY */
  readonly key?: string | undefined;
  /** ADMINIGLOO_LICENSE_PUBLIC_KEY */
  readonly publicKey?: string | undefined;
  /** ADMINIGLOO_LICENSE_MODE — "off" (default) never denies. */
  readonly mode?: LicenseMode | undefined;
}

export interface CreateDrizzleAudienceOptions<TUser extends AudienceUser = AudienceUser>
  extends Omit<CreateAudienceOptions<TUser>, "licenseGate"> {
  /**
   * The AdminIgloo license gate, feature "audience". It guards the CLEANING
   * work (preview, addRule and markVisitor, apply, mark, backfill, maintain)
   * and never intake, reports, remove or unmark: an expired license must not
   * start counting staff again, and must not stop anyone undoing a rule.
   */
  license?: AudienceLicenseOptions;
}

type CountedExtra = Omit<DrizzleCountedOptions, "tenantId" | "marksTable">;
type CountedVisitorExtra = Omit<DrizzleCountedVisitorOptions, "tenantId" | "marksTable">;

/**
 * The one object an app holds. Same as `./core`'s `createAudience`, plus the
 * counted fragments as Drizzle `sql`, bound to this instance's tenant and
 * marks table.
 */
export function createAudience<TUser extends AudienceUser = AudienceUser>(options: CreateDrizzleAudienceOptions<TUser>) {
  const { license, ...rest } = options;
  const core = createAudienceCore<TUser>({
    ...rest,
    ...(license ? { licenseGate: () => verifyLicense({ feature: "audience", ...license }) } : {}),
  });
  return {
    ...core,
    /**
     * `NOT EXISTS (… visitor or session mark …)` as Drizzle sql — true for rows
     * that COUNT. `extra` must name `time` and `session` (`{ time: "s.created_at",
     * session: "s.id" }`), or set either to null on purpose.
     */
    countedVisitorSql: (visitorColumn: DrizzleColumnInput, extra: CountedVisitorExtra) =>
      countedVisitorSql(visitorColumn, { tenantId: core.tenantId, marksTable: core.marksTable, ...extra }),
    /** The same for an org / event / order / user id column. */
    countedSubjectSql: (kind: SubjectKind, subjectColumn: DrizzleColumnInput, extra: CountedExtra = {}) =>
      countedSubjectSql(kind, subjectColumn, { tenantId: core.tenantId, marksTable: core.marksTable, ...extra }),
  };
}

export type Audience<TUser extends AudienceUser = AudienceUser> = ReturnType<typeof createAudience<TUser>>;

/**
 * The add-rule form's input, for a server action or a tRPC procedure — shape
 * only. `addRule` and `preview` normalise and validate the VALUE per kind
 * (an email must be one, a CIDR must parse) and throw `AudienceError`
 * ("invalid_rule") with a sentence for the form.
 */
const draftSchema = z.object({
  kind: z.enum(RULE_KINDS),
  value: z.string().trim().min(1).max(320),
  reasonLabel: z.string().trim().max(120).nullable().optional(),
  note: z.string().trim().max(500).nullable().optional(),
  appliesFrom: z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}(T.*)?$/, "Use a date like 2026-07-01.")
    .nullable()
    .optional()
    .or(z.literal("")),
});

/** What the add-rule form sends, after `ruleDraftSchema` has checked it. */
export interface RuleDraftInput {
  kind: RuleKind;
  value: string;
  reasonLabel?: string | null | undefined;
  note?: string | null | undefined;
  appliesFrom?: string | null | undefined;
}

export interface RuleDraftIssue {
  path: ReadonlyArray<PropertyKey>;
  message: string;
}

export type RuleDraftParseResult =
  | { success: true; data: RuleDraftInput }
  | { success: false; error: { message: string; issues: ReadonlyArray<RuleDraftIssue> } };

/**
 * The schema's PUBLIC type names no zod type on purpose. The package builds
 * against zod 4, whose types (`z.ZodEnum<{…}>`, `z.core`) do not exist in
 * zod 3; an app on zod 3 (Riddler Go is on ^3.25) would get type errors from
 * the published .d.ts, or — with skipLibCheck — a `kind` typed as anything.
 * The runtime works on both.
 */
export interface RuleDraftSchema {
  parse(input: unknown): RuleDraftInput;
  safeParse(input: unknown): RuleDraftParseResult;
}

export const ruleDraftSchema: RuleDraftSchema = draftSchema;
