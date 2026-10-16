import { createRequester, isObject, listOf, num, str, strOrNull, stringList, type Result, type TransportOptions } from "./http.js";
import type {
  AlertChoiceWire,
  AlertCountWire,
  AlertListWire,
  AlertWire,
  PreferenceBody,
  PreferencesWire,
  RoutingBody,
  RoutingGroupWire,
  RoutingPersonWire,
  RoutingWire,
} from "./types.js";

/**
 * The alerts screens' transport: one method per route of
 * @adminigloo/notifications's `createNotificationHandlers` (contract 4.7). A
 * host that backs the screens with something else (a server action, tRPC)
 * passes its own object of this shape as `transport`.
 */
export interface AlertsTransport {
  count(): Promise<Result<AlertCountWire>>;
  list(q?: { unread?: boolean; cursor?: string; limit?: number }): Promise<Result<AlertListWire>>;
  markRead(id: string): Promise<Result<AlertCountWire>>;
  markAllRead(): Promise<Result<AlertCountWire>>;
  preferences(): Promise<Result<PreferencesWire>>;
  setPreference(body: PreferenceBody): Promise<Result<PreferencesWire>>;
  routing(): Promise<Result<RoutingWire>>;
  setRouting(body: RoutingBody): Promise<Result<RoutingWire>>;
}

const bool = (value: unknown, fallback: boolean) => (typeof value === "boolean" ? value : fallback);

export function parseCount(raw: unknown): AlertCountWire | null {
  if (!isObject(raw) || typeof raw.unread !== "number") return null;
  // A server that predates `reachable` is read as reachable: the bell's
  // ordinary empty state, never the "not on any list" one.
  return { unread: Math.max(0, Math.trunc(num(raw.unread))), reachable: bool(raw.reachable, true) };
}

export function parseAlert(raw: unknown): AlertWire | null {
  if (!isObject(raw) || typeof raw.id !== "string" || typeof raw.title !== "string") return null;
  return {
    id: raw.id,
    kind: str(raw.kind),
    category: str(raw.category, "Alerts") || "Alerts",
    title: raw.title,
    body: strOrNull(raw.body),
    href: strOrNull(raw.href),
    at: str(raw.at),
    read: raw.read === true,
  };
}

function parseList(raw: unknown): AlertListWire | null {
  const count = parseCount(raw);
  if (!count || !isObject(raw) || !Array.isArray(raw.alerts)) return null;
  const links = isObject(raw.links) ? raw.links : {};
  return {
    alerts: listOf(raw.alerts, parseAlert),
    nextCursor: strOrNull(raw.nextCursor),
    unread: count.unread,
    reachable: count.reachable,
    links: { inbox: strOrNull(links.inbox), settings: strOrNull(links.settings) },
  };
}

function parseChoice(raw: unknown): AlertChoiceWire | null {
  if (!isObject(raw) || typeof raw.kind !== "string" || typeof raw.label !== "string") return null;
  const routed = isObject(raw.routed)
    ? { group: str(raw.routed.group), onList: raw.routed.onList === true, viaAssigned: raw.routed.viaAssigned === true }
    : null;
  return {
    kind: raw.kind,
    label: raw.label,
    description: strOrNull(raw.description),
    category: str(raw.category, "Alerts") || "Alerts",
    channel: raw.channel === "email" ? "email" : "in_app",
    emailOffered: raw.emailOffered === true,
    emailNote: strOrNull(raw.emailNote),
    emailOffInMessages: raw.emailOffInMessages === true,
    routed,
    receives: bool(raw.receives, true),
    emailTo: strOrNull(raw.emailTo),
  };
}

function parsePreferences(raw: unknown): PreferencesWire | null {
  if (!isObject(raw) || !Array.isArray(raw.choices)) return null;
  const links = isObject(raw.links) ? raw.links : {};
  return {
    emailAddress: strOrNull(raw.emailAddress),
    emailAvailable: raw.emailAvailable === true,
    emailOffReason: strOrNull(raw.emailOffReason),
    categories: stringList(raw.categories),
    choices: listOf(raw.choices, parseChoice),
    canManageRouting: raw.canManageRouting === true,
    reachable: bool(raw.reachable, true),
    links: { messages: strOrNull(links.messages) },
  };
}

function parsePerson(raw: unknown): RoutingPersonWire | null {
  if (!isObject(raw) || typeof raw.userId !== "string") return null;
  return { userId: raw.userId, name: strOrNull(raw.name), email: strOrNull(raw.email), isOwner: raw.isOwner === true };
}

function parseGroup(raw: unknown): RoutingGroupWire | null {
  if (!isObject(raw) || typeof raw.key !== "string" || typeof raw.label !== "string") return null;
  return {
    key: raw.key,
    label: raw.label,
    description: strOrNull(raw.description),
    covers: stringList(raw.covers),
    mode: raw.mode === "chosen" ? "chosen" : "owner",
    userIds: stringList(raw.userIds),
    extraEmails: stringList(raw.extraEmails),
    candidates: listOf(raw.candidates, parsePerson),
    ownerEmail: strOrNull(raw.ownerEmail),
    ownerEmailIsBusiness: raw.ownerEmailIsBusiness === true,
    emailNote: strOrNull(raw.emailNote),
    ownerInAppOnly: stringList(raw.ownerInAppOnly),
    ownerIsYou: raw.ownerIsYou === true,
  };
}

function parseRouting(raw: unknown): RoutingWire | null {
  return isObject(raw) && Array.isArray(raw.groups) ? { groups: listOf(raw.groups, parseGroup) } : null;
}

const segment = (value: string) => encodeURIComponent(value);

/** The transport over HTTP, at `baseUrl` (the handler's mount). Never throws. */
export function createAlertsClient(options: TransportOptions): AlertsTransport {
  const http = createRequester(options);
  return {
    count: () => http.get("/v1/admin/count", parseCount),
    list: (q = {}) => {
      const params = new URLSearchParams();
      if (q.unread) params.set("unread", "1");
      if (q.cursor) params.set("cursor", q.cursor);
      if (q.limit !== undefined) params.set("limit", String(q.limit));
      const query = params.toString();
      return http.get(`/v1/admin/alerts${query ? `?${query}` : ""}`, parseList);
    },
    markRead: (id) => http.post(`/v1/admin/alerts/${segment(id)}/read`, {}, parseCount),
    markAllRead: () => http.post("/v1/admin/read-all", {}, parseCount),
    preferences: () => http.get("/v1/admin/preferences", parsePreferences),
    setPreference: (body) => http.post("/v1/admin/preferences", body, parsePreferences),
    routing: () => http.get("/v1/admin/routing", parseRouting),
    setRouting: (body) => http.post("/v1/admin/routing", body, parseRouting),
  };
}
