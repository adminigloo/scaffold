import { createHash } from "node:crypto";
import { and, eq, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import { newId } from "@adminigloo/db";
import { isSafeHtml, type SafeHtml } from "./html.js";
import { InvalidEmailKindError, type DigestPerson, type DigestRecipient, type DigestSectionContent, type DigestSpec, type EmailKind, type EmailKinds } from "./registry.js";
import { renderAlertEmail, renderDigestEmail, type EmailTheme, type RenderedEmail } from "./render.js";
import type { DigestTables } from "./schema.js";
import { assertTimeZone, deliveryWindow, digestDay, isDay, isTimeZone, localDay, type DigestDay } from "./time.js";
import { readUnsubscribe, signUnsubscribe } from "./tokens.js";

/**
 * The digest instance (digest 0.1): each person's email choices, the daily
 * run, the staff preview, alert emails and unsubscribing. The host supplies
 * who its people are (`people`) and how an email leaves (`send`); the
 * package never imports the host's users, auth or mailer.
 *
 * THREE RULES:
 *
 *   1. NOTHING IS SENT UNTIL A PERSON SAYS YES. No subscription row is no
 *      email, and an unsubscribe is a row that says no.
 *   2. AT MOST ONE EMAIL PER PERSON, KIND AND DAY. The ledger row is claimed
 *      (an insert into a unique index) before a section is built, so a
 *      replayed cron, a second instance running at once or a retried request
 *      sends nobody anything twice.
 *   3. NO PROVIDER IS NOT A FAILURE. With no email provider configured a
 *      send is "skipped": recorded, never retried, never reported.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type DigestDb = PgDatabase<any, any, any>;

/** How a choice was made, kept on the row. */
export type ChoiceSource = "sign-up" | "preferences" | "link" | "one-click" | "staff";

/** One email, as the host's `send` receives it. */
export interface DigestOutgoing {
  readonly to: string;
  readonly subject: string;
  readonly html: string;
  readonly text: string;
  /** RFC 8058's one-click pair: List-Unsubscribe and List-Unsubscribe-Post. */
  readonly headers: Readonly<Record<string, string>>;
  /**
   * The same on every retry of this email, and never shared by two: give it
   * to a provider that drops repeats. `digest:{kind}:{person}:{day}` or
   * `alert:{kind}:{person}:{key}` — or, when that isn't 1 to 256 visible
   * ASCII characters (an alert key with a space or an accent, a long one),
   * `{digest|alert}:{kind}:sha256:{hash of the person and the key}`.
   */
  readonly idempotencyKey: string;
  /** For the delivery log: "digest:morning", "alert:price-alerts". */
  readonly template: string;
  readonly userId: string;
  readonly kind: string;
}

export type DigestSendOutcome =
  | { readonly status: "sent" }
  /** Nothing went: no email provider is configured. Recorded, never retried, never an error. */
  | { readonly status: "skipped"; readonly reason?: string }
  /** `retryable`: the provider may take it later (a timeout, a 429, a 5xx). */
  | { readonly status: "failed"; readonly error: string; readonly retryable: boolean };

export interface CreateDigestsOptions {
  readonly db: DigestDb;
  /** REQUIRED: `digestTables` from "@adminigloo/digest/schema" (digest_preferences, digest_subscriptions, digest_sends), or `defineDigestTables({ prefix })` — the same objects your drizzle schema exports. */
  readonly tables: DigestTables;
  readonly kinds: EmailKinds;
  /**
   * The people among these ids who may be emailed right now — with their
   * sign-in address — and nobody else: a deleted person, a suspended account
   * or one with no verified address is left out, and is sent nothing.
   */
  readonly people: (userIds: readonly string[]) => Promise<readonly DigestPerson[]>;
  /** Sends one email. Should not throw; a throw is a failure (retried only with `idempotentSends`). */
  readonly send: (message: DigestOutgoing) => Promise<DigestSendOutcome>;
  /**
   * Does `send`'s provider drop a repeat of the same `idempotencyKey`
   * (Resend does, for 24 hours)? Then a failure the provider may take later,
   * and a send a crash cut off, are tried again while the day lasts — three
   * times in all. Default false: a send is tried once.
   */
  readonly idempotentSends?: boolean;
  /** The site's name, in every email's footer. */
  readonly siteName: string;
  /** The zone for a person who has none (an IANA name). */
  readonly siteTimeZone: string;
  /** The local hour for a person who hasn't chosen one. Default 7. */
  readonly defaultHour?: number;
  /** Signs every unsubscribe link: 32 characters or more, kept secret, stable across deploys. */
  readonly secret: string;
  /** This site's address, for the links in each email ("https://yoursite.com"). */
  readonly baseUrl: string;
  readonly paths?: {
    /** The page an unsubscribe link opens. Default "/unsubscribe". */
    readonly unsubscribePage?: string;
    /** Where the handlers are mounted, for List-Unsubscribe. Default "/api/email". */
    readonly api?: string;
    /** The person's preferences page. Default "/account/email". */
    readonly preferences?: string;
  };
  readonly theme?: EmailTheme;
  /** For the day's name ("Tuesday, October 21"). Default "en-US". */
  readonly locale?: string;
  /** Between two sends that reach the provider. Default 550 (Resend allows 2 a second). */
  readonly sendIntervalMs?: number;
  /** The longest one send may take: no send starts unless it and a margin still fit the run's budget. Default 10 000. */
  readonly sendTimeoutMs?: number;
  readonly now?: () => Date;
  readonly sleep?: (ms: number) => Promise<void>;
  /** Told about every step that failed (a section that threw, a send that failed). Default console.error. */
  readonly onError?: (error: unknown, context: { readonly step: string; readonly userId?: string; readonly kind?: string }) => void;
}

/** A person's choices, as the preferences page shows them. */
export interface EmailPreferences {
  readonly userId: string;
  /** The zone their digests run on: theirs, else the site's. */
  readonly timeZone: string;
  /** How it was set: their browser, their own choice, or nothing (the site's). */
  readonly timeZoneSource: "browser" | "person" | "site";
  readonly deliveryHour: number;
  /** Every email kind on offer: true when they said yes. */
  readonly choices: Readonly<Record<string, boolean>>;
}

export interface SavePreferencesInput {
  /** An IANA zone, or null for the site's. */
  readonly timeZone?: string | null;
  readonly deliveryHour?: number;
  /** Kind key → yes or no. A key that isn't on offer is refused. */
  readonly choices?: Readonly<Record<string, boolean>>;
}

export class DigestInputError extends Error {
  readonly name = "DigestInputError";
}

export interface DigestRunTally {
  readonly key: string;
  /** People who said yes. */
  readonly subscribed: number;
  /** Their window is open and nothing has gone yet. */
  readonly due: number;
  readonly sent: number;
  /** No email provider: recorded, nothing went. */
  readonly skipped: number;
  /** Every section had nothing to say: no email that day. */
  readonly empty: number;
  readonly failed: number;
  /** Due, but the run's time ran out first: the next run sends them. */
  readonly waiting: number;
}

export interface DigestRunResult {
  readonly digests: readonly DigestRunTally[];
  /** The time budget ran out with people still due. */
  readonly stoppedEarly: boolean;
}

export interface DigestPreview {
  readonly digest: string;
  readonly day: string;
  readonly timeZone: string;
  readonly deliveryHour: number;
  /** Null: this person can't be emailed (deleted, suspended, no verified address). */
  readonly person: DigestPerson | null;
  readonly subscribed: boolean;
  /** What the ledger already says about that day. */
  readonly ledger: { readonly status: string; readonly finishedAt: Date | null } | null;
  readonly sections: readonly { readonly key: string; readonly included: boolean; readonly title: string | null; readonly error: string | null }[];
  /** The email exactly as it would go; null when there is nothing to send. */
  readonly email: RenderedEmail | null;
}

export type AlertSendResult =
  | { readonly status: "sent" | "skipped" }
  | { readonly status: "failed"; readonly error: string }
  /** They never chose this kind, or stopped it. */
  | { readonly status: "not-subscribed" }
  /** Not someone who may be emailed (deleted, suspended, no address). */
  | { readonly status: "no-person" }
  /** This alert (the same key) already went to them. */
  | { readonly status: "duplicate" };

export interface UnsubscribeResult {
  readonly userId: string;
  readonly kind: EmailKind;
  /** False when it was already that way. */
  readonly changed: boolean;
}

export interface SignUpChoice {
  readonly timeZone: string | null;
  readonly digests: readonly string[];
}

export interface Digests {
  readonly kinds: EmailKinds;
  readonly siteTimeZone: string;
  preferencesOf(userId: string): Promise<EmailPreferences>;
  savePreferences(userId: string, input: SavePreferencesInput, source?: ChoiceSource): Promise<EmailPreferences>;
  /** Their zone, only if they have none yet (their browser's, at sign-up). */
  rememberTimeZone(userId: string, timeZone: string): Promise<void>;
  /** What they ticked at sign-up: the zone if they have none, each digest only if they never chose it either way. */
  applySignUpChoice(userId: string, choice: SignUpChoice): Promise<{ readonly subscribed: readonly string[] }>;
  setChoice(userId: string, kind: string, subscribed: boolean, source: ChoiceSource): Promise<boolean>;
  /** The signed token for one person and one email kind. */
  unsubscribeToken(userId: string, kind: string): string;
  /** The page a person opens from an email (no sign-in). */
  unsubscribeUrl(userId: string, kind: string): string;
  /** List-Unsubscribe's target: the one-click endpoint. */
  oneClickUrl(userId: string, kind: string): string;
  /** Who and which email a token names; null for anything that isn't one of ours. */
  readToken(token: unknown): { readonly userId: string; readonly kind: EmailKind } | null;
  unsubscribe(token: unknown, source: "link" | "one-click"): Promise<UnsubscribeResult | null>;
  resubscribe(token: unknown): Promise<UnsubscribeResult | null>;
  /** The daily run: every digest, for everyone whose window is open and who has had nothing yet. */
  run(options?: { readonly timeBudgetMs?: number }): Promise<DigestRunResult>;
  /** One person's digest for one day, built and rendered, never sent. */
  preview(input: { readonly userId: string; readonly digest: string; readonly day?: string }): Promise<DigestPreview>;
  /** One alert email to one person, only if they chose its kind; at most once per `dedupeKey`. */
  sendAlert(input: {
    readonly userId: string;
    readonly kind: string;
    readonly dedupeKey?: string;
    readonly subject: string;
    readonly text: string;
    readonly html: SafeHtml;
  }): Promise<AlertSendResult>;
  /** Every row of one person's (their account was deleted). Returns how many went. */
  forgetPerson(userId: string): Promise<number>;
}

const MAX_ATTEMPTS = 3;
/** A claim older than this was cut off (a crash, a timeout). */
const STALE_CLAIM_MS = 15 * 60_000;
const CRON_MARGIN_MS = 2_000;
const PEOPLE_BATCH = 200;

function cut(text: string, max = 500): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function validHour(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 23;
}

function absolute(base: string, path: string): string {
  return new URL(path, base.endsWith("/") ? base : `${base}/`).toString();
}

/**
 * The provider's idempotency key for one email. Resend takes 1 to 256
 * visible ASCII characters (so does @adminigloo/email, which refuses any
 * other key, and the email with it): an alert key like "AAPL above 200" or
 * "Zürich:2026-10-21" is hashed instead, and so is one too long to fit —
 * cutting it would give two different alerts one key, and the provider would
 * drop the second as a repeat.
 */
function idempotencyKeyFor(type: "digest" | "alert", kind: string, userId: string, key: string): string {
  const plain = `${type}:${kind}:${userId}:${key}`;
  if (/^[\x21-\x7e]{1,256}$/.test(plain)) return plain;
  return `${type}:${kind}:sha256:${createHash("sha256").update(`${userId}\n${key}`).digest("base64url")}`;
}

export function createDigests(options: CreateDigestsOptions): Digests {
  const db = options.db;
  const t = options.tables;
  const kinds = options.kinds;
  const siteTimeZone = assertTimeZone(options.siteTimeZone);
  const defaultHour = options.defaultHour ?? 7;
  if (!validHour(defaultHour)) throw new DigestInputError(`defaultHour must be a whole hour from 0 to 23 (got ${defaultHour})`);
  if (typeof options.secret !== "string" || options.secret.length < 32) {
    throw new DigestInputError("secret must be at least 32 characters: it signs every unsubscribe link");
  }
  try {
    new URL(options.baseUrl);
  } catch {
    throw new DigestInputError(`baseUrl must be this site's address, like "https://yoursite.com" (got ${JSON.stringify(options.baseUrl)})`);
  }
  const secret = options.secret;
  const idempotent = options.idempotentSends ?? false;
  const clock = options.now ?? (() => new Date());
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const interval = options.sendIntervalMs ?? 550;
  const sendTimeout = options.sendTimeoutMs ?? 10_000;
  const locale = options.locale ?? "en-US";
  const paths = {
    unsubscribePage: options.paths?.unsubscribePage ?? "/unsubscribe",
    api: (options.paths?.api ?? "/api/email").replace(/\/+$/, ""),
    preferences: options.paths?.preferences ?? "/account/email",
  };
  const report = (error: unknown, context: { step: string; userId?: string; kind?: string }) => {
    try {
      (options.onError ?? ((e, c) => console.error("digest:", c, e)))(error, context);
    } catch {
      // A broken reporter never breaks a send.
    }
  };

  const unsubscribeToken = (userId: string, kind: string) => signUnsubscribe(secret, userId, kind);
  const unsubscribeUrl = (userId: string, kind: string) =>
    absolute(options.baseUrl, `${paths.unsubscribePage}?t=${encodeURIComponent(unsubscribeToken(userId, kind))}`);
  const oneClickUrl = (userId: string, kind: string) =>
    absolute(options.baseUrl, `${paths.api}/v1/unsubscribe?t=${encodeURIComponent(unsubscribeToken(userId, kind))}`);
  const links = (userId: string, kind: string) => ({ preferences: absolute(options.baseUrl, paths.preferences), unsubscribe: unsubscribeUrl(userId, kind) });
  const headersFor = (userId: string, kind: string) => ({
    "List-Unsubscribe": `<${oneClickUrl(userId, kind)}>`,
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
  });

  async function preferenceRow(userId: string) {
    const [row] = await db.select().from(t.preferences).where(eq(t.preferences.userId, userId)).limit(1);
    return row ?? null;
  }

  function clockOf(
    row: { readonly timeZone: string | null; readonly timeZoneSource: string | null; readonly deliveryHour: number } | null,
  ): { zone: string; hour: number; source: EmailPreferences["timeZoneSource"] } {
    const zone = row && isTimeZone(row.timeZone) ? row.timeZone : null;
    return {
      zone: zone ?? siteTimeZone,
      hour: row && validHour(row.deliveryHour) ? row.deliveryHour : defaultHour,
      source: zone === null ? "site" : row?.timeZoneSource === "browser" ? "browser" : "person",
    };
  }

  async function preferencesOf(userId: string): Promise<EmailPreferences> {
    if (!userId) throw new DigestInputError("a person is required");
    const row = await preferenceRow(userId);
    const subscriptions = await db
      .select({ kind: t.subscriptions.kind, subscribed: t.subscriptions.subscribed })
      .from(t.subscriptions)
      .where(eq(t.subscriptions.userId, userId));
    const said = new Map(subscriptions.map((s) => [s.kind, s.subscribed]));
    const { zone, hour, source } = clockOf(row);
    const choices: Record<string, boolean> = {};
    for (const kind of kinds.offered) choices[kind.key] = said.get(kind.key) === true;
    return { userId, timeZone: zone, timeZoneSource: source, deliveryHour: hour, choices };
  }

  async function setChoice(userId: string, kind: string, subscribed: boolean, source: ChoiceSource): Promise<boolean> {
    const [before] = await db
      .select({ subscribed: t.subscriptions.subscribed })
      .from(t.subscriptions)
      .where(and(eq(t.subscriptions.userId, userId), eq(t.subscriptions.kind, kind)))
      .limit(1);
    if (before && before.subscribed === subscribed) return false;
    const now = clock();
    await db
      .insert(t.subscriptions)
      .values({ userId, kind, subscribed, source, changedAt: now })
      .onConflictDoUpdate({ target: [t.subscriptions.userId, t.subscriptions.kind], set: { subscribed, source, changedAt: now } });
    return true;
  }

  async function savePreferences(userId: string, input: SavePreferencesInput, source: ChoiceSource = "preferences"): Promise<EmailPreferences> {
    if (!userId) throw new DigestInputError("a person is required");
    if (input.timeZone !== undefined && input.timeZone !== null && !isTimeZone(input.timeZone)) {
      throw new DigestInputError(`${JSON.stringify(input.timeZone)} isn't a time zone`);
    }
    if (input.deliveryHour !== undefined && !validHour(input.deliveryHour)) {
      throw new DigestInputError("the hour must be a whole number from 0 to 23");
    }
    for (const [key, value] of Object.entries(input.choices ?? {})) {
      if (kinds.kind(key) === null) throw new DigestInputError(`"${key}" isn't an email you can choose here`);
      if (typeof value !== "boolean") throw new DigestInputError(`"${key}" must be on or off`);
    }
    const now = clock();
    if (input.timeZone !== undefined || input.deliveryHour !== undefined) {
      const zoneSet = input.timeZone !== undefined ? { timeZone: input.timeZone, timeZoneSource: input.timeZone === null ? null : "person" } : {};
      const hourSet = input.deliveryHour !== undefined ? { deliveryHour: input.deliveryHour } : {};
      await db
        .insert(t.preferences)
        .values({ userId, ...zoneSet, ...hourSet, createdAt: now, updatedAt: now })
        .onConflictDoUpdate({ target: t.preferences.userId, set: { ...zoneSet, ...hourSet, updatedAt: now } });
    }
    for (const [key, value] of Object.entries(input.choices ?? {})) await setChoice(userId, key, value, source);
    return preferencesOf(userId);
  }

  async function rememberTimeZone(userId: string, timeZone: string): Promise<void> {
    if (!userId || !isTimeZone(timeZone)) return;
    const now = clock();
    await db
      .insert(t.preferences)
      .values({ userId, timeZone, timeZoneSource: "browser", createdAt: now, updatedAt: now })
      .onConflictDoUpdate({
        target: t.preferences.userId,
        set: { timeZone, timeZoneSource: "browser", updatedAt: now },
        setWhere: isNull(t.preferences.timeZone),
      });
  }

  async function applySignUpChoice(userId: string, choice: SignUpChoice): Promise<{ readonly subscribed: readonly string[] }> {
    if (choice.timeZone) await rememberTimeZone(userId, choice.timeZone);
    const subscribed: string[] = [];
    const now = clock();
    for (const key of new Set(choice.digests)) {
      const kind = kinds.kind(key);
      if (kind === null || kind.type !== "digest") continue;
      // Never over a choice they already made, either way.
      const rows = await db
        .insert(t.subscriptions)
        .values({ userId, kind: key, subscribed: true, source: "sign-up", changedAt: now })
        .onConflictDoNothing({ target: [t.subscriptions.userId, t.subscriptions.kind] })
        .returning({ kind: t.subscriptions.kind });
      if (rows.length > 0) subscribed.push(key);
    }
    return { subscribed };
  }

  function readToken(token: unknown): { readonly userId: string; readonly kind: EmailKind } | null {
    const read = readUnsubscribe(secret, token);
    if (read === null) return null;
    // A kind the project no longer offers still unsubscribes (its title is its key).
    const kind = kinds.kind(read.kind) ?? { type: "digest" as const, key: read.kind, title: read.kind, description: "" };
    return { userId: read.userId, kind };
  }

  async function unsubscribe(token: unknown, source: "link" | "one-click"): Promise<UnsubscribeResult | null> {
    const read = readToken(token);
    if (read === null) return null;
    const changed = await setChoice(read.userId, read.kind.key, false, source);
    return { userId: read.userId, kind: read.kind, changed };
  }

  async function resubscribe(token: unknown): Promise<UnsubscribeResult | null> {
    const read = readToken(token);
    if (read === null || kinds.kind(read.kind.key) === null) return null;
    const changed = await setChoice(read.userId, read.kind.key, true, "link");
    return { userId: read.userId, kind: read.kind, changed };
  }

  // -------------------------------------------------------------------------
  // The ledger
  // -------------------------------------------------------------------------

  /** May this ledger row be claimed again (a retry still owed, or a cut-off claim with idempotent sends)? */
  function reclaimable(row: { status: string; retryable: boolean; attempts: number; nextAt: Date | null; claimedAt: Date | null }, now: Date): boolean {
    if (row.attempts >= MAX_ATTEMPTS) return false;
    if (row.status === "failed") return row.retryable && (row.nextAt === null || row.nextAt.getTime() <= now.getTime());
    if (row.status === "sending") return idempotent && row.claimedAt !== null && now.getTime() - row.claimedAt.getTime() > STALE_CLAIM_MS;
    return false;
  }

  /** Claim one person's email for one key: the insert, else a retry still owed. Null: someone already has it. */
  async function claim(userId: string, kind: string, dedupeKey: string): Promise<{ id: string; attempts: number } | null> {
    const now = clock();
    const [fresh] = await db
      .insert(t.sends)
      .values({ id: newId(), userId, kind, dedupeKey, status: "sending", attempts: 1, claimedAt: now, createdAt: now, updatedAt: now })
      .onConflictDoNothing({ target: [t.sends.userId, t.sends.kind, t.sends.dedupeKey] })
      .returning({ id: t.sends.id, attempts: t.sends.attempts });
    if (fresh) return fresh;
    const owed = and(eq(t.sends.status, "failed"), eq(t.sends.retryable, true), or(isNull(t.sends.nextAt), lte(t.sends.nextAt, now)));
    const cutOff = and(eq(t.sends.status, "sending"), lt(t.sends.claimedAt, new Date(now.getTime() - STALE_CLAIM_MS)));
    const [again] = await db
      .update(t.sends)
      .set({ status: "sending", attempts: sql`${t.sends.attempts} + 1`, claimedAt: now, updatedAt: now })
      .where(
        and(
          eq(t.sends.userId, userId),
          eq(t.sends.kind, kind),
          eq(t.sends.dedupeKey, dedupeKey),
          lt(t.sends.attempts, MAX_ATTEMPTS),
          idempotent ? or(owed, cutOff) : owed,
        ),
      )
      .returning({ id: t.sends.id, attempts: t.sends.attempts });
    return again ?? null;
  }

  async function finish(id: string, attempts: number, outcome: DigestSendOutcome | { status: "empty" }, sections: readonly string[]): Promise<void> {
    const now = clock();
    const failed = outcome.status === "failed";
    const retryable = failed && outcome.retryable && idempotent && attempts < MAX_ATTEMPTS;
    await db
      .update(t.sends)
      .set({
        status: outcome.status,
        retryable,
        nextAt: retryable ? new Date(now.getTime() + 5 * 60_000 * 2 ** (attempts - 1)) : null,
        finishedAt: failed && retryable ? null : now,
        sections: [...sections],
        error: failed ? cut(outcome.error) : null,
        updatedAt: now,
      })
      .where(eq(t.sends.id, id));
  }

  /** The claims a crash cut off, when a send can't be repeated safely: failed, and never tried again. */
  async function closeCutOffClaims(): Promise<void> {
    if (idempotent) return;
    const now = clock();
    await db
      .update(t.sends)
      .set({ status: "failed", retryable: false, finishedAt: now, error: "Cut off while sending. It may not have gone, and it isn't sent again so nobody gets two.", updatedAt: now })
      .where(and(eq(t.sends.status, "sending"), lt(t.sends.claimedAt, new Date(now.getTime() - STALE_CLAIM_MS))));
  }

  async function send(outgoing: DigestOutgoing): Promise<DigestSendOutcome> {
    try {
      return await options.send(outgoing);
    } catch (error) {
      return { status: "failed", error: message(error), retryable: true };
    }
  }

  // -------------------------------------------------------------------------
  // Building a digest
  // -------------------------------------------------------------------------

  async function build(
    digest: DigestSpec,
    person: DigestRecipient,
    day: DigestDay,
  ): Promise<{ key: string; content: DigestSectionContent | null; error: string | null }[]> {
    const out: { key: string; content: DigestSectionContent | null; error: string | null }[] = [];
    for (const section of digest.sections) {
      try {
        const content = await section.render(person, day);
        if (content !== null && content !== undefined) {
          if (typeof content.title !== "string" || typeof content.text !== "string" || !isSafeHtml(content.html)) {
            throw new DigestInputError(`section "${section.key}" must return { title, text, html } with html made by the html tag (or null)`);
          }
        }
        out.push({ key: section.key, content: content ?? null, error: null });
      } catch (error) {
        report(error, { step: `section:${section.key}`, userId: person.userId, kind: digest.key });
        out.push({ key: section.key, content: null, error: message(error) });
      }
    }
    return out;
  }

  function render(digest: DigestSpec, kind: EmailKind, person: DigestRecipient, day: DigestDay, sections: readonly DigestSectionContent[]): RenderedEmail {
    return renderDigestEmail({
      siteName: options.siteName,
      digest,
      kind,
      person,
      day,
      sections,
      links: links(person.userId, digest.key),
      ...(options.theme ? { theme: options.theme } : {}),
    });
  }

  async function run(runOptions: { readonly timeBudgetMs?: number } = {}): Promise<DigestRunResult> {
    const deadline = clock().getTime() + (runOptions.timeBudgetMs ?? 45_000);
    let stopped = false;
    let lastProviderAt = 0;
    const tallies: DigestRunTally[] = [];
    await closeCutOffClaims();

    for (const digest of kinds.digests) {
      const kind = kinds.kind(digest.key);
      if (kind === null) continue; // no sections: offered nowhere, sent never
      const tally = { key: digest.key, subscribed: 0, due: 0, sent: 0, skipped: 0, empty: 0, failed: 0, waiting: 0 };
      const said = await db
        .select({
          userId: t.subscriptions.userId,
          chosenAt: t.subscriptions.changedAt,
          timeZone: t.preferences.timeZone,
          deliveryHour: t.preferences.deliveryHour,
        })
        .from(t.subscriptions)
        .leftJoin(t.preferences, eq(t.preferences.userId, t.subscriptions.userId))
        .where(and(eq(t.subscriptions.kind, digest.key), eq(t.subscriptions.subscribed, true)));
      tally.subscribed = said.length;
      const now = clock();
      const open = said
        .map((row) => {
          const zone = isTimeZone(row.timeZone) ? row.timeZone : siteTimeZone;
          const hour = validHour(row.deliveryHour) ? row.deliveryHour : defaultHour;
          return { userId: row.userId, zone, hour, window: deliveryWindow(now, zone, hour), chosenOn: localDay(row.chosenAt, zone) };
        })
        // A window for a day before the person said yes isn't theirs. Before
        // their hour the window still open is the day before's, so someone
        // who ticks the box at 5 AM would get that one now and today's at 7:
        // two in one morning. They get today's at 7; after their hour,
        // today's at once.
        .filter((entry) => entry.window.day >= entry.chosenOn);
      const days = [...new Set(open.map((entry) => entry.window.day))];
      const ledger =
        days.length === 0
          ? []
          : await db
              .select({
                userId: t.sends.userId,
                dedupeKey: t.sends.dedupeKey,
                status: t.sends.status,
                retryable: t.sends.retryable,
                attempts: t.sends.attempts,
                nextAt: t.sends.nextAt,
                claimedAt: t.sends.claimedAt,
              })
              .from(t.sends)
              .where(and(eq(t.sends.kind, digest.key), inArray(t.sends.dedupeKey, days)));
      const done = new Map(ledger.map((row) => [`${row.userId}\n${row.dedupeKey}`, row]));
      const due = open
        .filter((entry) => {
          const row = done.get(`${entry.userId}\n${entry.window.day}`);
          return row === undefined || reclaimable(row, now);
        })
        // The longest-waiting first, so a run that runs out of time leaves the newest.
        .sort((a, b) => a.window.opensAt.getTime() - b.window.opensAt.getTime());
      tally.due = due.length;

      let reached = 0;
      for (let start = 0; start < due.length && !stopped; start += PEOPLE_BATCH) {
        const batch = due.slice(start, start + PEOPLE_BATCH);
        const found = new Map((await options.people(batch.map((entry) => entry.userId))).map((person) => [person.userId, person]));
        for (const entry of batch) {
          const wait = Math.max(0, lastProviderAt + interval - clock().getTime());
          if (clock().getTime() + wait + sendTimeout + CRON_MARGIN_MS > deadline) {
            stopped = true;
            break;
          }
          reached += 1;
          const person = found.get(entry.userId);
          // Gone, suspended or without an address: nothing written, nothing sent.
          if (!person || !person.email) continue;
          const claimed = await claim(entry.userId, digest.key, entry.window.day);
          if (claimed === null) continue;
          const recipient: DigestRecipient = { ...person, timeZone: entry.zone, deliveryHour: entry.hour };
          const day = digestDay(entry.window.day, entry.zone, locale);
          let outcome: DigestSendOutcome | { status: "empty" };
          let sectionKeys: string[] = [];
          try {
            const built = await build(digest, recipient, day);
            const included = built.filter((section) => section.content !== null);
            sectionKeys = included.map((section) => section.key);
            if (included.length === 0) {
              outcome = { status: "empty" };
            } else {
              const email = render(digest, kind, recipient, day, included.map((section) => section.content!));
              const pause = Math.max(0, lastProviderAt + interval - clock().getTime());
              if (pause > 0) await sleep(pause);
              outcome = await send({
                to: person.email,
                subject: email.subject,
                html: email.html,
                text: email.text,
                headers: headersFor(person.userId, digest.key),
                idempotencyKey: idempotencyKeyFor("digest", digest.key, person.userId, entry.window.day),
                template: `digest:${digest.key}`,
                userId: person.userId,
                kind: digest.key,
              });
              if (outcome.status !== "skipped") lastProviderAt = clock().getTime();
            }
          } catch (error) {
            outcome = { status: "failed", error: message(error), retryable: false };
          }
          await finish(claimed.id, claimed.attempts, outcome, sectionKeys);
          if (outcome.status === "failed") report(new Error(`The ${digest.title} to a person failed: ${outcome.error}`), { step: "send", userId: person.userId, kind: digest.key });
          tally[outcome.status] += 1;
        }
      }
      tally.waiting = due.length - reached;
      tallies.push(tally);
      // The digests after this one wait for the next run (not looked at).
      if (stopped) break;
    }
    return { digests: tallies, stoppedEarly: stopped };
  }

  async function preview(input: { readonly userId: string; readonly digest: string; readonly day?: string }): Promise<DigestPreview> {
    const digest = kinds.digest(input.digest);
    const kind = kinds.kind(input.digest);
    if (digest === null || kind === null || kind.type !== "digest") throw new DigestInputError(`"${input.digest}" isn't a digest this site sends`);
    if (input.day !== undefined && !isDay(input.day)) throw new DigestInputError(`"${input.day}" isn't a day written YYYY-MM-DD`);
    const row = await preferenceRow(input.userId);
    const { zone, hour } = clockOf(row);
    const date = input.day ?? deliveryWindow(clock(), zone, hour).day;
    const [person] = (await options.people([input.userId])).filter((p) => p.userId === input.userId);
    const [subscription] = await db
      .select({ subscribed: t.subscriptions.subscribed })
      .from(t.subscriptions)
      .where(and(eq(t.subscriptions.userId, input.userId), eq(t.subscriptions.kind, digest.key)))
      .limit(1);
    const [entry] = await db
      .select({ status: t.sends.status, finishedAt: t.sends.finishedAt })
      .from(t.sends)
      .where(and(eq(t.sends.userId, input.userId), eq(t.sends.kind, digest.key), eq(t.sends.dedupeKey, date)))
      .limit(1);
    const recipient: DigestRecipient = { userId: input.userId, email: person?.email ?? "", name: person?.name ?? null, timeZone: zone, deliveryHour: hour };
    const day = digestDay(date, zone, locale);
    const built = await build(digest, recipient, day);
    const included = built.filter((section) => section.content !== null);
    return {
      digest: digest.key,
      day: date,
      timeZone: zone,
      deliveryHour: hour,
      person: person ?? null,
      subscribed: subscription?.subscribed === true,
      ledger: entry ? { status: entry.status, finishedAt: entry.finishedAt } : null,
      sections: built.map((section) => ({ key: section.key, included: section.content !== null, title: section.content?.title ?? null, error: section.error })),
      email: included.length === 0 ? null : render(digest, kind, recipient, day, included.map((section) => section.content!)),
    };
  }

  async function sendAlert(input: {
    readonly userId: string;
    readonly kind: string;
    readonly dedupeKey?: string;
    readonly subject: string;
    readonly text: string;
    readonly html: SafeHtml;
  }): Promise<AlertSendResult> {
    const kind = kinds.kind(input.kind);
    if (kind === null || kind.type !== "alert") throw new InvalidEmailKindError(`"${input.kind}" isn't an alert kind this site registered`);
    if (typeof input.subject !== "string" || input.subject.trim() === "") throw new DigestInputError("an alert needs a subject");
    if (!isSafeHtml(input.html)) throw new DigestInputError("an alert's html must be made with the html tag");
    const dedupeKey = input.dedupeKey ?? newId();
    if (dedupeKey.length === 0 || dedupeKey.length > 200) throw new DigestInputError("dedupeKey must be 1 to 200 characters");
    const [subscription] = await db
      .select({ subscribed: t.subscriptions.subscribed })
      .from(t.subscriptions)
      .where(and(eq(t.subscriptions.userId, input.userId), eq(t.subscriptions.kind, kind.key)))
      .limit(1);
    if (subscription?.subscribed !== true) return { status: "not-subscribed" };
    const [person] = (await options.people([input.userId])).filter((p) => p.userId === input.userId);
    if (!person || !person.email) return { status: "no-person" };
    const claimed = await claim(person.userId, kind.key, dedupeKey);
    if (claimed === null) return { status: "duplicate" };
    const email = renderAlertEmail({
      siteName: options.siteName,
      kind,
      subject: input.subject,
      text: input.text,
      html: input.html,
      links: links(person.userId, kind.key),
      ...(options.theme ? { theme: options.theme } : {}),
    });
    const outcome = await send({
      to: person.email,
      subject: email.subject,
      html: email.html,
      text: email.text,
      headers: headersFor(person.userId, kind.key),
      idempotencyKey: idempotencyKeyFor("alert", kind.key, person.userId, dedupeKey),
      template: `alert:${kind.key}`,
      userId: person.userId,
      kind: kind.key,
    });
    await finish(claimed.id, claimed.attempts, outcome, []);
    if (outcome.status === "failed") {
      report(new Error(`An alert (${kind.title}) to a person failed: ${outcome.error}`), { step: "alert", userId: person.userId, kind: kind.key });
      return { status: "failed", error: outcome.error };
    }
    return { status: outcome.status };
  }

  async function forgetPerson(userId: string): Promise<number> {
    if (!userId) throw new DigestInputError("a person is required");
    const sends = await db.delete(t.sends).where(eq(t.sends.userId, userId)).returning({ id: t.sends.id });
    const subscriptions = await db.delete(t.subscriptions).where(eq(t.subscriptions.userId, userId)).returning({ kind: t.subscriptions.kind });
    const preferences = await db.delete(t.preferences).where(eq(t.preferences.userId, userId)).returning({ userId: t.preferences.userId });
    return sends.length + subscriptions.length + preferences.length;
  }

  return Object.freeze({
    kinds,
    siteTimeZone,
    preferencesOf,
    savePreferences,
    rememberTimeZone,
    applySignUpChoice,
    setChoice,
    unsubscribeToken,
    unsubscribeUrl,
    oneClickUrl,
    readToken,
    unsubscribe,
    resubscribe,
    run,
    preview,
    sendAlert,
    forgetPerson,
  });
}
