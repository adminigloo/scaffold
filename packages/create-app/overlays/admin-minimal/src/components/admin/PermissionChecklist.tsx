"use client";

import { useId, useMemo, useState } from "react";
import { Badge, Input, cx } from "@/components/ui";

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

const STATES = ["inherit", "allow", "deny"] as const;

export function PermissionChecklist({
  rows,
  templateName,
  disabled = false,
  onChange,
}: PermissionChecklistProps) {
  const [filter, setFilter] = useState("");
  const filterId = useId();

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
    <div className="flex flex-col gap-5">
      <header className="flex flex-wrap items-center gap-3">
        <p className="text-sm text-ink-muted">
          Template <strong className="font-medium text-ink">{templateName}</strong>
          {overridden > 0 && (
            <>
              {" · "}
              {overridden} override{overridden === 1 ? "" : "s"}
            </>
          )}
        </p>
        <label htmlFor={filterId} className="sr-only">
          Filter permissions
        </label>
        <Input
          id={filterId}
          type="search"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter permissions"
          className="ml-auto w-56"
        />
      </header>

      {grouped.map(([category, items]) => (
        <section key={category}>
          <h3 className="mb-1 text-[11px] font-medium uppercase tracking-wider text-ink-muted">
            {category}
          </h3>

          <ul className="rounded-[--radius-card] border border-line bg-surface">
            {items.map((row) => (
              <li
                key={row.key}
                className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-line px-3 py-2.5 last:border-0"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm text-ink">{row.label}</span>
                    {row.sealed && <Badge tone="danger">Sealed</Badge>}
                    {/* The resolved answer, not just the inputs. An admin
                        reading a template plus an override in their head is an
                        admin who will get it wrong on the row that matters. */}
                    {!row.sealed && (
                      <Badge tone={effectiveFor(row) ? "accent" : "neutral"}>
                        {effectiveFor(row) ? "Can" : "Cannot"}
                      </Badge>
                    )}
                  </div>
                  <p className="mt-0.5 text-xs text-ink-muted">
                    {row.description ?? row.key} · {reasonFor(row)}
                  </p>
                </div>

                <fieldset
                  disabled={disabled || row.sealed}
                  className="flex shrink-0 gap-px rounded-[--radius-card] border border-line p-px disabled:opacity-50"
                >
                  <legend className="sr-only">{row.label}</legend>
                  {STATES.map((state) => (
                    // A styled radio, not a button: a segmented control built
                    // from buttons has no group semantics and arrow keys do
                    // nothing, so a keyboard user cannot move between the three
                    // choices at all. The input stays in the DOM and focusable;
                    // `sr-only` hides it visually and nothing else.
                    <label
                      key={state}
                      className={cx(
                        "cursor-pointer rounded-[3px] px-2 py-0.5 text-xs capitalize",
                        "has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent",
                        row.override === state
                          ? "bg-accent text-surface"
                          : "text-ink-muted hover:text-ink",
                        (disabled || row.sealed) && "cursor-not-allowed",
                      )}
                    >
                      <input
                        type="radio"
                        name={`perm-${row.key}`}
                        value={state}
                        checked={row.override === state}
                        onChange={() => onChange(row.key, state)}
                        className="sr-only"
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
        <p className="text-sm text-ink-muted">
          No permissions match &ldquo;{filter}&rdquo;.
        </p>
      )}
    </div>
  );
}
