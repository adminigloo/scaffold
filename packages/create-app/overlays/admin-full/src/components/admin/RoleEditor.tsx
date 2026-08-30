"use client";

import { useId, useState } from "react";
import {
  PermissionChecklist,
  type OverrideState,
} from "@/components/admin/PermissionChecklist";
import { api } from "@/trpc/client";
import { Badge, Card, EmptyState, Input, Notice, cx } from "@/components/ui";

/**
 * The roles screen, wired to the database through tRPC.
 *
 * Copied source: restyle it freely. What must not move into this file is the
 * decision-making — which permissions exist, which of them are sealed, and
 * whether this person may change them all come back from `admin.permissionsFor`
 * already resolved. askLou is the counter-example: its client hook preferred
 * custom role permissions while most of its routers ignored them, so the button
 * appeared and the API refused it. One resolver, one answer, and the browser is
 * only ever told the result.
 *
 * Staff scope only. The same two procedures serve the tenant scope — pass
 * `scope: "tenant"` and a real `tenantId` — but that needs an organisation
 * picker, and which organisations a staff member may edit is a product
 * decision this scaffold should not make for you.
 */
export interface RoleEditorProps {
  /**
   * Resolved on the server from `staff.roles.manage`.
   *
   * Presentation only. `setOverride` re-checks it on every call, because a prop
   * is a hint from a page that has already rendered and the mutation is
   * reachable without it.
   */
  readonly canManage: boolean;
}

const SCOPE = "staff" as const;

export function RoleEditor({ canManage }: RoleEditorProps) {
  const utils = api.useUtils();
  const [search, setSearch] = useState("");
  const [picked, setPicked] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const searchId = useId();

  const templates = api.admin.listTemplates.useQuery({ scope: SCOPE });
  const people = api.admin.listPeople.useQuery({
    search: search.trim() === "" ? undefined : search.trim(),
    limit: 25,
  });

  // Derived rather than synced with an effect. Copying the first row into state
  // once it loads gives two sources of truth for the selection, and the copy
  // goes stale the moment a search narrows the list to people it does not
  // contain.
  const selected = picked ?? people.data?.people[0]?.id ?? null;

  // `enabled` keeps this from firing with an empty id before anyone is picked.
  // The input object is still passed, because it is the query key.
  const target = { principalId: selected ?? "", scope: SCOPE };
  const permissions = api.admin.permissionsFor.useQuery(target, {
    enabled: selected !== null,
  });

  const setOverride = api.admin.setOverride.useMutation({
    async onMutate(variables) {
      setFailure(null);

      // Keyed off the MUTATION's variables, not the current selection. The two
      // are the same at click time and can differ by the time the request
      // settles — picking a different person mid-flight would otherwise roll
      // the wrong cache entry back.
      const key = { principalId: variables.principalId, scope: variables.scope };

      // Without this, a refetch already in flight can land after the optimistic
      // write and restore the old value, which reads as the click silently
      // failing.
      await utils.admin.permissionsFor.cancel(key);

      const previous = utils.admin.permissionsFor.getData(key);
      utils.admin.permissionsFor.setData(key, (current) =>
        current
          ? {
              ...current,
              rows: current.rows.map((row) =>
                row.key === variables.permission
                  ? { ...row, override: variables.effect }
                  : row,
              ),
            }
          : current,
      );

      return { key, previous };
    },

    onError(error, _variables, context) {
      // Put the server's answer back. A checklist left showing a grant the
      // server refused is worse than an error, because the next person to read
      // it has no reason to doubt it.
      if (context) utils.admin.permissionsFor.setData(context.key, context.previous);
      setFailure(error.message);
    },

    onSettled(_data, _error, _variables, context) {
      // On success as well as failure: the row we drew optimistically is what
      // we guessed, and the refetch is what makes the screen agree with the
      // resolver — including the seal that would have refused it.
      if (context) void utils.admin.permissionsFor.invalidate(context.key);
    },
  });

  function handleChange(permission: string, next: OverrideState) {
    if (!selected) return;
    setOverride.mutate({
      principalId: selected,
      scope: SCOPE,
      permission,
      effect: next,
    });
  }

  const rows = people.data?.people ?? [];
  const template = permissions.data?.template ?? null;
  const stale = permissions.data?.stalePermissions ?? [];

  return (
    <div className="flex flex-col gap-5">
      {templates.data && templates.data.templates.length > 0 && (
        <ul className="flex flex-wrap gap-2">
          {templates.data.templates.map((item) => (
            <li
              key={item.id}
              className="rounded-[--radius-card] border border-line bg-surface px-2.5 py-1.5 text-xs text-ink-muted"
            >
              <strong className="font-medium text-ink">{item.name}</strong> ·{" "}
              {item.holders} {item.holders === 1 ? "person" : "people"}
              {!item.isSystem && (
                <Badge tone="warn" className="ml-1.5">
                  Customised
                </Badge>
              )}
            </li>
          ))}
        </ul>
      )}

      {templates.data?.templates.length === 0 && (
        <Notice tone="warn" title="No staff role templates exist yet">
          Run <code className="font-mono">pnpm db:seed</code> — it creates them
          from <code className="font-mono">src/permissions/catalog.ts</code> and
          is safe to re-run.
        </Notice>
      )}

      <div className="grid gap-5 lg:grid-cols-[16rem_1fr]">
        <section className="min-w-0">
          <label htmlFor={searchId} className="sr-only">
            Find a person
          </label>
          <Input
            id={searchId}
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Find a person"
            className="mb-2"
          />

          {people.isPending && <p className="text-[13px] text-ink-muted">Loading…</p>}

          {people.isError && (
            <p role="alert" className="text-[13px] text-danger">
              {people.error.message}
            </p>
          )}

          {rows.length > 0 && (
            <Card>
              <ul>
                {rows.map((person) => {
                  const active = person.id === selected;
                  return (
                    <li key={person.id} className="border-b border-line last:border-0">
                      <button
                        type="button"
                        onClick={() => setPicked(person.id)}
                        aria-current={active ? "true" : undefined}
                        className={cx(
                          "block w-full cursor-pointer px-3 py-2 text-left text-sm",
                          active ? "bg-accent-soft" : "hover:bg-canvas",
                        )}
                      >
                        <span
                          className={cx(
                            "block truncate",
                            active ? "font-medium text-accent" : "text-ink",
                          )}
                        >
                          {person.displayName ?? person.email ?? person.id}
                        </span>
                        <span className="block truncate text-xs text-ink-muted">
                          {person.templateName ?? "No staff template"}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </Card>
          )}

          {people.isSuccess && rows.length === 0 && (
            <EmptyState title={search.trim() === "" ? "Nobody has signed in yet" : "No match"}>
              {search.trim() === ""
                ? "A row appears here the first time someone signs in through Clerk — the app mirrors the Clerk user into the local users table on that first request."
                : `Nobody matches "${search.trim()}".`}
            </EmptyState>
          )}

          {people.data?.hasMore && (
            <p className="mt-2 text-xs text-ink-muted">
              Showing the 25 most recent. Narrow it with the search box.
            </p>
          )}
        </section>

        <section className="flex min-w-0 flex-col gap-4">
          {failure && (
            <Notice tone="danger" role="alert" title="That change was refused">
              {failure}
            </Notice>
          )}

          {stale.length > 0 && (
            <Notice tone="warn" role="alert" title="Stored rows reference unknown permissions">
              <code className="font-mono break-all">{stale.join(", ")}</code> are
              no longer declared by the catalog. The resolver refuses these, so
              this person may be denied everything until a migration rewrites or
              removes the rows.
            </Notice>
          )}

          {selected === null && (
            <p className="text-sm text-ink-muted">Pick a person to see what they can do.</p>
          )}

          {permissions.isPending && selected !== null && (
            <p className="text-sm text-ink-muted">Loading…</p>
          )}

          {permissions.isError && (
            <p role="alert" className="text-sm text-danger">
              {permissions.error.message}
            </p>
          )}

          {permissions.data && (
            <>
              {!canManage && (
                <Notice tone="info" title="Read-only">
                  Changing an override needs{" "}
                  <code className="font-mono">staff.roles.manage</code>.
                </Notice>
              )}
              <PermissionChecklist
                rows={permissions.data.rows}
                templateName={template?.name ?? "No template assigned"}
                disabled={!canManage}
                onChange={handleChange}
              />
            </>
          )}
        </section>
      </div>
    </div>
  );
}
