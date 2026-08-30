"use client";

import { useState } from "react";
import {
  PermissionChecklist,
  type OverrideState,
} from "@/components/admin/PermissionChecklist";
import { api } from "@/trpc/client";

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
    <div style={{ display: "grid", gap: "1.5rem" }}>
      {templates.data && templates.data.templates.length > 0 && (
        <ul
          style={{
            listStyle: "none",
            margin: 0,
            padding: 0,
            display: "flex",
            gap: "0.5rem",
            flexWrap: "wrap",
          }}
        >
          {templates.data.templates.map((item) => (
            <li
              key={item.id}
              style={{
                border: "1px solid #e3e6ea",
                borderRadius: 4,
                padding: "0.375rem 0.625rem",
                fontSize: "0.75rem",
                color: "#4b5563",
              }}
            >
              <strong style={{ color: "#111827" }}>{item.name}</strong> ·{" "}
              {item.holders} {item.holders === 1 ? "person" : "people"}
              {!item.isSystem && " · customised"}
            </li>
          ))}
        </ul>
      )}

      {templates.data?.templates.length === 0 && (
        <p style={{ fontSize: "0.875rem", color: "#6b7280", margin: 0 }}>
          No staff role templates exist yet. Run <code>pnpm db:seed</code> — it
          creates them from <code>src/permissions/catalog.ts</code> and is safe
          to re-run.
        </p>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "260px 1fr", gap: "1.5rem" }}>
        <section style={{ minWidth: 0 }}>
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Find a person"
            aria-label="Find a person"
            style={{
              width: "100%",
              padding: "0.375rem 0.625rem",
              border: "1px solid #d1d5db",
              borderRadius: 4,
              fontSize: "0.875rem",
              marginBottom: "0.5rem",
            }}
          />

          {people.isPending && (
            <p style={{ fontSize: "0.8125rem", color: "#6b7280" }}>Loading…</p>
          )}

          {people.isError && (
            <p style={{ fontSize: "0.8125rem", color: "#a02e21" }}>
              {people.error.message}
            </p>
          )}

          <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {rows.map((person) => {
              const active = person.id === selected;
              return (
                <li key={person.id}>
                  <button
                    type="button"
                    onClick={() => setPicked(person.id)}
                    aria-current={active ? "true" : undefined}
                    style={{
                      display: "block",
                      width: "100%",
                      textAlign: "left",
                      border: 0,
                      borderRadius: 4,
                      padding: "0.5rem",
                      cursor: "pointer",
                      background: active ? "#f3f4f6" : "transparent",
                      fontWeight: active ? 600 : 400,
                      fontSize: "0.875rem",
                      color: "#111827",
                    }}
                  >
                    {person.displayName ?? person.email ?? person.id}
                    <span
                      style={{
                        display: "block",
                        fontSize: "0.75rem",
                        color: "#6b7280",
                        fontWeight: 400,
                      }}
                    >
                      {person.templateName ?? "No staff template"}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>

          {people.isSuccess && rows.length === 0 && (
            <p style={{ fontSize: "0.8125rem", color: "#6b7280" }}>
              {search.trim() === ""
                ? "Nobody has signed in yet. A row appears here the first time someone signs in through Clerk — the app mirrors the Clerk user into the local users table on that first request."
                : `Nobody matches "${search.trim()}".`}
            </p>
          )}

          {people.data?.hasMore && (
            <p style={{ fontSize: "0.75rem", color: "#6b7280" }}>
              Showing the 25 most recent. Narrow it with the search box.
            </p>
          )}
        </section>

        <section style={{ minWidth: 0 }}>
          {failure && (
            <p
              role="alert"
              style={{
                margin: "0 0 1rem",
                padding: "0.625rem 0.75rem",
                border: "1px solid #a02e21",
                borderRadius: 4,
                fontSize: "0.8125rem",
                color: "#a02e21",
              }}
            >
              {failure}
            </p>
          )}

          {stale.length > 0 && (
            <p
              role="alert"
              style={{
                margin: "0 0 1rem",
                padding: "0.625rem 0.75rem",
                border: "1px solid #b45309",
                borderRadius: 4,
                fontSize: "0.8125rem",
                color: "#b45309",
              }}
            >
              Stored rows reference permissions the catalog no longer declares:{" "}
              <code>{stale.join(", ")}</code>. The resolver refuses these, so
              this person may be denied everything until a migration rewrites or
              removes the rows.
            </p>
          )}

          {selected === null && (
            <p style={{ fontSize: "0.875rem", color: "#6b7280" }}>
              Pick a person to see what they can do.
            </p>
          )}

          {permissions.isPending && selected !== null && (
            <p style={{ fontSize: "0.875rem", color: "#6b7280" }}>Loading…</p>
          )}

          {permissions.isError && (
            <p style={{ fontSize: "0.875rem", color: "#a02e21" }}>
              {permissions.error.message}
            </p>
          )}

          {permissions.data && (
            <>
              {!canManage && (
                <p style={{ fontSize: "0.8125rem", color: "#6b7280", marginTop: 0 }}>
                  Read-only. Changing an override needs{" "}
                  <code>staff.roles.manage</code>.
                </p>
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
