"use client";

import { useState } from "react";
import {
  PermissionChecklist,
  type OverrideState,
  type PermissionRow,
} from "@/components/admin/PermissionChecklist";

/**
 * Roles and per-person overrides.
 *
 * Wired to local state here so the shell is usable the moment it is generated.
 * Replace `rows` with a tRPC query and `onChange` with a mutation that writes
 * `principal_override` — the resolver, the sealing rule and the audit row are
 * all already in the packages, so this page only ever moves data.
 */
const DEMO_ROWS: PermissionRow[] = [
  {
    key: "members.view",
    label: "View members",
    category: "Team",
    fromTemplate: true,
    sealed: false,
    override: "inherit",
  },
  {
    key: "members.invite",
    label: "Invite members",
    category: "Team",
    fromTemplate: true,
    sealed: false,
    override: "deny",
  },
  {
    key: "members.remove",
    label: "Remove members",
    category: "Team",
    fromTemplate: false,
    sealed: false,
    override: "allow",
  },
  {
    key: "tenant.transfer",
    label: "Transfer ownership",
    description: "Hands over billing and the power to remove the previous owner.",
    category: "Danger",
    fromTemplate: false,
    sealed: true,
    override: "inherit",
  },
];

export default function RolesPage() {
  const [rows, setRows] = useState<PermissionRow[]>(DEMO_ROWS);

  function handleChange(key: string, next: OverrideState) {
    setRows((current) =>
      current.map((row) => (row.key === key ? { ...row, override: next } : row)),
    );
  }

  return (
    <>
      <h1 style={{ fontSize: "1.5rem", margin: "0 0 0.25rem" }}>Roles &amp; permissions</h1>
      <p style={{ color: "#6b7280", maxWidth: "62ch", marginTop: 0 }}>
        A template sets the baseline. Override an individual capability on top of
        it without inventing a new role. Sealed rows cannot be granted this way.
      </p>
      <PermissionChecklist
        rows={rows}
        templateName="Client Admin"
        onChange={handleChange}
      />
    </>
  );
}
