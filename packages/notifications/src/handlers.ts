import { z } from "zod";
import type { NotificationsAuditEvent } from "./audit.js";
import { createLookups, INTERNALS, NO_EMAIL_REASON, routedPeople, type Internals, type Lookups } from "./audience.js";
import {
  ALERT_NOT_FOUND_MESSAGE,
  AlertsHttpError,
  CROSS_SITE_MESSAGE,
  FORBIDDEN_MESSAGE,
  NO_PERSON_MESSAGE,
  NOT_FOUND_MESSAGE,
  failure,
  isCrossSiteRequest,
  json,
  readJsonBody,
  safeDecode,
} from "./http.js";
import { SAME_SITE_PATH } from "./links.js";
import type { AlertChannel, AlertKindSpec, AlertRoutingSpec } from "./registry.js";
import { NOTIFICATIONS_ADMIN_ROUTE_PERMISSIONS, type NotificationsAdminRouteKind } from "./routes.js";
import { AlertsInputError, type AlertPerson, type AlertReader, type AlertRow, type Notifications, type RoutingChoice } from "./types.js";
import type {
  AlertChoiceWire,
  AlertCountWire,
  AlertListWire,
  AlertWire,
  PreferencesWire,
  RoutingGroupWire,
  RoutingWire,
} from "./wire.js";

/**
 * The HTTP surface the alerts screens (`@adminigloo/notifications-widget/admin`)
 * speak: every route under `{base}/v1/admin/`, one `handle(req)` routed by the
 * path after `/v1/admin/` (Tenancy 2b-1, 4.7; 2a comms 9.5's mechanics).
 *
 *   // app/api/app/[tenantId]/alerts/[...path]/route.ts
 *   const { handle } = createNotificationHandlers({ notifications: alerts, resolveTenant, authorize });
 *   export { handle as GET, handle as POST };
 *
 * EVERY ROUTE ASKS `authorize(req, permission, tenantId)` first for its own
 * key (NOTIFICATIONS_ADMIN_ROUTE_PERMISSIONS): a `Response` (a host's 401, the
 * company gate's 403) is returned as it is, `false` is 403 forbidden, and the
 * answer must NAME THE PERSON (3.6): alerts are per person, so `true` alone
 * is refused "Sign in again to see your alerts." and reported.
 *
 * THEN THE READER (D2, review G4): the bell's routes ask once more for each
 * permission the registry names, so only the alerts this person may get NOW
 * are counted, listed, marked or offered. Those asks count only `true` or an
 * object; they never become the answer.
 *
 * NEVER CROSS-ORIGIN: no CORS headers, ever, and every POST must pass the
 * same-site check.
 */

export type NotificationsAuthorizeResult = boolean | { userId?: string | number | null } | Response;

export interface CreateNotificationHandlersOptions {
  readonly notifications: Notifications;
  /** A fixed company (a single business). Pass this or `resolveTenant`. */
  readonly tenantId?: string;
  /** The company a request is for (a company id in the path). null → 404. */
  readonly resolveTenant?: (req: Request) => string | null | Promise<string | null>;
  /**
   * Asked first for the route's permission (it must name the person: 3.6),
   * then — by `count`, `list`, `read`, `read-all` and `preferences` — once for
   * each entry of `registry.permissions`, to build the `AlertReader` (D2,
   * review G4): only the alerts this person may get NOW are counted, listed,
   * marked or offered. Those extra asks count only `true` or an object; they
   * never become the answer. The host memoises per request (2a's seams do).
   */
  readonly authorize: (req: Request, permission: string, tenantId: string) => NotificationsAuthorizeResult | Promise<NotificationsAuthorizeResult>;
  /** Paths on this site the widget links to. `messages`: where switched-off alert emails are turned back on (review BO-11). */
  readonly links?: { readonly inbox?: string | null; readonly settings?: string | null; readonly messages?: string | null };
  /**
   * Rewrites each alert's `href` on the wire (review G16), e.g. through the
   * host's company-switch route so an alert of Green Acres opens IN Green
   * Acres even if another tab switched to Summit. Must answer a same-site path
   * (D18's pattern; anything else is dropped to null and reported). Called
   * once per alert on the wire; the host memoises its own lookups per request.
   * Default: unchanged.
   */
  readonly hrefFor?: (tenantId: string, href: string) => string | Promise<string>;
  /**
   * Told about every saved change to a list in "Who hears about new work",
   * after it is saved (review SEC-04): write it to your audit log
   * (`notificationsAuditedActions` is the vocabulary). An address that starts
   * getting the emails is `alerts.routing.address-added`. A throw is reported
   * to `onError`; the change stays saved.
   */
  readonly audit?: (event: NotificationsAuditEvent) => void | Promise<void>;
  readonly onError?: (error: unknown, context: { readonly tenantId: string | null; readonly route: string }) => void;
  readonly now?: () => Date;
}

export interface NotificationHandlers {
  handle(req: Request): Promise<Response>;
}

const NOT_ON_A_LIST = "You're not on any alert lists yet. The owner chooses who hears about new work in Alert settings.";
const NO_ADDRESS_NOTE = "There's no email address on your account.";
const APP_ONLY_NOTE = "This alert is only shown in the app.";

/** Exported for the widget's words and the tests: the reachable sentence (review BO-12). */
export { NOT_ON_A_LIST as NOT_ON_A_LIST_SENTENCE };

interface Matched {
  readonly methods: Partial<Record<"GET" | "POST", NotificationsAdminRouteKind>>;
  readonly alertId?: string;
}

/** The route a path names, and the kind for each method it takes. */
function route(pathname: string): Matched | null {
  const path = pathname.replace(/\/+$/, "");
  const at = path.lastIndexOf("/v1/admin/");
  if (at < 0) return null;
  const parts = path.slice(at + "/v1/admin/".length).split("/").map(safeDecode);
  if (parts.some((part) => part === "")) return null;
  const [head, id, action] = parts;
  switch (head) {
    case "count":
      return parts.length === 1 ? { methods: { GET: "count" } } : null;
    case "read-all":
      return parts.length === 1 ? { methods: { POST: "read-all" } } : null;
    case "preferences":
      return parts.length === 1 ? { methods: { GET: "preferences", POST: "preference-set" } } : null;
    case "routing":
      return parts.length === 1 ? { methods: { GET: "routing", POST: "routing-set" } } : null;
    case "alerts":
      if (parts.length === 1) return { methods: { GET: "list" } };
      if (parts.length === 3 && action === "read") return { methods: { POST: "read" }, alertId: id as string };
      return null;
    default:
      return null;
  }
}

const preferenceSchema = z.object({
  kind: z.string().min(1, "Choose an alert.").max(64),
  channel: z.enum(["in_app", "email"], { message: "Choose In the app, or In the app and by email." }),
});
const routingSchema = z.object({
  key: z.string().min(1).max(40),
  mode: z.enum(["owner", "chosen"], { message: "Choose The owner, or These people." }),
  userIds: z.array(z.union([z.string().max(200), z.number()]).transform(String)).max(50, "Pick at most 20 people."),
  extraEmails: z.array(z.string().max(320)).max(20, "Add at most 5 addresses."),
});
const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).optional(),
  cursor: z.string().max(400).optional(),
});

/** An `authorize` answer that grants: true or an object (never a Response). */
function grants(verdict: unknown): boolean {
  return verdict === true || (typeof verdict === "object" && verdict !== null && !(verdict instanceof Response));
}

export function createNotificationHandlers(options: CreateNotificationHandlersOptions): NotificationHandlers {
  if (!options.tenantId && !options.resolveTenant) {
    throw new Error("createNotificationHandlers: pass tenantId or resolveTenant");
  }
  if (typeof options.authorize !== "function") {
    throw new Error("createNotificationHandlers: pass authorize (your permission check)");
  }
  const internals = (options.notifications as unknown as { [INTERNALS]?: Internals } | undefined)?.[INTERNALS];
  if (!internals) {
    throw new Error("createNotificationHandlers: pass notifications, the instance createNotifications(...) made");
  }
  const alerts = options.notifications;
  const registry = alerts.registry;
  const deps = internals.deps;
  const links = {
    inbox: options.links?.inbox ?? null,
    settings: options.links?.settings ?? null,
    messages: options.links?.messages ?? null,
  };
  const report = (error: unknown, tenantId: string | null, kind: string) => {
    try {
      options.onError?.(error, { tenantId, route: kind });
    } catch {
      /* a broken reporter must not turn a handled answer into a crash */
    }
  };

  /** One request's view: the reader, and memoised lookups of the host's seams. */
  interface Ctx {
    readonly req: Request;
    readonly kind: NotificationsAdminRouteKind;
    readonly tenantId: string;
    readonly userId: string;
    readonly lookups: Lookups;
    reader?: AlertReader;
    routing?: Promise<ReadonlyMap<string, RoutingChoice>>;
  }

  async function readerOf(ctx: Ctx): Promise<AlertReader> {
    if (ctx.reader) return ctx.reader;
    const asked = await Promise.all(
      registry.permissions.map(async (permission) => {
        try {
          return grants(await options.authorize(ctx.req, permission, ctx.tenantId)) ? permission : null;
        } catch (error) {
          report(error, ctx.tenantId, ctx.kind);
          return null;
        }
      }),
    );
    ctx.reader = { tenantId: ctx.tenantId, userId: ctx.userId, permissions: asked.filter((p): p is string => p !== null) };
    return ctx.reader;
  }

  function routingOf(ctx: Ctx): Promise<ReadonlyMap<string, RoutingChoice>> {
    ctx.routing ??= alerts.routing(ctx.tenantId);
    return ctx.routing;
  }

  /** The host's people for `permission`, or [] (reported) when it fails: a display must not take the screen down. */
  async function peopleOf(ctx: Ctx, permission: string): Promise<readonly AlertPerson[]> {
    try {
      return await ctx.lookups.people(ctx.tenantId, permission);
    } catch (error) {
      report(error, ctx.tenantId, ctx.kind);
      return [];
    }
  }

  /**
   * Is the reader on this routed kind's list now (chosen, or the owner
   * fallback reaching them), and do they get it as the OWNER of a list on
   * "The owner", whose copies go to the business email (review BO-1)? 4.4
   * step 3's rule, read-only, as `resolveAudience` applies it.
   */
  async function listFacts(ctx: Ctx, kind: AlertKindSpec): Promise<{ readonly onList: boolean; readonly asOwner: boolean }> {
    const group = kind.audience.routing;
    if (!group) return { onList: false, asOwner: false };
    const choice = (await routingOf(ctx)).get(group);
    const routed = routedPeople(await peopleOf(ctx, kind.audience.permission), choice);
    const me = routed.chosen.find((person) => person.userId === ctx.userId);
    if (me) return { onList: true, asOwner: routed.fallback && me.isOwner };
    // Ticked by name, though the host's people() didn't list them just now.
    return { onList: choice?.mode === "chosen" && choice.userIds.includes(ctx.userId), asOwner: false };
  }

  async function onListFor(ctx: Ctx, kind: AlertKindSpec): Promise<boolean> {
    return (await listFacts(ctx, kind)).onList;
  }

  interface KindFacts {
    readonly kind: AlertKindSpec;
    readonly holdsAudience: boolean;
    readonly viaAssigned: boolean;
    readonly onList: boolean;
    /** They get it as the owner of a list on "The owner": its email copies go to the business email. */
    readonly asOwner: boolean;
    readonly receives: boolean;
  }

  /** The kinds the reader holds a permission for, in registry order, and whether each reaches them now. */
  async function kindFacts(ctx: Ctx): Promise<KindFacts[]> {
    const held = new Set((await readerOf(ctx)).permissions);
    const facts: KindFacts[] = [];
    for (const kind of registry.kinds) {
      const holdsAudience = held.has(kind.audience.permission);
      const viaAssigned = !!kind.audience.assigned && held.has(kind.audience.assigned.permission);
      if (!holdsAudience && !viaAssigned) continue;
      const { onList, asOwner } = holdsAudience && kind.audience.routing ? await listFacts(ctx, kind) : { onList: false, asOwner: false };
      const receives = (holdsAudience && (!kind.audience.routing || onList)) || viaAssigned;
      facts.push({ kind, holdsAudience, viaAssigned, onList, asOwner, receives });
    }
    return facts;
  }

  /**
   * Reachable (review BO-12), cheapest first: a kind with no routing, an
   * assigned permission, then the routing groups (which may ask `people`).
   */
  async function reachable(ctx: Ctx): Promise<boolean> {
    const held = new Set((await readerOf(ctx)).permissions);
    const visible = registry.kinds.filter(
      (kind) => held.has(kind.audience.permission) || (kind.audience.assigned && held.has(kind.audience.assigned.permission)),
    );
    if (visible.some((kind) => !kind.audience.routing && held.has(kind.audience.permission))) return true;
    if (visible.some((kind) => kind.audience.assigned && held.has(kind.audience.assigned.permission))) return true;
    for (const kind of visible) if (held.has(kind.audience.permission) && (await onListFor(ctx, kind))) return true;
    return false;
  }

  async function countWire(ctx: Ctx): Promise<AlertCountWire> {
    const reader = await readerOf(ctx);
    const [unread, isReachable] = await Promise.all([alerts.unreadCount(reader), reachable(ctx)]);
    return { unread, reachable: isReachable };
  }

  /** `hrefFor` applied (review G16); an answer that isn't a same-site path is dropped to null and reported. */
  async function wireHref(ctx: Ctx, href: string | null): Promise<string | null> {
    if (!href) return null;
    if (!options.hrefFor) return SAME_SITE_PATH.test(href) ? href : null;
    try {
      const rewritten = await options.hrefFor(ctx.tenantId, href);
      if (typeof rewritten === "string" && SAME_SITE_PATH.test(rewritten)) return rewritten;
      report(new Error(`hrefFor answered something that isn't a path on this site for ${href}`), ctx.tenantId, ctx.kind);
      return null;
    } catch (error) {
      report(error, ctx.tenantId, ctx.kind);
      return null;
    }
  }

  async function alertWire(ctx: Ctx, row: AlertRow): Promise<AlertWire> {
    return {
      id: row.id,
      kind: row.kind,
      category: registry.kind(row.kind)?.category ?? "Alerts",
      title: row.title,
      body: row.body,
      href: await wireHref(ctx, row.href),
      at: row.createdAt.toISOString(),
      read: row.readAt !== null,
    };
  }

  /** The reader's own address (where their alert emails go), from the host's people for a permission they hold. */
  async function ownAddress(ctx: Ctx): Promise<string | null> {
    const reader = await readerOf(ctx);
    for (const permission of reader.permissions) {
      const me = (await peopleOf(ctx, permission)).find((person) => person.userId === ctx.userId);
      if (me) return me.email;
    }
    return null;
  }

  function offSentence(labels: readonly string[]): string {
    const named = labels.map((label) => `"${label}"`).join(", ");
    return labels.length > 1
      ? `Emails for these are switched off in Messages (${named}). Turn them back on there.`
      : `Emails for this are switched off in Messages (${named}). Turn it back on there.`;
  }

  async function preferencesWire(ctx: Ctx): Promise<PreferencesWire> {
    const [facts, delivery, stored, emailAddress, manage, isReachable] = await Promise.all([
      kindFacts(ctx),
      ctx.lookups.delivery(ctx.tenantId).catch((error: unknown) => {
        report(error, ctx.tenantId, ctx.kind);
        return { available: false, offReason: NO_EMAIL_REASON, offKinds: {} as Record<string, string> };
      }),
      alerts.choices({ tenantId: ctx.tenantId, userId: ctx.userId }),
      ownAddress(ctx),
      (async () => {
        try {
          return grants(await options.authorize(ctx.req, "alerts.manage", ctx.tenantId));
        } catch (error) {
          report(error, ctx.tenantId, ctx.kind);
          return false;
        }
      })(),
      reachable(ctx),
    ]);
    // Review BO-1: the owner's copies of a list on "The owner" go to the business email.
    const business = facts.some((fact) => fact.asOwner) ? await ctx.lookups.ownerEmail(ctx.tenantId) : null;
    const choices: AlertChoiceWire[] = facts.map(({ kind, onList, asOwner, viaAssigned, receives }) => {
      const emailTo = asOwner && business ? business : emailAddress;
      const offLabel = delivery.offKinds[kind.key];
      const emailOffInMessages = kind.email !== false && delivery.available && offLabel !== undefined;
      let emailNote: string | null = null;
      if (kind.email === false) emailNote = APP_ONLY_NOTE;
      else if (!delivery.available) emailNote = delivery.offReason ?? NO_EMAIL_REASON;
      else if (offLabel !== undefined) emailNote = offSentence([offLabel]);
      else if (!emailTo) emailNote = NO_ADDRESS_NOTE;
      const emailOffered = emailNote === null;
      const group = kind.audience.routing ? registry.routing(kind.audience.routing) : undefined;
      const channel = stored.get(kind.key) ?? kind.defaultChannel;
      return {
        kind: kind.key,
        label: kind.label,
        description: kind.description ?? null,
        category: kind.category,
        // What really happens now: an email choice that can't go shows as in the app.
        channel: emailOffered ? channel : "in_app",
        emailOffered,
        emailNote,
        emailOffInMessages,
        routed: group ? { group: group.label, onList, viaAssigned } : null,
        receives,
        emailTo,
      };
    });
    const categories: string[] = [];
    for (const choice of choices) if (!categories.includes(choice.category)) categories.push(choice.category);
    return {
      emailAddress,
      emailAvailable: delivery.available,
      emailOffReason: delivery.available ? null : (delivery.offReason ?? NO_EMAIL_REASON),
      categories,
      choices,
      canManageRouting: manage,
      reachable: isReachable,
      links: { messages: links.messages },
    };
  }

  async function routingWire(ctx: Ctx): Promise<RoutingWire> {
    const [rows, delivery, business] = await Promise.all([
      routingOf(ctx),
      ctx.lookups.delivery(ctx.tenantId).catch((error: unknown) => {
        report(error, ctx.tenantId, ctx.kind);
        return { available: false, offReason: NO_EMAIL_REASON, offKinds: {} as Record<string, string> };
      }),
      ctx.lookups.ownerEmail(ctx.tenantId),
    ]);
    const ownerChoices = new Map<string, Promise<ReadonlyMap<string, AlertChannel>>>();
    const choicesOf = (userId: string) => {
      let found = ownerChoices.get(userId);
      if (!found) {
        found = alerts.choices({ tenantId: ctx.tenantId, userId });
        ownerChoices.set(userId, found);
      }
      return found;
    };
    const groups: RoutingGroupWire[] = [];
    for (const group of registry.routings as readonly AlertRoutingSpec[]) {
      const covered = registry.kinds.filter((kind) => kind.audience.routing === group.key);
      const candidates = await peopleOf(ctx, group.permission);
      let owner = candidates.find((person) => person.isOwner);
      for (const kind of covered) {
        if (owner) break;
        owner = (await peopleOf(ctx, kind.audience.permission)).find((person) => person.isOwner);
      }
      const row = rows.get(group.key);
      const candidateIds = new Set(candidates.map((person) => person.userId));
      const offLabels = [...new Set(covered.map((kind) => delivery.offKinds[kind.key]).filter((label): label is string => typeof label === "string"))];
      const ownerOwn = owner?.email ?? null;
      // Review BO-1: while on "The owner", the owner's own channel decides
      // whether the business mailbox gets each kind; say which it won't.
      const stored = owner ? await choicesOf(owner.userId) : null;
      const ownerInAppOnly = stored
        ? covered
            .filter((kind) => kind.email !== false && delivery.offKinds[kind.key] === undefined && (stored.get(kind.key) ?? kind.defaultChannel) === "in_app")
            .map((kind) => kind.label)
        : [];
      groups.push({
        key: group.key,
        label: group.label,
        description: group.description ?? null,
        covers: covered.map((kind) => kind.label),
        mode: row?.mode ?? "owner",
        // Only people who can still be picked are ticked: no id of someone gone.
        userIds: (row?.userIds ?? []).filter((id) => candidateIds.has(id)),
        extraEmails: [...(row?.extraEmails ?? [])],
        candidates: candidates.map((person) => ({ userId: person.userId, name: person.name, email: person.email, isOwner: person.isOwner })),
        ownerEmail: business ?? ownerOwn,
        ownerEmailIsBusiness: business !== null && (ownerOwn === null || business.toLowerCase() !== ownerOwn.toLowerCase()),
        emailNote: delivery.available && offLabels.length > 0 ? offSentence(offLabels) : null,
        ownerInAppOnly,
        ownerIsYou: owner !== undefined && owner.userId === ctx.userId,
      });
    }
    return { groups };
  }

  /**
   * Review SEC-04: one audit event per saved list, after the save. An address
   * "gets the emails" only while its list is on "These people" (on "The
   * owner" the saved addresses wait, unused), so that is what added and
   * removed compare.
   */
  async function auditRouting(ctx: Ctx, key: string, before: RoutingChoice | undefined, saved: RoutingChoice): Promise<void> {
    if (!options.audit) return;
    const active = (choice: RoutingChoice | undefined) => (choice?.mode === "chosen" ? choice.extraEmails.map((address) => address.toLowerCase()) : []);
    const was = active(before);
    const now = active(saved);
    const addedAddresses = now.filter((address) => !was.includes(address));
    const removedAddresses = was.filter((address) => !now.includes(address));
    const event: NotificationsAuditEvent = {
      action: addedAddresses.length > 0 ? "alerts.routing.address-added" : "alerts.routing.changed",
      actorUserId: ctx.userId,
      tenantId: ctx.tenantId,
      resourceType: "alerts_routing",
      resourceId: key,
      metadata: {
        group: registry.routing(key)?.label ?? key,
        mode: saved.mode,
        people: saved.mode === "chosen" ? saved.userIds.length : 0,
        addresses: now,
        addedAddresses,
        removedAddresses,
      },
    };
    try {
      await options.audit(event);
    } catch (error) {
      report(error, ctx.tenantId, ctx.kind);
    }
  }

  function inputFailure(error: AlertsInputError): AlertsHttpError {
    return new AlertsHttpError(
      "invalid",
      error.message,
      error.issues.map((issue) => ({ path: [...issue.path], message: issue.message })),
    );
  }

  async function dispatch(ctx: Ctx, matched: Matched): Promise<Response> {
    switch (ctx.kind) {
      case "count":
        return json(await countWire(ctx));
      case "list": {
        const url = new URL(ctx.req.url);
        const query = listQuerySchema.safeParse({
          limit: url.searchParams.get("limit") || undefined,
          cursor: url.searchParams.get("cursor") || undefined,
        });
        if (!query.success) {
          throw new AlertsHttpError("invalid", "Some details need another look.", [{ path: ["limit"], message: "Ask for 1 to 50 alerts." }]);
        }
        const reader = await readerOf(ctx);
        let page;
        try {
          page = await alerts.list({
            ...reader,
            unreadOnly: url.searchParams.get("unread") === "1",
            cursor: query.data.cursor ?? null,
            ...(query.data.limit !== undefined ? { limit: query.data.limit } : {}),
          });
        } catch (error) {
          if (error instanceof AlertsInputError) throw inputFailure(error);
          throw error;
        }
        const [wired, count] = await Promise.all([Promise.all(page.alerts.map((row) => alertWire(ctx, row))), countWire(ctx)]);
        const body: AlertListWire = {
          alerts: wired,
          nextCursor: page.nextCursor,
          unread: count.unread,
          reachable: count.reachable,
          links: { inbox: links.inbox, settings: links.settings },
        };
        return json(body);
      }
      case "read": {
        await readJsonBody(ctx.req);
        const reader = await readerOf(ctx);
        const outcome = await alerts.markRead({ ...reader, alertId: matched.alertId ?? "" });
        if (outcome === "not_found") throw new AlertsHttpError("not_found", ALERT_NOT_FOUND_MESSAGE);
        return json(await countWire(ctx));
      }
      case "read-all": {
        await readJsonBody(ctx.req);
        await alerts.markAllRead(await readerOf(ctx));
        return json(await countWire(ctx));
      }
      case "preferences":
        return json(await preferencesWire(ctx));
      case "preference-set": {
        const body = preferenceSchema.parse(await readJsonBody(ctx.req));
        // Only a kind this person is offered may be set, and email only where it can go.
        const before = await preferencesWire(ctx);
        const offered = before.choices.find((choice) => choice.kind === body.kind);
        if (!offered) {
          throw new AlertsHttpError("invalid", "That isn't an alert you can choose for.", [{ path: ["kind"], message: "That isn't an alert you can choose for." }]);
        }
        if (body.channel === "email" && !offered.emailOffered) {
          const note = offered.emailNote ?? APP_ONLY_NOTE;
          throw new AlertsHttpError("invalid", note, [{ path: ["channel"], message: note }]);
        }
        try {
          await alerts.setChoice({ tenantId: ctx.tenantId, userId: ctx.userId, kind: body.kind, channel: body.channel });
        } catch (error) {
          if (error instanceof AlertsInputError) throw inputFailure(error);
          throw error;
        }
        return json(await preferencesWire(ctx));
      }
      case "routing":
        return json(await routingWire(ctx));
      case "routing-set": {
        const body = routingSchema.parse(await readJsonBody(ctx.req));
        const before = options.audit ? (await routingOf(ctx)).get(body.key) : undefined;
        let saved: RoutingChoice;
        try {
          saved = await alerts.setRouting({
            tenantId: ctx.tenantId,
            routing: body.key,
            mode: body.mode,
            userIds: body.userIds,
            extraEmails: body.extraEmails,
            by: ctx.userId,
          });
        } catch (error) {
          if (error instanceof AlertsInputError) throw inputFailure(error);
          throw error;
        }
        ctx.routing = undefined;
        await auditRouting(ctx, body.key, before, saved);
        return json(await routingWire(ctx));
      }
    }
  }

  async function handle(req: Request): Promise<Response> {
    // No CORS headers, ever: the staff API is same-origin only.
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
    const matched = route(new URL(req.url).pathname);
    if (!matched) return failure(new AlertsHttpError("not_found", NOT_FOUND_MESSAGE));
    const kind = matched.methods[req.method as "GET" | "POST"];
    if (!kind) {
      const allow = Object.keys(matched.methods).join(", ");
      return json({ error: { code: "invalid", message: `Use ${allow} for this address.` } }, 405, { allow });
    }
    if (req.method === "POST" && isCrossSiteRequest(req)) {
      return failure(new AlertsHttpError("cross_site", CROSS_SITE_MESSAGE));
    }
    let tenantId: string | null = null;
    try {
      tenantId = options.resolveTenant ? await options.resolveTenant(req) : (options.tenantId ?? null);
      if (!tenantId) return failure(new AlertsHttpError("not_found", NOT_FOUND_MESSAGE));
      const verdict = await options.authorize(req, NOTIFICATIONS_ADMIN_ROUTE_PERMISSIONS[kind], tenantId);
      if (verdict instanceof Response) return verdict;
      if (verdict === false || verdict === null || verdict === undefined) {
        return failure(new AlertsHttpError("forbidden", FORBIDDEN_MESSAGE));
      }
      const raw = typeof verdict === "object" ? verdict.userId : undefined;
      const userId = typeof raw === "number" || (typeof raw === "string" && raw !== "") ? String(raw) : null;
      if (!userId) {
        // 3.6: alerts are per person; a grant that names nobody can't read any.
        report(new Error("authorize granted the route but named no person (return { userId })"), tenantId, "authorize");
        return failure(new AlertsHttpError("forbidden", NO_PERSON_MESSAGE));
      }
      const ctx: Ctx = { req, kind, tenantId, userId, lookups: createLookups(deps, false) };
      return await dispatch(ctx, matched);
    } catch (error) {
      if (!(error instanceof AlertsHttpError) && !(error instanceof z.ZodError)) report(error, tenantId, kind);
      return failure(error);
    }
  }

  return { handle };
}
