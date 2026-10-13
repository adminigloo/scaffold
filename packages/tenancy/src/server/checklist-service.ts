import { sql } from "drizzle-orm";
import type { ChecklistContext, SetupChecklistItem } from "../checklist.js";
import type { TenantSetupState } from "../schema.js";
import type { ChecklistItemWire, ChecklistWire } from "../wire.js";
import { requireActor, requireLive, type Ctx } from "./context.js";
import { lockCompany, num, q, readCompany, type CompanyRow } from "./db.js";
import type { TenancyDb } from "./types.js";

/**
 * The setup checklist items Tenancy 1 ships (contract 6.7). Their copy says
 * only what is true in this release (review T1-10): the logo and colour show
 * on the company's public page and in the header the team sees; customer
 * emails aren't branded yet, so the item doesn't promise them.
 */
export function tenancyChecklistItems(hrefs: { readonly companySettings?: string; readonly team?: string } = {}): readonly SetupChecklistItem[] {
  const settings = hrefs.companySettings ?? "/settings/company";
  const team = hrefs.team ?? "/settings/team";
  return [
    {
      key: "company.details",
      order: 10,
      permission: "tenant.edit",
      title: "Add your business details",
      description: "Your time zone, and the email or phone customers can reach you at.",
      actionLabel: "Add details",
      href: `${settings}#details`,
      isDone: (c) => {
        const company = (c.settings["company"] ?? {}) as Record<string, unknown>;
        return company["timeZone"] != null && (company["contactEmail"] != null || company["contactPhone"] != null);
      },
    },
    {
      key: "team.invite",
      order: 20,
      permission: "members.invite",
      title: "Invite your team",
      description: "Add the people who work with you. Each gets an email with a link to join.",
      actionLabel: "Invite people",
      href: team,
      isDone: (c) => c.counts.activeMembers >= 2 || c.counts.invitationsEverSent >= 1,
    },
    {
      key: "company.branding",
      order: 30,
      permission: "tenant.edit",
      title: "Add your logo and colour",
      description: "They show on your public page and in the header your team sees.",
      actionLabel: "Add branding",
      href: `${settings}#branding`,
      isDone: (c) => c.company.logoUrl !== null || c.company.brandColor !== null,
    },
  ];
}

/**
 * Is the list hidden? Only when it was hidden AND every item visible now was
 * on the list at that moment (review T1-13): an item a package adds later
 * brings the list back, instead of staying hidden for that company for good.
 */
function isHidden(state: TenantSetupState, visibleKeys: readonly string[]): boolean {
  if (!state.hiddenAt) return false;
  if (!state.hiddenKeys) return true;
  return visibleKeys.every((k) => state.hiddenKeys!.includes(k));
}

async function buildView(ctx: Ctx, db: TenancyDb, company: CompanyRow, can: ReadonlySet<string>): Promise<ChecklistWire> {
  const counts = await q(
    db,
    sql`/* adminigloo:tenancy/checklist-counts */
      select
        (select count(*) from tenant_members where tenant_id = ${company.id} and status = 'active') as active_members,
        (select count(*) from tenant_invitations where tenant_id = ${company.id}) as invitations_sent`,
  );
  const { values, problems } = ctx.settings.parse(company.settings);
  for (const p of problems) ctx.report(new Error(p.message), "settings.parse");
  const context: ChecklistContext = {
    db,
    tenantId: company.id,
    company: {
      name: company.name,
      slug: company.slug,
      logoUrl: company.branding.logoUrl ?? null,
      brandColor: company.branding.brandColor ?? null,
    },
    settings: values as Readonly<Record<string, unknown>>,
    counts: {
      activeMembers: num(counts[0]?.["active_members"]),
      invitationsEverSent: num(counts[0]?.["invitations_sent"]),
    },
  };
  const dismissed = new Set(company.setupState.dismissed ?? []);
  const items: ChecklistItemWire[] = [];
  for (const item of ctx.checklist.items) {
    if (!can.has(item.permission ?? "tenant.edit")) continue;
    let done = false;
    try {
      done = Boolean(await item.isDone(context));
    } catch (error) {
      // One broken predicate must not take the list down: that item reads as
      // not done, the error is reported, the rest still render.
      ctx.report(error, `checklist.${item.key}`);
    }
    items.push({
      key: item.key,
      title: item.title,
      description: item.description,
      actionLabel: item.actionLabel,
      href: item.href,
      done,
      dismissed: dismissed.has(item.key),
    });
  }
  const done = items.filter((i) => i.done).length;
  return {
    items,
    done,
    total: items.length,
    complete: items.every((i) => i.done || i.dismissed),
    hidden: isHidden(company.setupState, items.map((i) => i.key)),
  };
}

export async function getChecklist(ctx: Ctx, input: { readonly actorUserId: string; readonly tenantId: string }): Promise<ChecklistWire> {
  const facts = await requireActor(ctx, ctx.db, { userId: input.actorUserId, tenantId: input.tenantId }, { permission: "tenant.view" });
  const company = requireLive(ctx, await readCompany(ctx.db, input.tenantId));
  return buildView(ctx, ctx.db, company, facts.can);
}

/**
 * The housekeeping writes (tenant.edit): skip one item, un-skip it (the
 * "Undo" after a mis-tap, review T1-13), hide the list, show it again. Locked
 * like every other company write; not audited — they change nobody's access.
 */
export async function changeChecklist(
  ctx: Ctx,
  input: { readonly actorUserId: string; readonly tenantId: string },
  change: { readonly op: "dismiss" | "restore"; readonly key: string } | { readonly op: "hide" | "show" },
): Promise<ChecklistWire> {
  return ctx.db.transaction(async (raw) => {
    const tx = raw as unknown as TenancyDb;
    const company = requireLive(ctx, await lockCompany(tx, input.tenantId));
    const facts = await requireActor(ctx, tx, { userId: input.actorUserId, tenantId: input.tenantId }, { permission: "tenant.edit" });
    // The caller first, the item second: a stranger hears "not yours", never
    // whether an item exists (the two-company matrix; found when a
    // single-business project shipped an empty checklist, review R2 TB2-07).
    if ((change.op === "dismiss" || change.op === "restore") && !ctx.checklist.items.some((i) => i.key === change.key)) {
      throw ctx.fail("not_found");
    }
    const state = company.setupState;
    let next: TenantSetupState;
    switch (change.op) {
      case "dismiss":
        next = { ...state, dismissed: [...new Set([...(state.dismissed ?? []), change.key])] };
        break;
      case "restore":
        next = { ...state, dismissed: (state.dismissed ?? []).filter((k) => k !== change.key) };
        break;
      case "hide":
        next = { ...state, hiddenAt: ctx.now().toISOString(), hiddenKeys: ctx.checklist.items.map((i) => i.key) };
        break;
      case "show": {
        const { hiddenAt: _h, hiddenKeys: _k, ...rest } = state;
        next = rest;
        break;
      }
    }
    await tx.execute(sql`/* adminigloo:tenancy/update-setup-state */
      update tenants set setup_state = ${JSON.stringify(next)}::jsonb, updated_at = now() where id = ${company.id}`);
    return buildView(ctx, tx, { ...company, setupState: next }, facts.can);
  });
}
