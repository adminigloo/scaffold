import { currentPrincipal } from "@/server/auth";
import { loadStaffPermissions } from "@/server/permissions";
import { Card, CardBody, CardHeader, Notice, PageHeader } from "@/components/ui";

/**
 * Who the app thinks you are, and every staff key it has decided you hold.
 *
 * THIS USED TO BE THE DASHBOARD, and that was the wrong place for it. Nobody's
 * first admin screen should be a list of their own permission keys: it is the
 * one screen in the panel that tells an operator nothing about their business,
 * and it occupied the position that says "this is what matters here".
 *
 * It is genuinely useful and it is kept for the question it answers, which
 * comes up constantly and has no other answer: someone says a page is missing
 * or a button refuses them, and the resolved permission SET — not the role
 * template, not what the template is supposed to grant — is the fact that
 * settles it. Overrides, seals and template edits all collapse into this list,
 * which is what `loadStaffPermissions` actually returns and therefore exactly
 * what every `requireStaff` on the server is comparing against.
 *
 * It shows the STAFF scope only. Tenant permissions are resolved per tenant and
 * belong on the person's row in the customer __TENANT_LABEL_LOWER__, where the
 * checklist can show inherit, allow, deny and sealed against a template — four
 * states this page has no way to distinguish, because by the time a key reaches
 * here the answer is already yes or no.
 */
/**
 * Never prerendered. The whole page is one person's resolved permission set, and
 * a build with no Clerk keys would otherwise bake "you hold no staff role" into
 * static HTML and serve it to everybody after the keys arrive.
 */
export const dynamic = "force-dynamic";

export default async function AccessPage() {
  const principal = await currentPrincipal();
  const can = principal ? await loadStaffPermissions({ principal }) : null;

  // Gated here rather than relying on the layout, like every other page in this
  // shell: a route can be rendered outside the layout that checked, and "the
  // parent checked" is not something the type system enforces.
  if (!can) {
    return (
      <>
        <PageHeader title="Your access" />
        <Notice tone="warn">
          You are signed in but hold no staff role, so there is nothing to list.
        </Notice>
      </>
    );
  }

  const held = can.toArray();

  return (
    <>
      <PageHeader
        title="Your access"
        description="What the server resolved for this session. Every requireStaff check in the app is comparing against exactly this list."
      />

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader title="Signed in as" />
          <CardBody>
            <p className="text-sm text-ink">{principal?.email ?? "unknown"}</p>
            <p className="mt-1 font-mono text-xs text-ink-muted">
              {principal?.userId ?? "no principal"}
            </p>
            {/* The local id, not the Clerk one, and the distinction matters
                during support: every row this app writes — audit entries,
                orders, overrides — references the id below, while the Clerk
                dashboard knows the other one. */}
            <p className="mt-2 text-xs text-ink-muted">
              This is the local <code className="font-mono">users.id</code>, which is
              what audit rows and permission overrides reference.
            </p>
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Staff permissions" hint={`${held.length} held`} />
          <CardBody>
            {held.length === 0 ? (
              <p className="text-sm text-ink-muted">
                None yet. A staff role with no permissions can reach this page
                and nothing else — the sidebar is empty for the same reason.
              </p>
            ) : (
              <ul className="flex flex-wrap gap-1">
                {held.map((key) => (
                  <li
                    key={key}
                    className="rounded-[3px] bg-accent-soft px-1.5 py-0.5 font-mono text-[11px] text-accent"
                  >
                    {key}
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>
      </div>

      <p className="mt-4 max-w-[62ch] text-sm text-ink-muted">
        A key you expect and cannot see is one of three things: the{" "}
        <code className="font-mono">role_template</code> assigned to you does not
        grant it, a <code className="font-mono">principal_override</code> row
        denies it, or the template seals it and no override can reopen it. This
        page reports only the answer — the three are distinguishable wherever
        overrides are edited.
      </p>
    </>
  );
}
