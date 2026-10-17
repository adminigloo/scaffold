import { z } from "zod";
import { RULE_KINDS, type RuleKind } from "./core/labels.js";

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
