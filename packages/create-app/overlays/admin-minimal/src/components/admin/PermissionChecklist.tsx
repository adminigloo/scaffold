"use client";

import { useMemo, useState } from "react";

/**
 * The checklist.
 *
 * This is the surface the whole permission model exists to serve: a role
 * template sets the baseline, and an individual can be granted or denied one
 * capability on top of it without inventing a new role.
 *
 * THREE STATES PER ROW, not a checkbox. A checkbox can only say on or off, and
 * that conflates "inherited from the template" with "explicitly set for this
 * person" — which is exactly the distinction an admin needs when they later ask
 * why someone can do something. The states are:
 *
 *   inherit  no override row; whatever the template says
 *   allow    an override granting it
 *   deny     an override revoking it
 *
 * A permission the template SEALS (an explicit deny in the template) cannot be
 * reopened by an override. Those rows render disabled with the reason, rather
 * than as an unchecked box that silently refuses to stick.
 */

export type OverrideState = "inherit" | "allow" | "deny";

export interface PermissionRow {
  readonly key: string;
  readonly label: string;
  readonly description?: string;
  readonly category: string;
  /** What the assigned template grants, before overrides. */
  readonly fromTemplate: boolean;
  /** The template explicitly denies it; no override can reopen it. */
  readonly sealed: boolean;
  readonly override: OverrideState;
}

export interface PermissionChecklistProps {
  readonly rows: readonly PermissionRow[];
  readonly templateName: string;
  readonly disabled?: boolean;
  onChange(key: string, next: OverrideState): void;
}

/** What the person can actually do, once the rules are applied. */
export function effectiveFor(row: PermissionRow): boolean {
  if (row.sealed) return false;
  if (row.override === "allow") return true;
  if (row.override === "deny") return false;
  return row.fromTemplate;
}

/** Why, in words an admin can act on. */
export function reasonFor(row: PermissionRow): string {
  if (row.sealed) return `Sealed by ${"the role template"} — cannot be granted individually`;
  if (row.override === "allow") return "Granted for this person specifically";
  if (row.override === "deny") return "Revoked for this person specifically";
  return row.fromTemplate ? "From the role template" : "Not granted";
}

export function PermissionChecklist({
  rows,
  templateName,
  disabled = false,
  onChange,
}: PermissionChecklistProps) {
  const [filter, setFilter] = useState("");

  const grouped = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const matched = needle
      ? rows.filter(
          (r) =>
            r.label.toLowerCase().includes(needle) ||
            r.key.toLowerCase().includes(needle),
        )
      : rows;

    const map = new Map<string, PermissionRow[]>();
    for (const row of matched) {
      const bucket = map.get(row.category);
      if (bucket) bucket.push(row);
      else map.set(row.category, [row]);
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [rows, filter]);

  const overridden = rows.filter((r) => r.override !== "inherit").length;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1.25rem" }}>
      <header style={{ display: "flex", gap: "1rem", alignItems: "baseline", flexWrap: "wrap" }}>
        <p style={{ margin: 0, fontSize: "0.875rem", color: "#4b5563" }}>
          Template <strong>{templateName}</strong>
          {overridden > 0 && (
            <>
              {" · "}
              {overridden} override{overridden === 1 ? "" : "s"}
            </>
          )}
        </p>
        <input
          type="search"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter permissions"
          aria-label="Filter permissions"
          style={{
            marginLeft: "auto",
            padding: "0.375rem 0.625rem",
            border: "1px solid #d1d5db",
            borderRadius: 4,
            fontSize: "0.875rem",
          }}
        />
      </header>

      {grouped.map(([category, items]) => (
        <section key={category}>
          <h3
            style={{
              fontSize: "0.6875rem",
              letterSpacing: "0.12em",
              textTransform: "uppercase",
              color: "#6b7280",
              margin: "0 0 0.5rem",
            }}
          >
            {category}
          </h3>

          <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {items.map((row) => (
              <li
                key={row.key}
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr auto",
                  gap: "1rem",
                  alignItems: "center",
                  padding: "0.625rem 0",
                  borderBottom: "1px solid #f0f1f3",
                }}
              >
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: "0.875rem", color: "#111827" }}>
                    {row.label}
                    {row.sealed && (
                      <span
                        style={{
                          marginLeft: "0.5rem",
                          fontSize: "0.6875rem",
                          color: "#a02e21",
                          border: "1px solid #a02e21",
                          borderRadius: 3,
                          padding: "0 4px",
                        }}
                      >
                        SEALED
                      </span>
                    )}
                  </div>
                  <div style={{ fontSize: "0.75rem", color: "#6b7280" }}>
                    {row.description ?? row.key} · {reasonFor(row)}
                  </div>
                </div>

                <fieldset
                  disabled={disabled || row.sealed}
                  style={{ border: 0, margin: 0, padding: 0, display: "flex", gap: 4 }}
                >
                  <legend className="sr-only" style={{ position: "absolute", left: -9999 }}>
                    {row.label}
                  </legend>
                  {(["inherit", "allow", "deny"] as const).map((state) => (
                    <label
                      key={state}
                      style={{
                        fontSize: "0.75rem",
                        padding: "0.25rem 0.5rem",
                        border: "1px solid #d1d5db",
                        borderRadius: 4,
                        cursor: row.sealed ? "not-allowed" : "pointer",
                        background: row.override === state ? "#111827" : "#fff",
                        color: row.override === state ? "#fff" : "#4b5563",
                        opacity: row.sealed ? 0.5 : 1,
                      }}
                    >
                      <input
                        type="radio"
                        name={`perm-${row.key}`}
                        value={state}
                        checked={row.override === state}
                        onChange={() => onChange(row.key, state)}
                        style={{ position: "absolute", opacity: 0, width: 0, height: 0 }}
                      />
                      {state}
                    </label>
                  ))}
                </fieldset>
              </li>
            ))}
          </ul>
        </section>
      ))}

      {grouped.length === 0 && (
        <p style={{ fontSize: "0.875rem", color: "#6b7280" }}>
          No permissions match &ldquo;{filter}&rdquo;.
        </p>
      )}
    </div>
  );
}
