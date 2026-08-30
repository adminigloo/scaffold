import { currentPrincipal } from "@/server/auth";
import { loadStaffPermissions } from "@/server/permissions";
import { Card, CardBody, CardHeader, PageHeader } from "@/components/ui";

/**
 * Deliberately not a metrics wall.
 *
 * A generated dashboard full of invented KPI tiles is the thing a client sees
 * first and the thing they cannot use, because none of the numbers mean
 * anything in their business. What it shows instead is the one fact the person
 * who just signed in actually needs: who the app thinks they are, and what it
 * has decided they may do. That is also the answer to the support question this
 * shell gets most often.
 */
export default async function AdminDashboard() {
  const principal = await currentPrincipal();
  const can = principal ? await loadStaffPermissions({ principal }) : null;
  const held = can?.toArray() ?? [];

  return (
    <>
      <PageHeader
        title="Dashboard"
        description="Everything below the shell is copied source, not a package — replace this page with whatever this business opens first in the morning."
      />

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader title="Signed in as" />
          <CardBody>
            <p className="text-sm text-ink">{principal?.email ?? "unknown"}</p>
            <p className="mt-1 font-mono text-xs text-ink-muted">
              {principal?.userId ?? "no principal"}
            </p>
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title="Staff permissions"
            hint={`${held.length} held`}
          />
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
    </>
  );
}
