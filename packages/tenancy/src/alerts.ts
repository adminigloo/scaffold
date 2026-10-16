import type { TenancyEvent } from "./events.js";

/**
 * Alerts about the team (Tenancy 2b-1, 8.4): "Cam Rivera joined the team as
 * Crew member", "Pat left the team". Tenancy's fragment for the project's
 * alert registry, and the mapper from its own events to alert drafts.
 *
 * ROOT, CLIENT-SAFE AND STRUCTURAL (2a D4, 2b-1 D3): nothing here imports
 * @adminigloo/notifications, a table or a driver. The shapes are declared
 * again in every package that produces alerts, identical field for field
 * (2b-1 section 3.2, 3.3), prefixed `Tenancy…` so a generated file importing
 * two packages never sees two `AlertDraft`s. The words live here because
 * tenancy knows the fact: a wording fix reaches every project by npm.
 */

/** How a person hears about a kind of alert (2b-1 D5). */
export type TenancyAlertChannel = "in_app" | "email";

/** One kind of alert (2b-1 section 3.2), structurally identical to notifications' `AlertKindSpec`. */
export interface TenancyAlertKind {
  /** Permanent. /^[a-z][a-z0-9]*(\.[a-z][a-z0-9-]*){1,3}$/, at most 64 characters. */
  readonly key: string;
  /** What a person sees in Alert settings, a plain phrase. */
  readonly label: string;
  readonly description?: string;
  /** The heading it is listed under. */
  readonly category: string;
  readonly audience: {
    /** Only active members holding this may receive it (D4). */
    readonly permission: string;
    /** The routing group whose chosen people get it (default: the owner). Absent: everyone holding `permission`. */
    readonly routing?: string;
    /** People assigned to the record who hold this also get it (crew). */
    readonly assigned?: { readonly permission: string };
  };
  /** For someone who never chose. */
  readonly defaultChannel: TenancyAlertChannel;
  /** false: never emailed, and the choice isn't offered. Default true. */
  readonly email?: boolean;
  /** "producer": the package sends its own office email for it (D6). Default "notifications". */
  readonly emailBy?: "notifications" | "producer";
  /** Order inside its category. Default 100. */
  readonly order?: number;
}

/** A routing group (2b-1 section 3.2). Tenancy declares none: a teammate joining isn't new work. */
export interface TenancyAlertRouting {
  /** /^[a-z][a-z0-9-]{1,31}$/. Permanent (stored). */
  readonly key: string;
  readonly label: string;
  readonly description?: string;
  /** Who may be chosen for it: members holding this. */
  readonly permission: string;
  readonly order?: number;
}

/** Tenancy's fragment for the project's alert registry. */
export interface TenancyAlertKinds {
  readonly kinds: readonly TenancyAlertKind[];
  readonly routings: readonly TenancyAlertRouting[];
}

/** What a mapper returns and `alerts.notify` takes (2b-1 section 3.3). */
export interface TenancyAlertDraft {
  readonly tenantId: string;
  /** A registered kind key. */
  readonly kind: string;
  /** One line, 1–200 characters, plain text: no CR, LF, U+2028 or U+2029 (it becomes an email Subject; D18). */
  readonly title: string;
  /** At most 2000 characters, plain text; null = none. */
  readonly body: string | null;
  /** A same-site path matching /^\/(?![\/\\])[^\\\s\u0000-\u001f]{0,499}$/; null = nothing to open. */
  readonly href: string | null;
  /** Where it opens for someone reached ONLY through `assigned`. Default `href`. */
  readonly assignedHref?: string | null;
  /** D7: from the durable fact; 1–200 characters. */
  readonly dedupeKey: string;
  /** What it is about. */
  readonly subject: { readonly type: string; readonly id: string } | null;
  /** Who caused it; never alerted about it. null for a customer or the system. */
  readonly actorUserId: string | null;
  /** For kinds with `audience.assigned`: who is on the record. */
  readonly assignedUserIds?: readonly string[];
  /** Where a reply to the email copy goes. */
  readonly replyTo?: string | null;
}

/** The two kinds' permanent keys (stored on alert rows and on people's choices). */
export const TENANCY_MEMBER_JOINED_KIND = "tenancy.member.joined";
export const TENANCY_MEMBER_LEFT_KIND = "tenancy.member.left";

/**
 * Tenancy's alert fragment (8.4).
 *
 * Audience `members.invite`: the people who bring others onto the team (the
 * owner and admins by default) are the ones who want to hear that someone
 * took the invitation, or left. No routing group: a teammate joining is not
 * work coming in, so the routed-to-the-owner default of D4 doesn't apply.
 * "Removed" and "left" are one kind (one choice for the person): either way,
 * the team got smaller.
 */
export const tenancyAlertKinds: TenancyAlertKinds = Object.freeze({
  kinds: Object.freeze([
    Object.freeze({
      key: TENANCY_MEMBER_JOINED_KIND,
      label: "Someone joins the team",
      description: "When someone accepts an invitation and joins.",
      category: "Team",
      audience: Object.freeze({ permission: "members.invite" }),
      defaultChannel: "in_app",
      order: 10,
    }) as TenancyAlertKind,
    Object.freeze({
      key: TENANCY_MEMBER_LEFT_KIND,
      label: "Someone leaves the team",
      description: "When someone leaves, or is removed from the team.",
      category: "Team",
      audience: Object.freeze({ permission: "members.invite" }),
      defaultChannel: "in_app",
      order: 20,
    }) as TenancyAlertKind,
  ]),
  routings: Object.freeze([]) as readonly TenancyAlertRouting[],
}) as TenancyAlertKinds;

/** 3.3's href rule (D18): a same-site path; no "//", no "/\", no backslash, whitespace or control character. */
const HREF_PATTERN = /^\/(?![\/\\])[^\\\s\u0000-\u001f]{0,499}$/;

/**
 * One line of plain text: CR, LF, U+2028, U+2029 and every other control
 * character become a space (a title becomes an email Subject, D18), runs of
 * space collapse, and it is cut to `max` characters with an ellipsis. By code
 * point, so an emoji in a name is never split in half.
 */
function oneLine(value: string, max: number): string {
  let out = "";
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    const control = code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029;
    out += control ? " " : char;
  }
  const cleaned = out.replace(/\s+/g, " ").trim();
  const chars = Array.from(cleaned);
  return chars.length <= max ? cleaned : `${chars.slice(0, max - 1).join("").trimEnd()}…`;
}

/** "{name}": the person's name, else their address, else "Someone" (8.4). */
function nameOf(person: { readonly name: string | null; readonly email: string | null }): string {
  const name = person.name ? oneLine(person.name, 120) : "";
  if (name) return name;
  const email = person.email ? oneLine(person.email, 120) : "";
  return email || "Someone";
}

/** The team page, when the pattern given is a same-site path; otherwise nothing to open. */
function hrefFrom(pattern: string, tenantId: string): string | null {
  // The pattern rule of 2b-1 3.3: `{id}` (here, the company) URL-encoded.
  const href = pattern.replace(/\{id\}/g, encodeURIComponent(tenantId));
  return HREF_PATTERN.test(href) ? href : null;
}

/**
 * A tenancy event → its alert drafts (8.4's table). Only the three member
 * events alert; every other event answers [] (a setting saved, a logo
 * changed and an invitation sent are the caller's own doing).
 *
 * DEDUPE KEYS (2b-1 D7): a member event has no durable fact of its own to
 * key on (the same person may join, leave and join again), so the key is the
 * event's own `id`, stamped once by `ctx.emit`: the same event handed to the
 * listener twice alerts once. Removed and left share the `left` kind and its
 * key prefix.
 *
 * `actorUserId` is never alerted about their own action (D4): the joiner
 * about their own joining, the leaver about leaving, the person who removed
 * someone about the removal.
 */
export function tenancyAlertsFor(event: TenancyEvent, options: { readonly teamHref: string }): readonly TenancyAlertDraft[] {
  const href = hrefFrom(options.teamHref, event.tenantId);
  switch (event.type) {
    case "member.joined": {
      const role = oneLine(event.roleName, 60) || "a member";
      return [
        {
          tenantId: event.tenantId,
          kind: TENANCY_MEMBER_JOINED_KIND,
          title: oneLine(`${nameOf(event.person)} joined the team as ${role}`, 200),
          body: null,
          href,
          dedupeKey: `${TENANCY_MEMBER_JOINED_KIND}:${event.id}`,
          subject: { type: "tenancy.member", id: event.userId },
          actorUserId: event.userId,
        },
      ];
    }
    case "member.left":
    case "member.removed": {
      const left = event.type === "member.left";
      return [
        {
          tenantId: event.tenantId,
          kind: TENANCY_MEMBER_LEFT_KIND,
          title: oneLine(left ? `${nameOf(event.person)} left the team` : `${nameOf(event.person)} was removed from the team`, 200),
          body: null,
          href,
          dedupeKey: `${TENANCY_MEMBER_LEFT_KIND}:${event.id}`,
          subject: { type: "tenancy.member", id: event.userId },
          // The leaver left; whoever removed someone did it. Either is spared.
          actorUserId: left ? event.userId : event.by,
        },
      ];
    }
    default:
      return [];
  }
}
