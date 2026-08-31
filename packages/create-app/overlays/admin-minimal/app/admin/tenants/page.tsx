import { desc } from "drizzle-orm";
import { tenants } from "__SCOPE__/tenancy/schema";
import { db } from "@/db";
import { currentPrincipal } from "@/server/auth";
import { loadStaffPermissions } from "@/server/permissions";
import {
  Badge,
  Card,
  EmptyState,
  Notice,
  PageHeader,
  Table,
  TBody,
  TD,
  TH,
  THead,
  TR,
} from "@/components/ui";

/**
 * Read-only list of customer organisations.
 *
 * Gated again here rather than relying on the layout: a page can be rendered by
 * a route that does not sit under this layout, and "the parent checked" is not
 * a property the type system enforces.
 */
export default async function TenantsPage() {
  const principal = await currentPrincipal();
  const can = principal ? await loadStaffPermissions({ principal }) : null;
  if (!can?.can("staff.tenants.view")) {
    return (
      <>
        <PageHeader title="__TENANT_LABEL_PLURAL__" />
        <Notice tone="warn">
          You do not have permission to view __TENANT_LABEL_PLURAL__.
        </Notice>
      </>
    );
  }

  const rows = await db
    .select()
    .from(tenants)
    .orderBy(desc(tenants.createdAt))
    .limit(50);

  return (
    <>
      <PageHeader
        title="__TENANT_LABEL_PLURAL__"
        description="The 50 most recently created. Every tenant-scoped query in the app is filtered by one of these ids."
      />

      {rows.length === 0 ? (
        <EmptyState title="No __TENANT_LABEL_PLURAL_LOWER__ yet">
          One is created the first time somebody signs in — every new user gets a
          personal workspace — and named ones are created by whatever onboarding
          you build. Run <code className="font-mono">pnpm db:seed:demo</code> to
          put sample rows here.
        </EmptyState>
      ) : (
        <Card>
          <Table>
            <THead>
              <TR>
                <TH>Name</TH>
                <TH>Slug</TH>
                <TH>Kind</TH>
                <TH>Created</TH>
              </TR>
            </THead>
            <TBody>
              {rows.map((row) => (
                <TR key={row.id}>
                  <TD className="font-medium text-ink">{row.name}</TD>
                  <TD className="font-mono text-xs text-ink-muted">{row.slug}</TD>
                  <TD>
                    {/* Personal workspaces are auto-created for every signed-in
                        user and will outnumber real customers by an order of
                        magnitude. Marking the kind is what stops someone
                        reading this list as a customer count. */}
                    <Badge tone={row.kind === "personal" ? "neutral" : "accent"}>
                      {row.kind}
                    </Badge>
                  </TD>
                  <TD className="whitespace-nowrap text-ink-muted">
                    {row.createdAt?.toISOString().slice(0, 10)}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </Card>
      )}
    </>
  );
}
