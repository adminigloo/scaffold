import { and, eq } from "drizzle-orm";
import { schedulingResources, schedulingSettings } from "./schema.js";
import type { SchedulingDb } from "./types.js";

/**
 * Scheduling's items on the company setup checklist (Tenancy 2a, 6.6).
 * Structural (D4): the same shape as tenancy's `SetupChecklistItem`, declared
 * here so scheduling never imports tenancy; `defineSetupChecklist` accepts it
 * as is. Each `isDone` is one `select … limit 1`, filtered by the tenant.
 */
export interface SchedulingChecklistItem {
  readonly key: string;
  readonly title: string;
  readonly description: string;
  readonly actionLabel: string;
  readonly href: string;
  readonly order: number;
  readonly permission?: string;
  isDone(ctx: { readonly db: unknown; readonly tenantId: string }): Promise<boolean>;
}

export function schedulingChecklistItems(hrefs: { readonly booking: string; readonly crews: string }): readonly SchedulingChecklistItem[] {
  return [
    {
      key: "schedule.booking",
      order: 40,
      permission: "schedule.resources.manage",
      title: "Choose what customers can book",
      description: "Your services and how long each takes. Then switch online booking on.",
      actionLabel: "Set up booking",
      href: hrefs.booking,
      // A company starts with online booking OFF (its first-time setup): done
      // once the owner has looked at the services and switched it on.
      isDone: async (ctx) => {
        const db = ctx.db as SchedulingDb;
        const [row] = await db
          .select({ id: schedulingSettings.tenantId })
          .from(schedulingSettings)
          .where(and(eq(schedulingSettings.tenantId, ctx.tenantId), eq(schedulingSettings.publicBookingEnabled, true)))
          .limit(1);
        return row !== undefined;
      },
    },
    {
      key: "schedule.crews",
      order: 50,
      permission: "schedule.resources.manage",
      title: "Add your crew and their hours",
      description: "Customers can only book times when a crew is working.",
      actionLabel: "Add a crew",
      href: hrefs.crews,
      isDone: async (ctx) => {
        const db = ctx.db as SchedulingDb;
        const [row] = await db
          .select({ id: schedulingResources.id })
          .from(schedulingResources)
          .where(
            and(
              eq(schedulingResources.tenantId, ctx.tenantId),
              eq(schedulingResources.isActive, true),
              eq(schedulingResources.hoursConfigured, true),
            ),
          )
          .limit(1);
        return row !== undefined;
      },
    },
  ];
}
