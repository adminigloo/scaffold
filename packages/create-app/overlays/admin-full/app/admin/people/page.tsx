import { desc } from "drizzle-orm";
import { users } from "__SCOPE__/auth/schema";
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

export default async function PeoplePage() {
  const principal = await currentPrincipal();
  const can = principal ? await loadStaffPermissions({ principal }) : null;
  if (!can?.can("staff.people.view")) {
    return (
      <>
        <PageHeader title="People" />
        <Notice tone="warn">You do not have permission to view people.</Notice>
      </>
    );
  }

  const rows = await db.select().from(users).orderBy(desc(users.createdAt)).limit(50);

  return (
    <>
      <PageHeader
        title="People"
        description="Everyone the app has seen, newest first. A row is the local mirror of a Clerk identity — the source of truth for who they are stays with Clerk; what they may do lives here."
      />

      {rows.length === 0 ? (
        <EmptyState title="Nobody has signed in yet">
          A row appears the first time someone completes sign-in: the app mirrors
          the Clerk user into the local users table on that first request, rather
          than waiting for the webhook, because a webhook cannot reach localhost.
        </EmptyState>
      ) : (
        <Card>
          <Table>
            <THead>
              <TR>
                <TH>Name</TH>
                <TH>Email</TH>
                <TH>Status</TH>
              </TR>
            </THead>
            <TBody>
              {rows.map((row) => (
                <TR key={row.id}>
                  <TD className="text-ink">{row.displayName ?? "—"}</TD>
                  <TD className="text-ink-muted">{row.email ?? "—"}</TD>
                  <TD>
                    {/* Soft-deleted rows stay in the list on purpose. They are
                        why a name can appear in the audit log and nowhere else,
                        and hiding them makes that look like data loss. */}
                    <Badge tone={row.deletedAt ? "danger" : "neutral"}>
                      {row.deletedAt ? "Deleted" : "Active"}
                    </Badge>
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
