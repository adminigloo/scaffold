import { and, asc, eq } from "drizzle-orm";
import type { ReactNode } from "react";
import { users } from "__SCOPE__/auth/schema";
import { tenantMembers } from "__SCOPE__/tenancy/schema";
import { principalRole, roleTemplate } from "__SCOPE__/permissions/schema";
import { db } from "@/db";
import { currentPrincipal } from "@/server/auth";
import { loadTenantPermissions } from "@/server/permissions";
import { currentTenantFor } from "@/server/tenant";
import { PendingInvitations } from "@/components/invitations/PendingInvitations";
import {
  Badge,
  Card,
  CardHeader,
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
 * Who is in this __TENANT_LABEL_LOWER__, and who has been asked to join.
 *
 * An application with __TENANT_LABEL_PLURAL__ in it that cannot add a second
 * person to one of them is missing the loop the whole tenancy layer exists for,
 * and until this page there was nowhere to do it: `tenant_members` gained rows
 * only from the personal workspace minted at first sign-in, and
 * `tenant_invitations` had a table, a token generator and no caller. This is
 * the screen that closes it.
 *
 * A SERVER COMPONENT that reads the roster directly, matching the admin pages.
 * The permission is checked here rather than inherited from a layout — a page
 * can be rendered by a route that does not sit under the layout you assumed,
 * and "the parent checked" is not a property the type system enforces. The
 * mutations do NOT go direct: inviting, resending and revoking all run through
 * the tRPC router, where the rung, the audit write and the mail send live
 * together, because a mutation written into a page is a mutation the scope
 * audit cannot see.
 *
 * `members.view` gates the roster and `members.invite` gates the invitation
 * panel, and they are two different keys on purpose. Everyone inside one
 * __TENANT_LABEL_LOWER__ can see who else is in it — hiding that protects nothing
 * and breaks every "who do I ask" flow. A pending invitation is a
 * different fact: it is the email address of somebody who is not a member yet,
 * disclosed to people who cannot act on it, so it rides with the permission to
 * send one.
 */
export const dynamic = "force-dynamic";

export default async function MembersPage() {
  const principal = await currentPrincipal();
  if (!principal) {
    return (
      <Shell>
        <Notice tone="info" title="Sign in to see this">
          Members belong to one __TENANT_LABEL_LOWER__, and which one depends
          on who is asking &mdash; so there is nothing to show until we know
          that.
        </Notice>
      </Shell>
    );
  }

  const tenant = await currentTenantFor(principal.userId);
  if (!tenant) {
    return (
      <Shell>
        <Notice tone="warn" title="You are not a member of anything">
          Every account gets a personal workspace on first sign-in, so this is
          usually a suspended membership rather than a missing one. Whoever
          administers your __TENANT_LABEL_LOWER__ can restore it.
        </Notice>
      </Shell>
    );
  }

  const can = await loadTenantPermissions({ principal, tenantId: tenant.id });
  if (!can?.can("members.view")) {
    return (
      <Shell name={tenant.name}>
        <Notice tone="warn" title="You cannot view this member list">
          Ask an administrator of {tenant.name} to grant you{" "}
          <code className="font-mono">members.view</code>.
        </Notice>
      </Shell>
    );
  }

  const roster = await db
    .select({
      userId: tenantMembers.userId,
      status: tenantMembers.status,
      joinedAt: tenantMembers.createdAt,
      email: users.email,
      displayName: users.displayName,
      // LEFT JOIN through to the template, because membership and role are
      // deliberately separate tables: `tenant_members` answers "is this person
      // in the __TENANT_LABEL_LOWER__" and `principal_role` answers "what may
      // they do". A member with no role row is a real state — it is what an
      // invitation accepted against a template that has since been deleted
      // leaves behind — and it has to render as "no role" rather than vanish.
      roleKey: roleTemplate.key,
      roleName: roleTemplate.name,
    })
    .from(tenantMembers)
    .leftJoin(users, eq(users.id, tenantMembers.userId))
    .leftJoin(
      principalRole,
      and(
        eq(principalRole.principalId, tenantMembers.userId),
        eq(principalRole.scope, "tenant"),
        eq(principalRole.tenantId, tenant.id),
      ),
    )
    .leftJoin(roleTemplate, eq(roleTemplate.id, principalRole.templateId))
    .where(eq(tenantMembers.tenantId, tenant.id))
    .orderBy(asc(tenantMembers.createdAt), asc(tenantMembers.userId));

  return (
    <Shell name={tenant.name}>
      <Card className="mb-6">
        <CardHeader
          title="Members"
          hint={`${roster.length} ${roster.length === 1 ? "person" : "people"} in ${tenant.name}`}
        />
        <Table>
          <THead>
            <TR>
              <TH>Person</TH>
              <TH>Role</TH>
              <TH>Status</TH>
              <TH>Joined</TH>
            </TR>
          </THead>
          <TBody>
            {roster.map((member) => (
              <TR key={member.userId}>
                <TD>
                  <span className="font-medium text-ink">
                    {member.displayName ?? member.email ?? "Unnamed"}
                  </span>
                  {member.displayName && member.email && (
                    <span className="block text-xs text-ink-muted">{member.email}</span>
                  )}
                </TD>
                <TD className="text-ink-muted">{member.roleName ?? "No role"}</TD>
                <TD>
                  <Badge tone={member.status === "active" ? "neutral" : "warn"}>
                    {member.status}
                  </Badge>
                </TD>
                <TD className="whitespace-nowrap text-ink-muted">
                  {member.joinedAt?.toISOString().slice(0, 10)}
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      </Card>

      {/* The invitation panel is a list rendered from what the server granted,
          not a branch on a feature flag: `canInvite` is false for a viewer and
          the panel renders its read-only self. It is a client component because
          inviting, resending and revoking are mutations that have to reflect
          back into the list without a full page load. */}
      <PendingInvitations
        tenantId={tenant.id}
        tenantName={tenant.name}
        canInvite={can.can("members.invite")}
      />
    </Shell>
  );
}

function Shell({ name, children }: { readonly name?: string; readonly children: ReactNode }) {
  return (
    <main className="mx-auto max-w-3xl px-6 py-12">
      <PageHeader
        title="Members"
        description={
          name
            ? `Who belongs to ${name}, and who has been invited.`
            : "Who belongs to your __TENANT_LABEL_LOWER__, and who has been invited."
        }
      />
      {children}
    </main>
  );
}
