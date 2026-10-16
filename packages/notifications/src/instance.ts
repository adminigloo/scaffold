import { and, asc, desc, eq, inArray, isNotNull, isNull, lt, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { cleanAddress, createLookups, INTERNALS, resolveAudience, type Audience, type Deps, type Internals } from "./audience.js";
import { newId } from "./columns.js";
import { claimEmails, deliverPendingEmails, pool, releaseClaim, sendCopy, SEND_CONCURRENCY, type CopyToSend } from "./email.js";
import { LINE_BREAKS, SAME_SITE_PATH } from "./links.js";
import { prunedFilter, prunedKinds, readerFilter, readerKinds } from "./reader.js";
import type { AlertChannel } from "./registry.js";
import {
  AlertsInputError,
  type AlertDraft,
  type AlertReader,
  type AlertRow,
  type CleanupOptions,
  type CreateNotificationsOptions,
  type Notifications,
  type NotifyReport,
  type RoutingChoice,
} from "./types.js";

/**
 * `createNotifications` (Tenancy 2b-1, 4.3): the alerts of each company, for
 * each person in it.
 *
 * 0.1's three rules carry into 0.2:
 *
 * FAN-OUT AT WRITE TIME. `notify` works out who gets an alert from who holds
 * what NOW and writes one row each; a poll never re-answers the question.
 *
 * READS ARE SCOPED IN THE WHERE CLAUSE, not by trusting the caller: every
 * read, mark and delete names the company AND the person, so a guessed id
 * belonging to anyone else touches nothing. 0.2 adds: reads narrow to what
 * the reader may get NOW (D2, review G4; ./reader.ts).
 *
 * NOTIFYING MUST NEVER BREAK THE THING IT ANNOUNCES. `notify` never throws:
 * a lead that fails to save because its alert insert failed has inverted its
 * job. Every failed step goes to `onError`, and the report says what
 * happened.
 */

const ROUTING_MAX_PEOPLE = 20;
const ROUTING_MAX_ADDRESSES = 5;
const LIST_DEFAULT = 20;
const LIST_MAX = 50;
const CLEANUP_BATCH = 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

const sameSitePath = z.string().regex(SAME_SITE_PATH, "Use a path on this site, starting with a single /.");

/** 3.3's limits, at the boundary (D18). */
const draftSchema = z.object({
  tenantId: z.string().min(1).max(200),
  kind: z.string().min(1).max(64),
  title: z
    .string()
    .min(1)
    .max(200)
    .refine((value) => !LINE_BREAKS.test(value), "A title is one line."),
  body: z.string().max(2000).nullable().optional(),
  href: sameSitePath.nullable().optional(),
  assignedHref: sameSitePath.nullable().optional(),
  dedupeKey: z.string().min(1).max(200),
  subject: z
    .object({ type: z.string().min(1).max(80), id: z.string().min(1).max(200) })
    .nullable()
    .optional(),
  actorUserId: z.union([z.string().max(200), z.number()]).nullable().optional(),
  assignedUserIds: z.array(z.union([z.string().min(1).max(200), z.number()])).max(500).optional(),
  replyTo: z.string().max(320).nullable().optional(),
});

/** One row as notify writes it, before the insert. */
interface PlannedRow {
  readonly id: string;
  readonly tenantId: string;
  readonly recipientId: string;
  readonly reachedVia: "audience" | "assigned" | "address";
  readonly kind: string;
  readonly title: string;
  readonly body: string | null;
  readonly href: string | null;
  readonly dedupeKey: string;
  readonly subjectType: string | null;
  readonly subjectId: string | null;
  readonly actorId: string | null;
  readonly readAt: Date | null;
  readonly createdAt: Date;
  readonly emailStatus: "none" | "pending" | "owed";
  readonly emailTo: string | null;
  readonly emailNextAt: Date | null;
  // Not stored: what the email copy needs if it goes now.
  readonly recipientName: string | null;
  readonly replyTo: string | null;
}

function cursorOf(row: { createdAt: Date; id: string }): string {
  const json = JSON.stringify({ c: row.createdAt.toISOString(), i: row.id });
  return btoa(json).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function readCursor(cursor: string): { c: Date; i: string } {
  const bad = () => new AlertsInputError("That page link doesn't work any more. Start again from the top.", [{ path: ["cursor"], message: "Start again from the top." }]);
  try {
    if (!/^[A-Za-z0-9_-]{1,400}$/.test(cursor)) throw bad();
    const padded = cursor.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((cursor.length + 3) % 4);
    const value = JSON.parse(atob(padded)) as { c?: unknown; i?: unknown };
    const when = typeof value.c === "string" ? new Date(value.c) : null;
    if (!when || Number.isNaN(when.getTime()) || typeof value.i !== "string" || value.i.length === 0 || value.i.length > 100) throw bad();
    return { c: when, i: value.i };
  } catch (error) {
    if (error instanceof AlertsInputError) throw error;
    throw bad();
  }
}

const readerSchema = z.object({
  tenantId: z.string().min(1).max(200),
  userId: z.union([z.string().min(1).max(200), z.number()]).transform(String),
  permissions: z.array(z.string()).max(1000),
});

function parseReader(input: AlertReader): { tenantId: string; userId: string; permissions: string[] } {
  const parsed = readerSchema.safeParse({ ...input, permissions: Array.isArray(input?.permissions) ? [...input.permissions] : input?.permissions });
  if (!parsed.success) throw new AlertsInputError("Who is reading isn't clear.", [{ path: ["reader"], message: "Pass tenantId, userId and permissions." }]);
  return parsed.data;
}

export function createNotifications(options: CreateNotificationsOptions): Notifications {
  if (!options || !options.db) throw new Error("createNotifications: pass db (your drizzle database)");
  if (!options.tables || !options.tables.alerts || !options.tables.choices || !options.tables.routing) {
    // D14, review G1: never a host's own `notifications` table by default.
    throw new Error("createNotifications: pass tables (notificationTables for the 0.1 names, or defineNotificationTables({ prefix, schema }))");
  }
  if (!options.registry || typeof options.registry.kind !== "function") {
    throw new Error("createNotifications: pass registry (defineAlertRegistry([...the installed packages' fragments]))");
  }
  if (typeof options.people !== "function") throw new Error("createNotifications: pass people (who in a company holds a permission)");

  const onError =
    options.onError ??
    ((error: unknown, context: { tenantId: string | null; kind?: string; step: string }) => {
      console.error("[@adminigloo/notifications]", context.step, context, error);
    });
  const deps: Deps = {
    db: options.db,
    tables: options.tables,
    registry: options.registry,
    people: options.people,
    ownerEmail: options.ownerEmail,
    email: options.email,
    emailIdempotent: options.emailIdempotent === true,
    emailDelivery: options.emailDelivery,
    sendTimeoutMs: typeof options.sendTimeoutMs === "number" && options.sendTimeoutMs >= 0 ? options.sendTimeoutMs : 8000,
    clock: () => options.now?.() ?? new Date(),
    report: (error, context) => {
      try {
        onError(error, context);
      } catch {
        /* a broken reporter must not turn a handled failure into a crash */
      }
    },
  };
  const db = options.db;
  const registry = options.registry;
  const A = options.tables.alerts;
  const C = options.tables.choices;
  const R = options.tables.routing;

  // -------------------------------------------------------------------------
  // notify

  async function notify(drafts: AlertDraft | readonly AlertDraft[]): Promise<NotifyReport> {
    const report = { alerted: 0, duplicates: 0, emailed: 0, emailsFailed: 0, emailsLater: 0, problems: [] as string[] };
    try {
      const list = Array.isArray(drafts) ? (drafts as readonly AlertDraft[]) : [drafts as AlertDraft];
      const now = deps.clock();
      const lookups = createLookups(deps, false);
      const planned: PlannedRow[] = [];

      for (const raw of list) {
        // 1. Each draft through zod; a refused draft is a problem, the rest go on.
        const parsed = draftSchema.safeParse(raw);
        if (!parsed.success) {
          const issue = parsed.error.issues[0];
          const where = issue?.path.filter((p): p is string | number => typeof p !== "symbol").join(".") || "draft";
          report.problems.push(`refused draft (${where}: ${issue?.message ?? "invalid"})`);
          continue;
        }
        const draft = parsed.data;
        const spec = registry.kind(draft.kind);
        if (!spec) {
          report.problems.push(`unknown alert kind ${draft.kind}`);
          continue;
        }
        // 2. Recipients (4.4).
        let audience: Audience;
        try {
          audience = await resolveAudience(
            deps,
            lookups,
            {
              tenantId: draft.tenantId,
              spec,
              actorUserId: draft.actorUserId === null || draft.actorUserId === undefined ? null : String(draft.actorUserId),
              assignedUserIds: (draft.assignedUserIds ?? []).map(String),
            },
            false,
          );
        } catch (error) {
          deps.report(error, { tenantId: draft.tenantId, kind: draft.kind, step: "people" });
          report.problems.push(`couldn't work out who gets ${draft.kind} (people failed)`);
          continue;
        }
        if (audience.noOwner) {
          deps.report(new Error(`No owner among the people who may get ${draft.kind}; everyone who holds ${spec.audience.permission} got it.`), {
            tenantId: draft.tenantId,
            kind: draft.kind,
            step: "no-owner",
          });
        }
        if (audience.people.length === 0 && audience.addresses.length === 0) {
          report.problems.push(`nobody gets ${draft.kind} in this company`);
          continue;
        }
        const producer = spec.emailBy === "producer";
        const href = draft.href ?? null;
        const assignedHref = draft.assignedHref !== undefined ? draft.assignedHref : href;
        const base = {
          tenantId: draft.tenantId,
          kind: draft.kind,
          title: draft.title,
          body: draft.body ?? null,
          dedupeKey: draft.dedupeKey,
          subjectType: draft.subject?.type ?? null,
          subjectId: draft.subject?.id ?? null,
          actorId: draft.actorUserId === null || draft.actorUserId === undefined ? null : String(draft.actorUserId),
          createdAt: now,
          replyTo: cleanAddress(draft.replyTo),
        };
        for (const person of audience.people) {
          // A producer kind's office copy is the producer's own email (D6);
          // crew reached only through `assigned` get notifications' copy,
          // linking to their own page (review BO-03).
          const status = !person.emailCopy ? "none" : producer && person.reachedVia === "audience" ? "owed" : "pending";
          planned.push({
            ...base,
            id: newId(),
            recipientId: person.userId,
            reachedVia: person.reachedVia,
            href: person.reachedVia === "assigned" ? (assignedHref ?? null) : href,
            readAt: null,
            emailStatus: status,
            emailTo: person.emailCopy ? person.emailTo : null,
            emailNextAt: status === "pending" ? now : null,
            recipientName: person.name,
          });
        }
        for (const address of audience.addresses) {
          // An address with no email copy would be a row nobody ever sees.
          if (!address.emailCopy) continue;
          const status = producer ? "owed" : "pending";
          planned.push({
            ...base,
            id: newId(),
            recipientId: `email:${address.address.toLowerCase()}`,
            reachedVia: "address",
            href,
            // Born read: no bell ever shows it (D2).
            readAt: now,
            emailStatus: status,
            emailTo: address.address,
            emailNextAt: status === "pending" ? now : null,
            recipientName: null,
          });
        }
      }

      // The same fact twice in one call is one row (D7), counted as a duplicate.
      const unique: PlannedRow[] = [];
      const keys = new Set<string>();
      for (const row of planned) {
        const key = `${row.tenantId}\u0000${row.recipientId}\u0000${row.dedupeKey}`;
        if (keys.has(key)) {
          if (row.reachedVia !== "address") report.duplicates += 1;
          continue;
        }
        keys.add(key);
        unique.push(row);
      }
      if (unique.length === 0) return report;

      // 3. ONE insert for the whole call; a row the dedupe key already had is
      // not returned, and gets no email (D7).
      let inserted: { id: string; emailStatus: string }[];
      try {
        inserted = (await db
          .insert(A)
          .values(
            unique.map((row) => ({
              id: row.id,
              tenantId: row.tenantId,
              recipientId: row.recipientId,
              reachedVia: row.reachedVia,
              kind: row.kind,
              title: row.title,
              body: row.body,
              href: row.href,
              dedupeKey: row.dedupeKey,
              subjectType: row.subjectType,
              subjectId: row.subjectId,
              actorId: row.actorId,
              readAt: row.readAt,
              createdAt: row.createdAt,
              emailStatus: row.emailStatus,
              emailTo: row.emailTo,
              emailNextAt: row.emailNextAt,
            })),
          )
          .onConflictDoNothing({ target: [A.tenantId, A.recipientId, A.dedupeKey] })
          .returning({ id: A.id, emailStatus: A.emailStatus })) as { id: string; emailStatus: string }[];
      } catch (error) {
        // 5. The report says nothing was alerted.
        deps.report(error, { tenantId: unique[0]?.tenantId ?? null, kind: unique[0]?.kind, step: "write" });
        report.problems.push("the alerts couldn't be written");
        report.duplicates = 0;
        return report;
      }
      const wrote = new Set(inserted.map((row) => row.id));
      for (const row of unique) {
        if (row.reachedVia === "address") continue;
        if (wrote.has(row.id)) report.alerted += 1;
        else report.duplicates += 1;
      }

      // 4. Every returned `pending` row is claimed and sent now.
      const pendingIds = inserted.filter((row) => row.emailStatus === "pending").map((row) => row.id);
      if (pendingIds.length === 0) return report;
      let claimed: { id: string; emailAttempts: number }[] = [];
      try {
        claimed = (await db
          .update(A)
          .set({ emailStatus: "sending", emailClaimedAt: deps.clock(), emailAttempts: sql`${A.emailAttempts} + 1` })
          .where(and(inArray(A.id, pendingIds), eq(A.emailStatus, "pending")))
          .returning({ id: A.id, emailAttempts: A.emailAttempts })) as { id: string; emailAttempts: number }[];
      } catch (error) {
        // Left `pending`: the cron sends them.
        deps.report(error, { tenantId: unique[0]?.tenantId ?? null, step: "email-claim" });
        report.emailsLater += pendingIds.length;
        return report;
      }
      const byId = new Map(unique.map((row) => [row.id, row] as const));
      const copies: CopyToSend[] = [];
      for (const claim of claimed) {
        const row = byId.get(claim.id);
        if (!row || !row.emailTo) continue;
        copies.push({
          id: row.id,
          tenantId: row.tenantId,
          kind: row.kind,
          to: row.emailTo,
          recipientName: row.recipientName,
          addressOnly: row.reachedVia === "address",
          title: row.title,
          body: row.body,
          href: row.href,
          replyTo: row.replyTo,
          attempts: claim.emailAttempts,
        });
      }
      await pool(copies, SEND_CONCURRENCY, async (copy) => {
        const outcome = await sendCopy(deps, copy, null);
        if (outcome === "sent") report.emailed += 1;
        else if (outcome === "failed") report.emailsFailed += 1;
        else if (outcome === "retrying" || outcome === "later") report.emailsLater += 1;
      });
      return report;
    } catch (error) {
      // Never throws (4.5 step 5).
      deps.report(error, { tenantId: null, step: "notify" });
      report.problems.push("notify failed");
      return report;
    }
  }

  // -------------------------------------------------------------------------
  // reads (D2, review G4)

  function readerWhere(reader: { tenantId: string; userId: string; permissions: readonly string[] }): SQL {
    return and(
      eq(A.tenantId, reader.tenantId),
      eq(A.recipientId, reader.userId),
      readerFilter(options.tables, readerKinds(registry, reader.permissions)),
    ) as SQL;
  }

  function toRow(row: {
    id: string;
    tenantId: string;
    recipientId: string;
    kind: string;
    title: string;
    body: string | null;
    href: string | null;
    subjectType: string | null;
    subjectId: string | null;
    readAt: Date | null;
    createdAt: Date;
  }): AlertRow {
    return {
      id: row.id,
      tenantId: row.tenantId,
      recipientId: row.recipientId,
      kind: row.kind,
      title: row.title,
      body: row.body,
      href: row.href,
      subject: row.subjectType && row.subjectId ? { type: row.subjectType, id: row.subjectId } : null,
      readAt: row.readAt,
      createdAt: row.createdAt,
    };
  }

  async function list(input: AlertReader & { readonly unreadOnly?: boolean; readonly cursor?: string | null; readonly limit?: number }) {
    const reader = parseReader(input);
    const limit = Math.max(1, Math.min(LIST_MAX, Math.trunc(Number.isFinite(input.limit) ? (input.limit as number) : LIST_DEFAULT)));
    const conditions: (SQL | undefined)[] = [readerWhere(reader)];
    if (input.unreadOnly) conditions.push(isNull(A.readAt));
    if (input.cursor) {
      const at = readCursor(input.cursor);
      // Newest first: the next page is strictly older than the last row, ties by id.
      conditions.push(or(lt(A.createdAt, at.c), and(eq(A.createdAt, at.c), lt(A.id, at.i))));
    }
    const rows = (await db
      .select({
        id: A.id,
        tenantId: A.tenantId,
        recipientId: A.recipientId,
        kind: A.kind,
        title: A.title,
        body: A.body,
        href: A.href,
        subjectType: A.subjectType,
        subjectId: A.subjectId,
        readAt: A.readAt,
        createdAt: A.createdAt,
      })
      .from(A)
      .where(and(...conditions))
      .orderBy(desc(A.createdAt), desc(A.id))
      .limit(limit + 1)) as Parameters<typeof toRow>[0][];
    const page = rows.slice(0, limit).map(toRow);
    const last = page[page.length - 1];
    return { alerts: page, nextCursor: rows.length > limit && last ? cursorOf(last) : null };
  }

  /** Its own query (0.1's reason: it runs on every poll), with the list's filter, so the badge and the list never disagree. */
  async function unreadCount(input: AlertReader): Promise<number> {
    const reader = parseReader(input);
    const [row] = (await db
      .select({ n: sql<number>`count(*)::int` })
      .from(A)
      .where(and(readerWhere(reader), isNull(A.readAt)))) as { n: number }[];
    return Number(row?.n ?? 0);
  }

  async function markRead(input: AlertReader & { readonly alertId: string }): Promise<"marked" | "already" | "not_found"> {
    const reader = parseReader(input);
    if (typeof input.alertId !== "string" || input.alertId.length === 0 || input.alertId.length > 100) return "not_found";
    const marked = (await db
      .update(A)
      .set({ readAt: deps.clock() })
      // `reached_via is not null`: a package-only column in every update (D14).
      .where(and(eq(A.id, input.alertId), readerWhere(reader), isNull(A.readAt), isNotNull(A.reachedVia)))
      .returning({ id: A.id })) as { id: string }[];
    if (marked.length > 0) return "marked";
    const [seen] = await db
      .select({ id: A.id })
      .from(A)
      .where(and(eq(A.id, input.alertId), readerWhere(reader)))
      .limit(1);
    return seen ? "already" : "not_found";
  }

  async function markAllRead(input: AlertReader): Promise<number> {
    const reader = parseReader(input);
    const marked = (await db
      .update(A)
      .set({ readAt: deps.clock() })
      .where(and(readerWhere(reader), isNull(A.readAt), isNotNull(A.reachedVia)))
      .returning({ id: A.id })) as { id: string }[];
    return marked.length;
  }

  // -------------------------------------------------------------------------
  // choices (D5)

  async function choices(input: { readonly tenantId: string; readonly userId: string }): Promise<ReadonlyMap<string, AlertChannel>> {
    const rows = (await db
      .select({ kind: C.kind, channel: C.channel })
      .from(C)
      .where(and(eq(C.tenantId, input.tenantId), eq(C.userId, String(input.userId))))
      .orderBy(asc(C.kind))) as { kind: string; channel: string }[];
    return new Map(rows.map((row) => [row.kind, row.channel === "email" ? "email" : "in_app"] as const));
  }

  async function setChoice(input: { readonly tenantId: string; readonly userId: string; readonly kind: string; readonly channel: AlertChannel }): Promise<void> {
    const spec = typeof input.kind === "string" ? registry.kind(input.kind) : undefined;
    if (!spec) throw new AlertsInputError("That isn't an alert you can choose for.", [{ path: ["kind"], message: "That isn't an alert you can choose for." }]);
    if (input.channel !== "in_app" && input.channel !== "email") {
      throw new AlertsInputError("Choose In the app, or In the app and by email.", [{ path: ["channel"], message: "Choose In the app, or In the app and by email." }]);
    }
    if (input.channel === "email" && spec.email === false) {
      throw new AlertsInputError("This alert is only shown in the app.", [{ path: ["channel"], message: "This alert is only shown in the app." }]);
    }
    if (typeof input.tenantId !== "string" || input.tenantId === "" || String(input.userId ?? "") === "") {
      throw new AlertsInputError("Who is choosing isn't clear.", [{ path: ["userId"], message: "Sign in again." }]);
    }
    const now = deps.clock();
    await db
      .insert(C)
      .values({ tenantId: input.tenantId, userId: String(input.userId), kind: spec.key, channel: input.channel, updatedAt: now })
      .onConflictDoUpdate({ target: [C.tenantId, C.userId, C.kind], set: { channel: input.channel, updatedAt: now } });
  }

  // -------------------------------------------------------------------------
  // routing (D4)

  async function routing(tenantId: string): Promise<ReadonlyMap<string, RoutingChoice>> {
    const rows = (await db
      .select({ routing: R.routing, mode: R.mode, userIds: R.userIds, extraEmails: R.extraEmails, updatedAt: R.updatedAt })
      .from(R)
      .where(eq(R.tenantId, tenantId))) as { routing: string; mode: string; userIds: string[] | null; extraEmails: string[] | null; updatedAt: Date }[];
    return new Map(
      rows.map((row) => [
        row.routing,
        {
          mode: row.mode === "chosen" ? "chosen" : "owner",
          userIds: [...(row.userIds ?? [])],
          extraEmails: [...(row.extraEmails ?? [])],
          updatedAt: row.updatedAt ?? null,
        } satisfies RoutingChoice,
      ]),
    );
  }

  async function setRouting(input: {
    readonly tenantId: string;
    readonly routing: string;
    readonly mode: "owner" | "chosen";
    readonly userIds: readonly string[];
    readonly extraEmails: readonly string[];
    readonly by: string;
  }): Promise<RoutingChoice> {
    const group = typeof input.routing === "string" ? registry.routing(input.routing) : undefined;
    if (!group) throw new AlertsInputError("That isn't one of the alert lists.", [{ path: ["key"], message: "That isn't one of the alert lists." }]);
    if (input.mode !== "owner" && input.mode !== "chosen") {
      throw new AlertsInputError("Choose The owner, or These people.", [{ path: ["mode"], message: "Choose The owner, or These people." }]);
    }
    const issues: { path: (string | number)[]; message: string }[] = [];
    const userIds = [...new Set((Array.isArray(input.userIds) ? input.userIds : []).map((id) => String(id)))];
    if (userIds.length > ROUTING_MAX_PEOPLE) issues.push({ path: ["userIds"], message: `Pick at most ${ROUTING_MAX_PEOPLE} people.` });
    const extraEmails: string[] = [];
    const rawEmails = Array.isArray(input.extraEmails) ? input.extraEmails : [];
    for (const [index, raw] of rawEmails.entries()) {
      const address = cleanAddress(raw);
      if (!address) {
        issues.push({ path: ["extraEmails", index], message: "That doesn't look like an email address." });
        continue;
      }
      if (!extraEmails.some((existing) => existing.toLowerCase() === address.toLowerCase())) extraEmails.push(address.toLowerCase());
    }
    if (extraEmails.length > ROUTING_MAX_ADDRESSES) issues.push({ path: ["extraEmails"], message: `Add at most ${ROUTING_MAX_ADDRESSES} addresses.` });
    if (userIds.length > 0 && userIds.length <= ROUTING_MAX_PEOPLE) {
      // Only members holding the group's permission may be chosen. The
      // issue never names the id (an id of A's sent by B is not echoed).
      const holders = new Set((await deps.people(input.tenantId, group.permission)).map((person) => String(person.userId)));
      if (userIds.some((id) => !holders.has(id))) issues.push({ path: ["userIds"], message: "Pick people from your company." });
    }
    if (issues.length > 0) throw new AlertsInputError(issues[0]!.message, issues);
    const now = deps.clock();
    const values = {
      tenantId: input.tenantId,
      routing: group.key,
      mode: input.mode,
      userIds,
      extraEmails,
      updatedAt: now,
      updatedBy: input.by ? String(input.by) : null,
    };
    await db
      .insert(R)
      .values(values)
      .onConflictDoUpdate({
        target: [R.tenantId, R.routing],
        set: { mode: values.mode, userIds: values.userIds, extraEmails: values.extraEmails, updatedAt: now, updatedBy: values.updatedBy },
      });
    return { mode: input.mode, userIds, extraEmails, updatedAt: now };
  }

  // -------------------------------------------------------------------------
  // housekeeping (D9)

  async function forget(input: { readonly tenantId: string; readonly userId: string }) {
    const userId = String(input.userId);
    const alerts = (await db
      .delete(A)
      .where(and(eq(A.tenantId, input.tenantId), eq(A.recipientId, userId), isNotNull(A.reachedVia)))
      .returning({ id: A.id })) as { id: string }[];
    const choiceRows = (await db
      .delete(C)
      .where(and(eq(C.tenantId, input.tenantId), eq(C.userId, userId)))
      .returning({ kind: C.kind })) as { kind: string }[];
    const routings = (await db
      .update(R)
      .set({ userIds: sql`array_remove(${R.userIds}, ${userId})`, updatedAt: deps.clock() })
      .where(and(eq(R.tenantId, input.tenantId), sql`${userId} = any(${R.userIds})`))
      .returning({ routing: R.routing })) as { routing: string }[];
    return { alerts: alerts.length, choices: choiceRows.length, routings: routings.length };
  }

  async function prune(input: { readonly tenantId: string; readonly userId: string; readonly permissions: readonly string[] }) {
    try {
      const userId = String(input.userId);
      const permissions = Array.isArray(input.permissions) ? input.permissions : [];
      const gone = prunedKinds(registry, permissions);
      const alerts = (await db
        .delete(A)
        .where(and(eq(A.tenantId, input.tenantId), eq(A.recipientId, userId), prunedFilter(options.tables, gone)))
        .returning({ id: A.id })) as { id: string }[];
      const held = new Set(permissions);
      const lost = registry.routings.filter((group) => !held.has(group.permission)).map((group) => group.key);
      let routings = 0;
      if (lost.length > 0) {
        const moved = (await db
          .update(R)
          .set({ userIds: sql`array_remove(${R.userIds}, ${userId})`, updatedAt: deps.clock() })
          .where(and(eq(R.tenantId, input.tenantId), inArray(R.routing, lost), sql`${userId} = any(${R.userIds})`))
          .returning({ routing: R.routing })) as { routing: string }[];
        routings = moved.length;
      }
      return { alerts: alerts.length, routings };
    } catch (error) {
      deps.report(error, { tenantId: typeof input?.tenantId === "string" ? input.tenantId : null, step: "prune" });
      return { alerts: 0, routings: 0 };
    }
  }

  async function cleanup(cleanupOptions: CleanupOptions = {}) {
    const readDays = Number.isFinite(cleanupOptions.readOlderThanDays) ? Math.max(0, cleanupOptions.readOlderThanDays as number) : 30;
    const anyDays = Number.isFinite(cleanupOptions.anyOlderThanDays) ? Math.max(0, cleanupOptions.anyOlderThanDays as number) : 180;
    const batch = Number.isFinite(cleanupOptions.limit) ? Math.max(1, Math.min(10_000, Math.trunc(cleanupOptions.limit as number))) : CLEANUP_BATCH;
    const budget = cleanupOptions.timeBudgetMs;
    const startedAt = Date.now();
    const now = deps.clock();
    const readCut = new Date(now.getTime() - readDays * DAY_MS);
    const anyCut = new Date(now.getTime() - anyDays * DAY_MS);
    let deleted = 0;
    for (;;) {
      if (budget !== undefined && Date.now() - startedAt >= budget) return { deleted, stoppedEarly: true };
      // `dedupe_key is not null and email_status is not null`: the two
      // package-only columns are named ON PURPOSE (D14, review G1), so an
      // instance pointed at a host's own `notifications` table errors instead
      // of deleting the host's rows. 0.1's rows (no key) are the firm-wide
      // inbox's and keep legacy.ts's rules.
      const doomed = db
        .select({ id: A.id })
        .from(A)
        .where(and(or(lt(A.readAt, readCut), lt(A.createdAt, anyCut)), isNotNull(A.dedupeKey), isNotNull(A.emailStatus)))
        .limit(batch);
      const gone = (await db.delete(A).where(inArray(A.id, doomed)).returning({ id: A.id })) as { id: string }[];
      deleted += gone.length;
      if (gone.length < batch) return { deleted, stoppedEarly: false };
    }
  }

  const instance: Notifications & { readonly [INTERNALS]: Internals } = {
    [INTERNALS]: { deps },
    registry,
    tables: options.tables,
    notify,
    claimEmails: (input) => claimEmails(deps, input),
    releaseClaim: (input) => releaseClaim(deps, input),
    list,
    unreadCount,
    markRead,
    markAllRead,
    choices,
    setChoice,
    routing,
    setRouting,
    forget,
    prune,
    deliverPendingEmails: (deliverOptions) => deliverPendingEmails(deps, deliverOptions),
    cleanup,
  };
  return instance;
}
