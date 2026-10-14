import { sql } from "drizzle-orm";
import { parseFragment, type TenantSettingsFragment } from "../settings.js";
import type { SettingsFieldWire, SettingsSectionWire, SettingsWire } from "../wire.js";
import { requireActor, requireLive, type Ctx } from "./context.js";
import { lockCompany, readCompany } from "./db.js";
import type { RequestFacts, TenancyDb } from "./types.js";

type Primitive = string | number | boolean | null;

function primitive(value: unknown): Primitive {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  return JSON.stringify(value);
}

function fieldWire(fragment: TenantSettingsFragment): SettingsFieldWire[] {
  return fragment.fields.map((f) => ({
    key: f.key,
    label: f.label,
    help: f.help ?? null,
    kind: f.kind,
    options: f.options ? f.options.map((o) => ({ value: o.value, label: o.label })) : null,
    placeholder: f.placeholder ?? null,
    autoComplete: f.autoComplete ?? null,
    width: f.width ?? "full",
    required: f.required ?? false,
    min: f.min ?? null,
    max: f.max ?? null,
    step: f.step ?? null,
  }));
}

function sectionWire(fragment: TenantSettingsFragment, value: Record<string, unknown>, canEdit: boolean): SettingsSectionWire {
  const values: Record<string, Primitive> = {};
  for (const field of fragment.fields) values[field.key] = primitive(value[field.key]);
  return {
    key: fragment.key,
    label: fragment.label,
    description: fragment.description ?? null,
    fields: fieldWire(fragment),
    values,
    canEdit,
  };
}

function storedSection(stored: unknown, key: string): unknown {
  return typeof stored === "object" && stored !== null ? (stored as Record<string, unknown>)[key] : undefined;
}

/**
 * The settings sections the caller may SEE (each fragment's viewPermission),
 * with `canEdit` from its editPermission. None at all → `forbidden`. A stored
 * value that no longer parses is shown as its default and REPORTED, never
 * thrown: one bad save must not take the settings page down (D13).
 */
export async function getSettings(ctx: Ctx, input: { readonly actorUserId: string; readonly tenantId: string }): Promise<SettingsWire> {
  const facts = await requireActor(ctx, ctx.db, { userId: input.actorUserId, tenantId: input.tenantId });
  const company = requireLive(ctx, await readCompany(ctx.db, input.tenantId));
  const sections: SettingsSectionWire[] = [];
  for (const fragment of ctx.settings.fragments) {
    if (!facts.can.has(fragment.viewPermission ?? "tenant.view")) continue;
    const { value, problem } = parseFragment(fragment, storedSection(company.settings, fragment.key));
    if (problem) ctx.report(new Error(problem), "settings.parse");
    sections.push(sectionWire(fragment, value, facts.can.has(fragment.editPermission ?? "tenant.edit")));
  }
  if (sections.length === 0) throw ctx.fail("forbidden");
  return { sections };
}

function zodIssues(error: { issues: readonly { path: readonly PropertyKey[]; message: string }[] }) {
  return error.issues.map((issue) => ({
    path: issue.path.filter((p): p is string | number => typeof p === "string" || typeof p === "number"),
    message: issue.message,
  }));
}

/**
 * Save one section (its editPermission). Validated with the fragment's own
 * schema (unknown keys stripped), written with `jsonb_set` so only this
 * section's key changes, audited with WHICH fields changed and never their
 * values.
 */
export async function updateSettings(
  ctx: Ctx,
  input: {
    readonly actorUserId: string;
    readonly tenantId: string;
    readonly section: string;
    readonly values: unknown;
    readonly request?: RequestFacts;
  },
): Promise<SettingsSectionWire> {
  let saved: { tenantId: string; section: string; changed: string[] } | null = null;
  const section = await ctx.db.transaction(async (raw) => {
    const tx = raw as unknown as TenancyDb;
    const company = requireLive(ctx, await lockCompany(tx, input.tenantId));
    const facts = await requireActor(ctx, tx, { userId: input.actorUserId, tenantId: input.tenantId });
    // The caller first, then the section: a stranger hears "not yours" (review R2).
    const fragment = ctx.settings.get(input.section);
    if (!fragment) throw ctx.fail("not_found");
    if (!facts.can.has(fragment.editPermission ?? "tenant.edit")) throw ctx.fail("forbidden");

    const parsed = fragment.schema.safeParse(input.values ?? {});
    if (!parsed.success) throw ctx.fail("invalid", { issues: zodIssues(parsed.error) });
    const next = parsed.data as Record<string, unknown>;
    const before = parseFragment(fragment, storedSection(company.settings, fragment.key)).value;
    const changed = Object.keys(next).filter((k) => JSON.stringify(next[k] ?? null) !== JSON.stringify(before[k] ?? null));

    await tx.execute(sql`/* adminigloo:tenancy/update-settings */
      update tenants
      set settings = jsonb_set(coalesce(settings, '{}'::jsonb), array[${fragment.key}]::text[], ${JSON.stringify(next)}::jsonb, true),
          updated_at = now()
      where id = ${company.id}`);
    if (changed.length > 0) {
      await ctx.audit(tx, {
        action: "company.settings.updated",
        actorUserId: input.actorUserId,
        scope: "tenant",
        tenantId: company.id,
        resourceType: "tenant",
        resourceId: company.id,
        metadata: { section: fragment.key, changed },
        request: input.request ?? null,
      });
      saved = { tenantId: company.id, section: fragment.key, changed };
    }
    return sectionWire(fragment, next, true);
  });
  // Tenancy 2a: after commit, with the same `changed` list as the audit row.
  // Scheduling converges its zone on section "company" + "timeZone" (D5).
  const done = saved as { tenantId: string; section: string; changed: string[] } | null;
  if (done) ctx.emit({ type: "company.settings.updated", tenantId: done.tenantId, section: done.section, changed: done.changed, by: input.actorUserId });
  return section;
}

/** Typed values for other packages' server code (Tenancy 2): NO permission check. */
export async function readSettings(ctx: Ctx, tenantId: string): Promise<Readonly<Record<string, Readonly<Record<string, unknown>>>>> {
  const company = await readCompany(ctx.db, tenantId);
  const { values, problems } = ctx.settings.parse(company?.settings ?? {});
  for (const p of problems) ctx.report(new Error(p.message), "settings.parse");
  return values as Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}
