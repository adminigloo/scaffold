/**
 * The closed audit vocabulary of the company lifecycle (decision D17,
 * contract 5.6). Structurally an observability `AuditedActionMap`, so the
 * project spreads it into its audit registry; tenancy doesn't depend on
 * observability.
 *
 * A KEY IS PERMANENT. Rows written today are read back with these labels for
 * as long as the audit log is kept, so a key is never renamed or reused. The
 * three `invitation.*` keys keep the exact names the 0.3 invitations router
 * used, so historic rows keep their labels.
 *
 * `sensitive` marks the acts that change who holds power (a role change, an
 * ownership hand-over, a staff role): the operator console badges them.
 */
export const tenancyAuditedActions = {
  "company.created": { label: "Created a company" },
  "company.profile.updated": { label: "Changed the company's name or web address" },
  "company.branding.updated": { label: "Changed the company's logo or colour" },
  "company.settings.updated": { label: "Changed company settings" },
  "company.ownership.transferred": { label: "Handed ownership of the company to someone else", sensitive: true },
  "company.suspended": { label: "Suspended a company" },
  "company.reactivated": { label: "Reactivated a company" },
  "company.addresses.released": { label: "Released a company's old web addresses" },
  "company.deleted": { label: "Deleted a company and everything it kept", sensitive: true },
  "member.role.changed": { label: "Changed a member's role", sensitive: true },
  "member.removed": { label: "Removed a member" },
  "member.left": { label: "Left the company" },
  "invitation.sent": { label: "Invited somebody to join" },
  "invitation.accepted": { label: "Accepted an invitation and joined", sensitive: true },
  "invitation.revoked": { label: "Revoked an invitation before it was accepted" },
  "staff.role.assigned": { label: "Gave someone a staff role", sensitive: true },
  "staff.role.removed": { label: "Took away someone's staff role" },
  "staff.bootstrap.granted": { label: "Made the first administrator", sensitive: true },
} as const satisfies Readonly<Record<string, { readonly label: string; readonly sensitive?: boolean }>>;

export type TenancyAuditAction = keyof typeof tenancyAuditedActions;

const ROLE_NAMES: Readonly<Record<string, string>> = {
  owner: "Owner",
  admin: "Admin",
  member: "Member",
  viewer: "Viewer",
  cs_lead: "Customer service lead",
  cs_agent: "Customer service agent",
};

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function role(value: unknown): string {
  const key = text(value);
  if (key === null) return "no role";
  return ROLE_NAMES[key] ?? key;
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/**
 * One audit row's metadata, in plain words, for the operator console's
 * activity list (review T1-17): "Jake: Member → Admin", "jo@x.com as Viewer",
 * "Reason: payment needed".
 *
 * WHY IT LIVES HERE. The label says WHAT happened ("Changed a member's
 * role"); support needs WHO and TO WHAT — "who removed me?" is the first
 * question a removed crew lead's owner gets asked. The metadata each action
 * writes is this package's own shape, so the words are written next to it and
 * reach every project by `npm update` instead of being re-derived in each
 * host's audit query.
 *
 * Never throws and never echoes an unknown shape: an action it doesn't know,
 * or metadata that isn't what this package writes, gives `null` (the console
 * then shows the label alone). Tokens and URLs are never in the metadata, so
 * nothing secret can come out of here.
 */
/** The business details' fields in an owner's words; the address's parts are all "address". */
const SETTING_WORDS: Readonly<Record<string, string>> = {
  timeZone: "time zone",
  contactEmail: "contact email",
  contactPhone: "phone",
  addressLine1: "address",
  addressLine2: "address",
  city: "address",
  region: "address",
  postalCode: "address",
  country: "address",
  // Invoicing's fragment (Tenancy 2a), the section most companies add.
  paymentInstructions: "how customers pay",
  dueDays: "days until due",
  footer: "invoice note",
};

/** Sections by the name the settings page gives them. */
const SECTION_WORDS: Readonly<Record<string, string>> = { company: "Business details", invoicing: "Invoice details" };

/** "paymentInstructions" → "payment instructions": any other section's key, as words. */
function humanise(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .toLowerCase();
}

function capitalise(words: string): string {
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function settingWords(key: string): string {
  return SETTING_WORDS[key] ?? humanise(key);
}

export function describeTenancyAuditEntry(action: string, metadata: unknown): string | null {
  const m = record(metadata);
  switch (action) {
    case "company.created": {
      const name = text(m["name"]);
      const slug = text(m["slug"]);
      if (name === null) return null;
      return slug === null ? name : `${name} (/${slug})`;
    }
    case "company.profile.updated": {
      const from = record(m["from"]);
      const to = record(m["to"]);
      const parts: string[] = [];
      if (text(from["name"]) !== text(to["name"]) && text(to["name"]) !== null) {
        parts.push(`Name: ${text(from["name"]) ?? "none"} → ${text(to["name"])}`);
      }
      if (text(from["slug"]) !== text(to["slug"]) && text(to["slug"]) !== null) {
        parts.push(`Web address: ${text(from["slug"]) ?? "none"} → ${text(to["slug"])}`);
      }
      return parts.length > 0 ? parts.join("; ") : null;
    }
    case "company.branding.updated": {
      const logo = text(m["logo"]);
      if (logo === "uploaded") return "New logo";
      if (logo === "removed") return "Logo removed";
      if ("brandColor" in m) return `Colour: ${text(m["from"]) ?? "none"} → ${text(m["brandColor"]) ?? "none"}`;
      return null;
    }
    case "company.settings.updated": {
      // In words, never field keys (review T2A-BO-14): "Business details:
      // time zone, contact email, phone", not "Changed: timeZone, contactEmail".
      const changed = Array.isArray(m["changed"]) ? m["changed"].filter((k): k is string => typeof k === "string") : [];
      if (changed.length === 0) return null;
      const words = [...new Set(changed.map(settingWords))];
      const section = text(m["section"]);
      const heading = section === null ? "Changed" : (SECTION_WORDS[section] ?? capitalise(humanise(section)));
      return `${heading}: ${words.join(", ")}`;
    }
    case "company.ownership.transferred": {
      if (text(m["via"]) === "operator") return "By platform staff";
      const toName = text(m["toName"]);
      return toName === null ? null : `To ${toName}`;
    }
    case "company.suspended": {
      const reason = text(m["reason"]);
      return reason === null ? null : `Reason: ${reason}`;
    }
    case "company.reactivated": {
      const reason = text(m["suspendedReason"]);
      return reason === null ? null : `Had been suspended for: ${reason}`;
    }
    case "company.deleted": {
      // Tenancy 0.8: what went, in words; the reason when staff deleted one still paying.
      const name = text(m["name"]);
      if (name === null) return null;
      const slug = text(m["slug"]);
      const rows = typeof m["rows"] === "number" && Number.isFinite(m["rows"]) ? (m["rows"] as number) : null;
      const what = `${name}${slug === null ? "" : ` (/${slug})`}${rows === null ? "" : `: ${rows} record${rows === 1 ? "" : "s"} removed`}`;
      const reason = text(m["reason"]);
      return m["forced"] === true && reason !== null ? `${what}. Deleted while still paying: ${reason}` : what;
    }
    case "company.addresses.released": {
      const slugs = Array.isArray(m["slugs"]) ? m["slugs"].filter((s): s is string => typeof s === "string") : [];
      const current = record(m["current"]);
      const from = text(current["from"]);
      const to = text(current["to"]);
      const parts = slugs.map((s) => `/${s}`);
      // Review R2 SEC-T1-C: a suspended company's current address, freed.
      if (from !== null && to !== null) parts.push(`/${from} (now /${to})`);
      return parts.length > 0 ? parts.join(", ") : null;
    }
    case "member.role.changed": {
      const member = text(m["member"]) ?? "Someone";
      const cleared = Array.isArray(m["clearedOverrides"]) && m["clearedOverrides"].length > 0;
      return `${member}: ${role(m["from"])} → ${role(m["to"])}${cleared ? " (their own extra access was cleared)" : ""}`;
    }
    case "member.removed":
    case "member.left": {
      const member = text(m["member"]);
      if (member === null) return null;
      return text(m["role"]) === null ? member : `${member} (${role(m["role"])})`;
    }
    case "invitation.sent": {
      const email = text(m["email"]);
      if (email === null) return null;
      const again = m["resend"] === true;
      const before = text(m["previousRoleKey"]);
      return `${email} as ${role(m["roleKey"])}${before !== null ? ` (was ${role(before)})` : again ? " (sent again)" : ""}`;
    }
    case "invitation.revoked": {
      const email = text(m["email"]);
      if (email === null) return null;
      const via = text(m["via"]);
      if (
        via === "member.removed" ||
        via === "member.left" ||
        via === "member.role.changed" ||
        via === "account.deleted" ||
        via === "inviter.can-no-longer-invite"
      ) {
        return `${email}: withdrawn because the person who sent it no longer could`;
      }
      return email;
    }
    case "invitation.accepted": {
      const parts: string[] = [];
      if (text(m["via"]) === "verified-email") parts.push("Joined with their verified email address");
      // Review R2 SEC-T1-E: joining replaced access left over from before.
      const replaced = text(m["replacedRole"]);
      const cleared = Array.isArray(m["clearedOverrides"]) ? m["clearedOverrides"].length : 0;
      if (replaced !== null && replaced !== "") parts.push(`Their old ${role(replaced)} access was replaced by the invitation's role`);
      if (cleared > 0) parts.push("Extra access left over from before was cleared");
      return parts.length > 0 ? parts.join("; ") : null;
    }
    case "staff.role.assigned":
    case "staff.role.removed": {
      if (text(m["via"]) === "account.deleted") return "Their account was deleted";
      if (text(m["via"]) === "admin:grant") return "From the admin:grant command";
      const person = text(m["person"]);
      if (person !== null) return `${person}: ${role(m["from"])} → ${role(m["to"])}`;
      const to = text(m["templateKey"]) ?? text(m["to"]);
      return to === null ? null : `Now ${role(to)}`;
    }
    default:
      return null;
  }
}
