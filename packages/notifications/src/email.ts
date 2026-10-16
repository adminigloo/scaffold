import { and, asc, eq, gte, inArray, lt, lte, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { createLookups, resolveAudience, routedPeople, type Deps, type Lookups } from "./audience.js";
import { breakLinks } from "./links.js";
import {
  AlertsUnavailableError,
  type AlertEmailMessage,
  type AlertEmailOutcome,
  type DeliverPendingEmailsOptions,
  type DeliverPendingEmailsResult,
} from "./types.js";

/**
 * THE EMAIL COPIES (Tenancy 2b-1, 4.5; D5–D8): sends, claims, retries.
 *
 * The alert row is the durable record that an email is OWED (D8: no outbox
 * in 2b-1). An email that fails or times out in the request is retried by the
 * alerts cron with comms' rules, copied here: a claim by update guarded on the
 * status and the attempt count (two runs, or a run and a late request, never
 * both send one row), backoff, a stale-claim rule, and an idempotency key
 * (`alert:{id}`, the same on every try) handed to the provider. At least once,
 * never twice: with a provider that has no idempotency key (SMTP), a send that
 * was cut off mid-way is never tried again (review G12).
 *
 * Before every retry the recipient is checked again (D9, review G3): a
 * member removed, demoted, or an office address dropped while their copy
 * waited never gets an email with a customer's details.
 */

const t = (deps: Deps) => deps.tables.alerts;

/** A copy ready to send: the row's facts and the claim's attempt count. */
export interface CopyToSend {
  readonly id: string;
  readonly tenantId: string;
  readonly kind: string;
  readonly to: string;
  readonly recipientName: string | null;
  readonly addressOnly: boolean;
  readonly title: string;
  readonly body: string | null;
  readonly href: string | null;
  readonly replyTo: string | null;
  /** email_attempts after the claim: the outcome write is guarded on it. */
  readonly attempts: number;
}

export type SendOutcome = "sent" | "skipped" | "failed" | "retrying" | "later";

/** At most four sends at once (4.5 step 4): a burst of alerts never opens dozens of provider connections. */
export const SEND_CONCURRENCY = 4;
/** A `sending` claim older than this belongs to a request or run that died (comms' rule). */
export const STALE_CLAIM_MS = 10 * 60 * 1000;
export const NOT_RESENT_SENTENCE = "It may not have gone, and it isn't sent again so nobody gets two.";
export const NO_LONGER_SENTENCE = "no longer gets these";
export const RELEASED_SENTENCE = "The office email didn't go; sent again as an alert.";

const cut = (text: string) => (text.length > 500 ? `${text.slice(0, 499)}…` : text);

function describe(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return typeof error === "string" && error ? error : "the email seam threw";
}

/** The seam's answer, checked: anything unexpected is a failure a retry may fix. */
function normaliseOutcome(raw: unknown): AlertEmailOutcome {
  const value = raw as Partial<{ status: string; reason: unknown; error: unknown; retryable: unknown }> | null;
  if (value?.status === "sent") return { status: "sent" };
  if (value?.status === "skipped") return { status: "skipped", reason: typeof value.reason === "string" && value.reason ? value.reason : "skipped" };
  if (value?.status === "failed") {
    return {
      status: "failed",
      error: typeof value.error === "string" && value.error ? value.error : "the email didn't go",
      retryable: value.retryable === true,
    };
  }
  return { status: "failed", error: "the email seam answered something unexpected", retryable: true };
}

/** `promise`, or "timeout" after `ms` (0: wait). The promise keeps running either way. */
async function within<T>(promise: Promise<T>, ms: number): Promise<{ done: true; value: T } | { done: false }> {
  if (ms <= 0) return { done: true, value: await promise };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ done: false }>((resolve) => {
    timer = setTimeout(() => resolve({ done: false }), ms);
  });
  try {
    return await Promise.race([promise.then((value) => ({ done: true as const, value })), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Run `work` over `items`, `limit` at a time; `stop()` is asked before each item starts. */
export async function pool<T>(items: readonly T[], limit: number, work: (item: T) => Promise<void>, stop: () => boolean = () => false): Promise<boolean> {
  let next = 0;
  let stopped = false;
  const worker = async () => {
    while (next < items.length) {
      if (stop()) {
        stopped = true;
        return;
      }
      const item = items[next++] as T;
      await work(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return stopped;
}

/**
 * The row's state after an outcome (4.5's table). `maxAttempts` (the cron):
 * a retryable failure on the last attempt ends `failed`.
 */
function patchFor(
  outcome: AlertEmailOutcome,
  attempts: number,
  now: Date,
  maxAttempts: number | null,
): { patch: Record<string, unknown>; counted: Exclude<SendOutcome, "later"> } {
  switch (outcome.status) {
    case "sent":
      return { patch: { emailStatus: "sent", emailedAt: now, emailError: null }, counted: "sent" };
    case "skipped":
      return { patch: { emailStatus: "skipped", emailError: cut(outcome.reason) }, counted: "skipped" };
    case "failed":
      if (!outcome.retryable) return { patch: { emailStatus: "failed", emailError: cut(outcome.error) }, counted: "failed" };
      if (maxAttempts !== null && attempts >= maxAttempts) {
        return { patch: { emailStatus: "failed", emailError: cut(`${outcome.error} (gave up after ${attempts} tries)`) }, counted: "failed" };
      }
      return {
        patch: {
          emailStatus: "pending",
          emailClaimedAt: null,
          // 2^attempts minutes: 2, 4, 8 … (4.5's table).
          emailNextAt: new Date(now.getTime() + 2 ** attempts * 60_000),
          emailError: cut(outcome.error),
        },
        counted: "retrying",
      };
  }
}

/**
 * Write an outcome, guarded on the claim: `sending` AND the attempt count the
 * claim set. A run that stalled past the stale-claim time and came back to a
 * row another run reclaimed never overwrites it. Never throws: one failed
 * write must not stop the rows behind it (the stale-claim rule picks it up).
 */
async function settle(deps: Deps, copy: Pick<CopyToSend, "id" | "tenantId" | "kind" | "attempts">, patch: Record<string, unknown>): Promise<void> {
  const table = t(deps);
  try {
    await deps.db
      .update(table)
      .set(patch)
      .where(and(eq(table.id, copy.id), eq(table.emailStatus, "sending"), eq(table.emailAttempts, copy.attempts)));
  } catch (error) {
    deps.report(error, { tenantId: copy.tenantId, kind: copy.kind, step: "email-outcome" });
  }
}

/** The message the host's seam sees: links broken in what a customer may have typed (D18), the same key on every try (D7). */
function messageFor(copy: CopyToSend): AlertEmailMessage {
  return {
    tenantId: copy.tenantId,
    alertId: copy.id,
    kind: copy.kind,
    to: copy.to,
    recipientName: copy.recipientName,
    addressOnly: copy.addressOnly,
    title: breakLinks(copy.title),
    body: copy.body === null ? null : breakLinks(copy.body),
    href: copy.href,
    replyTo: copy.replyTo,
    idempotencyKey: `alert:${copy.id}`,
  };
}

/**
 * Send one claimed copy through the host's seam, bounded by `sendTimeoutMs`,
 * and record the outcome. A send that times out is left `sending` ("later"):
 * the cron's stale-claim rule decides (retry with an idempotent provider,
 * else `failed` so nobody gets two). If it finishes after all, its outcome is
 * recorded then, still guarded on the claim.
 */
export async function sendCopy(deps: Deps, copy: CopyToSend, maxAttempts: number | null): Promise<SendOutcome> {
  if (!deps.email) {
    await settle(deps, copy, { emailStatus: "skipped", emailError: "This site doesn't send email." });
    return "skipped";
  }
  const sending = (async (): Promise<AlertEmailOutcome> => {
    try {
      return normaliseOutcome(await deps.email!(messageFor(copy)));
    } catch (error) {
      deps.report(error, { tenantId: copy.tenantId, kind: copy.kind, step: "email" });
      // The seam throws. With a provider that drops a repeat of the key, as a
      // retryable failure (4.5's table): trying again can't send two.
      // CONTRACT: 4.5's table says a throw is always retryable. Without an
      // idempotency key (SMTP) a throw is very often a connection cut AFTER
      // the server took the message (nodemailer's ECONNRESET or timeout), and
      // a retry sends it twice (review FH-9). So, like a send cut off by the
      // timeout, it is never tried again. A seam that KNOWS nothing left (a
      // refusal before the message went) answers `{ status: "failed",
      // retryable: true }` and is retried as before.
      if (!deps.emailIdempotent) return { status: "failed", error: cut(`${NOT_RESENT_SENTENCE} (${describe(error)})`), retryable: false };
      return { status: "failed", error: cut(describe(error)), retryable: true };
    }
  })();
  const answer = await within(sending, deps.sendTimeoutMs);
  if (!answer.done) {
    void sending
      .then((late) => settle(deps, copy, patchFor(late, copy.attempts, deps.clock(), maxAttempts).patch))
      .catch(() => undefined);
    return "later";
  }
  const { patch, counted } = patchFor(answer.value, copy.attempts, deps.clock(), maxAttempts);
  await settle(deps, copy, patch);
  return counted;
}

// ---------------------------------------------------------------------------
// The alerts cron.

const deliverSchema = z.object({
  tenantIds: z.array(z.string().min(1).max(200)).max(50_000),
  limit: z.number().int().min(1).max(10_000).default(500),
  timeBudgetMs: z.number().int().min(0).optional(),
  maxAttempts: z.number().int().min(1).max(20).default(4),
  maxAgeMs: z.number().int().min(60_000).default(26 * 60 * 60 * 1000),
});

interface DueRow {
  id: string;
  tenantId: string;
  recipientId: string;
  reachedVia: string;
  kind: string;
  title: string;
  body: string | null;
  href: string | null;
  emailTo: string | null;
  emailAttempts: number;
}

type Recheck =
  | { readonly ok: true; readonly to: string; readonly name: string | null; readonly addressOnly: boolean }
  | { readonly ok: false; readonly retry: false }
  | { readonly ok: false; readonly retry: true; readonly error: string };

/**
 * D9, review G3: does this row's recipient still qualify NOW, and at which
 * address? A person must still be returned by `people()` for the kind's
 * permission (or the assigned permission, for a row reached through
 * assignment), and gets it at the address 4.4 would give them now (the
 * business email for the owner of a group on "The owner", else their current
 * sign-in address). An extra address must still be on its group. A kind no
 * longer registered, never emailed, or switched off in Messages: no.
 */
async function recheck(deps: Deps, lookups: Lookups, row: DueRow): Promise<Recheck> {
  const no = { ok: false, retry: false } as const;
  const spec = deps.registry.kind(row.kind);
  if (!spec || spec.email === false) return no;
  const delivery = await lookups.delivery(row.tenantId);
  if (!delivery.available || delivery.offKinds[row.kind] !== undefined) return no;

  if (row.reachedVia === "address") {
    if (!spec.audience.routing || !row.recipientId.startsWith("email:")) return no;
    const address = row.recipientId.slice("email:".length).toLowerCase();
    const choice = (await lookups.routingRows(row.tenantId)).get(spec.audience.routing);
    if (choice?.mode !== "chosen") return no;
    const listed = choice.extraEmails.find((extra) => extra.toLowerCase() === address);
    return listed ? { ok: true, to: listed, name: null, addressOnly: true } : no;
  }

  const permission = row.reachedVia === "assigned" ? spec.audience.assigned?.permission : row.reachedVia === "audience" ? spec.audience.permission : undefined;
  if (!permission) return no;
  let holders;
  try {
    holders = await lookups.people(row.tenantId, permission);
  } catch (error) {
    // The host couldn't say: not a "no". Tried again later.
    deps.report(error, { tenantId: row.tenantId, kind: row.kind, step: "people" });
    return { ok: false, retry: true, error: "couldn't check who gets this just now" };
  }
  const person = holders.find((p) => p.userId === row.recipientId);
  if (!person) return no;
  let to = person.email;
  if (row.reachedVia === "audience" && spec.audience.routing && person.isOwner) {
    const choice = (await lookups.routingRows(row.tenantId)).get(spec.audience.routing);
    if (routedPeople(holders, choice).fallback) to = (await lookups.ownerEmail(row.tenantId)) ?? person.email;
  }
  return to ? { ok: true, to, name: person.name, addressOnly: false } : no;
}

/**
 * The due rows of the listed companies, COMPANIES TAKING TURNS (review BO-14,
 * 2a §18's drain rule): each company's due rows numbered oldest first, then
 * claimed in that order, so every company's first due row goes before any
 * company's second. A company with 600 waiting never holds back another
 * company's one.
 */
async function dueInTurns(deps: Deps, now: Date, forTenants: SQL, limit: number): Promise<DueRow[]> {
  const table = t(deps);
  const ranked = deps.db
    .select({
      id: table.id,
      turn: sql<number>`row_number() over (partition by ${table.tenantId} order by ${table.emailNextAt}, ${table.id})`.as("turn"),
    })
    .from(table)
    .where(and(eq(table.emailStatus, "pending"), lte(table.emailNextAt, now), forTenants))
    .as("ranked");
  const rows = (await deps.db
    .select({
      id: table.id,
      tenantId: table.tenantId,
      recipientId: table.recipientId,
      reachedVia: table.reachedVia,
      kind: table.kind,
      title: table.title,
      body: table.body,
      href: table.href,
      emailTo: table.emailTo,
      emailAttempts: table.emailAttempts,
    })
    .from(table)
    .innerJoin(ranked, eq(ranked.id, table.id))
    .orderBy(asc(ranked.turn), asc(table.emailNextAt), asc(table.id))
    .limit(limit)) as DueRow[];
  return rows;
}

export async function deliverPendingEmails(deps: Deps, raw: DeliverPendingEmailsOptions): Promise<DeliverPendingEmailsResult> {
  const options = deliverSchema.parse({ ...raw, tenantIds: Array.isArray(raw?.tenantIds) ? [...raw.tenantIds] : raw?.tenantIds });
  const result = { sent: 0, skipped: 0, failed: 0, retrying: 0, expired: 0, reclaimed: 0, stoppedEarly: false };
  const tenantIds = [...new Set(options.tenantIds)];
  // An empty list claims nothing, and touches nothing (D9: only the
  // companies the cron names, the active ones, have their emails sent).
  if (tenantIds.length === 0) return result;
  const table = t(deps);
  const forTenants = inArray(table.tenantId, tenantIds);
  const startedAt = Date.now();
  const elapsed = () => Date.now() - startedAt;
  const now = deps.clock();

  // 1. Stale claims: a request or a run that died mid-send.
  const stale = and(forTenants, eq(table.emailStatus, "sending"), lt(table.emailClaimedAt, new Date(now.getTime() - STALE_CLAIM_MS)));
  if (deps.emailIdempotent) {
    // The provider drops a repeat of the key: trying again can't send two.
    const exhausted = (await deps.db
      .update(table)
      .set({ emailStatus: "failed", emailError: `It didn't go after ${options.maxAttempts} tries.` })
      .where(and(stale, gte(table.emailAttempts, options.maxAttempts)))
      .returning({ id: table.id })) as { id: string }[];
    result.failed += exhausted.length;
    const revived = (await deps.db
      .update(table)
      .set({ emailStatus: "pending", emailClaimedAt: null, emailNextAt: now })
      .where(stale)
      .returning({ id: table.id })) as { id: string }[];
    result.reclaimed += revived.length;
  } else {
    // SMTP and friends: it may have gone. At most once beats twice (G12).
    const ended = (await deps.db
      .update(table)
      .set({ emailStatus: "failed", emailError: NOT_RESENT_SENTENCE })
      .where(stale)
      .returning({ id: table.id })) as { id: string }[];
    result.failed += ended.length;
  }

  // 2. Too old to be useful: an alert email a day late helps nobody.
  const expired = (await deps.db
    .update(table)
    .set({ emailStatus: "expired", emailError: "too late to be useful" })
    .where(and(forTenants, eq(table.emailStatus, "pending"), lt(table.createdAt, new Date(now.getTime() - options.maxAgeMs))))
    .returning({ id: table.id })) as { id: string }[];
  result.expired += expired.length;

  // 3–5. Claim due rows in turns, re-check each recipient, send.
  const lookups = createLookups(deps, false);
  const seen = new Set<string>();
  let processed = 0;
  const outOfTime = () => options.timeBudgetMs !== undefined && elapsed() >= options.timeBudgetMs;
  drain: while (processed < options.limit) {
    const due = (await dueInTurns(deps, now, forTenants, options.limit - processed)).filter((row) => !seen.has(row.id));
    if (due.length === 0) break;
    for (const row of due) seen.add(row.id);
    const stopped = await pool(
      due,
      SEND_CONCURRENCY,
      async (row) => {
        if (processed >= options.limit) return;
        // The claim, guarded on the attempt count this run saw (comms' rule):
        // a row another run touched since the select is left alone.
        const attempts = row.emailAttempts + 1;
        const claimed = (await deps.db
          .update(table)
          .set({ emailStatus: "sending", emailClaimedAt: deps.clock(), emailAttempts: attempts })
          .where(and(eq(table.id, row.id), eq(table.emailStatus, "pending"), eq(table.emailAttempts, row.emailAttempts)))
          .returning({ id: table.id })) as { id: string }[];
        if (claimed.length === 0) return;
        processed += 1;
        const copy = { id: row.id, tenantId: row.tenantId, kind: row.kind, attempts };
        const check = await recheck(deps, lookups, row);
        if (!check.ok) {
          if (check.retry) {
            const { patch, counted } = patchFor({ status: "failed", error: check.error, retryable: true }, attempts, deps.clock(), options.maxAttempts);
            await settle(deps, copy, patch);
            result[counted] += 1;
          } else {
            await settle(deps, copy, { emailStatus: "skipped", emailError: NO_LONGER_SENTENCE });
            result.skipped += 1;
          }
          return;
        }
        if (check.to !== row.emailTo) await settle(deps, copy, { emailTo: check.to });
        // CONTRACT: the row has no reply-to column (4.1), so a retried copy
        // replies to the company (the host's default), not to a customer.
        const outcome = await sendCopy(
          deps,
          {
            ...copy,
            to: check.to,
            recipientName: check.name,
            addressOnly: check.addressOnly,
            title: row.title,
            body: row.body,
            href: row.href,
            replyTo: null,
          },
          options.maxAttempts,
        );
        if (outcome !== "later") result[outcome] += 1;
      },
      outOfTime,
    );
    if (stopped) {
      result.stoppedEarly = true;
      break drain;
    }
  }
  if (processed >= options.limit) result.stoppedEarly = true;
  return result;
}

// ---------------------------------------------------------------------------
// A producer's own office email (D6).

const claimSchema = z.object({
  tenantId: z.string().min(1).max(200),
  kind: z.string().min(1).max(64),
  dedupeKey: z.string().min(1).max(200),
  assignedUserIds: z.array(z.string().min(1).max(200)).max(500).optional(),
  actorUserId: z.string().min(1).max(200).nullable().optional(),
});

function uniqueAddresses(addresses: readonly (string | null)[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const address of addresses) {
    if (!address) continue;
    const key = address.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(address);
  }
  return out;
}

/**
 * The addresses still OWED this alert's email, claimed in the same statement
 * (4.5). The emitted glue runs the alerts listener BEFORE the comms listener,
 * so the rows exist; handing the same event over twice claims nothing the
 * second time: never two office emails for one lead.
 */
export async function claimEmails(
  deps: Deps,
  raw: { tenantId: string; kind: string; dedupeKey: string; assignedUserIds?: readonly string[]; actorUserId?: string | null },
): Promise<readonly string[]> {
  const parsed = claimSchema.safeParse({ ...raw, assignedUserIds: raw?.assignedUserIds ? [...raw.assignedUserIds] : undefined });
  if (!parsed.success) {
    deps.report(new Error("claimEmails was given a notice it couldn't read"), { tenantId: typeof raw?.tenantId === "string" ? raw.tenantId : null, step: "claim" });
    return [];
  }
  const input = parsed.data;
  const spec = deps.registry.kind(input.kind);
  // 1. A notifications-sent kind must not be claimed, or it would go twice.
  if (!spec || spec.emailBy !== "producer") {
    deps.report(new Error(`claimEmails: ${input.kind} isn't a kind whose email the producer sends`), {
      tenantId: input.tenantId,
      kind: input.kind,
      step: "claim",
    });
    return [];
  }
  const table = t(deps);
  try {
    const now = deps.clock();
    // 2. Claim, in one statement.
    const claimed = (await deps.db
      .update(table)
      .set({ emailStatus: "claimed", emailClaimedAt: now, emailedAt: now })
      .where(and(eq(table.tenantId, input.tenantId), eq(table.dedupeKey, input.dedupeKey), eq(table.kind, input.kind), eq(table.emailStatus, "owed")))
      .returning({ emailTo: table.emailTo })) as { emailTo: string | null }[];
    if (claimed.length > 0) return uniqueAddresses(claimed.map((row) => row.emailTo));
    // 3. Rows exist: already claimed, or nobody chose email.
    const existing = await deps.db
      .select({ id: table.id })
      .from(table)
      .where(and(eq(table.tenantId, input.tenantId), eq(table.dedupeKey, input.dedupeKey), eq(table.kind, input.kind)))
      .limit(1);
    if (existing.length > 0) return [];
    // 4. No row at all (the alert write failed or never ran): worked out
    // live, people reached only through `assigned` left out (crew get their
    // own copy, review BO-03). The office still hears; this one has no dedupe.
    const audience = await resolveAudience(
      deps,
      createLookups(deps, true),
      { tenantId: input.tenantId, spec, actorUserId: input.actorUserId ?? null, assignedUserIds: input.assignedUserIds ?? [] },
      true,
    );
    deps.report(new Error(`No alert was written for ${input.kind} (${input.dedupeKey}); the office email went to the people chosen now.`), {
      tenantId: input.tenantId,
      kind: input.kind,
      step: "claim-without-alerts",
    });
    return uniqueAddresses([
      ...audience.people.filter((p) => p.reachedVia === "audience" && p.emailCopy).map((p) => p.emailTo),
      ...audience.addresses.filter((a) => a.emailCopy).map((a) => a.address),
    ]);
  } catch (error) {
    // 5. The office falls back to the business address (3.4).
    deps.report(error, { tenantId: input.tenantId, kind: input.kind, step: "claim" });
    throw new AlertsUnavailableError(undefined, { cause: error });
  }
}

const releaseSchema = z.object({
  tenantId: z.string().min(1).max(200),
  kind: z.string().min(1).max(64),
  dedupeKey: z.string().min(1).max(200),
  to: z.string().min(1).max(320),
});

/**
 * A failed office email back to the cron (D6, review BO-02): the claimed row
 * for `to` goes back to `pending`, due in 5 minutes, and the alerts cron sends
 * it as a `team_alert` copy once (the row is claimed by update before each
 * send). Only a producer kind's row is ever touched.
 */
export async function releaseClaim(deps: Deps, raw: { tenantId: string; kind: string; dedupeKey: string; to: string }): Promise<number> {
  const parsed = releaseSchema.safeParse(raw);
  if (!parsed.success) {
    deps.report(new Error("releaseClaim was given something it couldn't read"), { tenantId: null, step: "release-claim" });
    return 0;
  }
  const input = parsed.data;
  const spec = deps.registry.kind(input.kind);
  if (!spec || spec.emailBy !== "producer") {
    deps.report(new Error(`releaseClaim: ${input.kind} isn't a kind whose email the producer sends`), {
      tenantId: input.tenantId,
      kind: input.kind,
      step: "release-claim",
    });
    return 0;
  }
  const table = t(deps);
  try {
    const [row] = await deps.db
      .select({ id: table.id })
      .from(table)
      .where(
        and(
          eq(table.tenantId, input.tenantId),
          eq(table.kind, input.kind),
          eq(table.dedupeKey, input.dedupeKey),
          sql`lower(${table.emailTo}) = lower(${input.to})`,
          eq(table.emailStatus, "claimed"),
        ),
      )
      .orderBy(asc(table.id))
      .limit(1);
    if (!row) return 0;
    const moved = (await deps.db
      .update(table)
      .set({
        emailStatus: "pending",
        emailNextAt: new Date(deps.clock().getTime() + 5 * 60_000),
        emailClaimedAt: null,
        emailedAt: null,
        emailError: RELEASED_SENTENCE,
      })
      .where(and(eq(table.id, row.id), eq(table.tenantId, input.tenantId), eq(table.emailStatus, "claimed")))
      .returning({ id: table.id })) as { id: string }[];
    return moved.length;
  } catch (error) {
    deps.report(error, { tenantId: input.tenantId, kind: input.kind, step: "release-claim" });
    return 0;
  }
}
