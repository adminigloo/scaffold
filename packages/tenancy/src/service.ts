import { sql, type SQL } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import {
  generateInvitationToken,
  hashInvitationToken,
  invitationState,
  normaliseInviteEmail,
  verifyInvitationToken,
  type InvitationState,
} from "./invitations.js";

/**
 * The half of invitations that touches the database.
 *
 * `invitations.ts` beside this file owns the arithmetic — mint a token, hash
 * it, decide what a row means. None of that puts anybody in a tenant. This
 * module is the hop that does: it turns "somebody is holding a link" into a
 * `tenant_members` row and a `principal_role` row, and it is the only place in
 * the scaffold allowed to do so from a token.
 *
 * WHAT BREAKS WITHOUT IT is not the compile — it is the product. An invitation
 * feature whose accept path writes no membership issues links that look
 * correct, spend correctly, audit correctly, and leave the invitee outside the
 * organisation with a green screen telling them they are in. Nothing fails; the
 * roster is simply short by one person, and the only evidence is a consumed
 * invitation with no member behind it.
 *
 * THE WRITES ARE ONE TRANSACTION, AND THAT IS THE POINT. Marking an invitation
 * consumed and creating the membership are two statements describing one fact.
 * Split across two round trips, a crash, a timeout or a recycled serverless
 * instance between them leaves a spent token and no member — unrecoverable from
 * the application, because the plaintext token is gone and the row says the job
 * is done. Re-issuing does not help either: the partial unique index only
 * covers rows that are neither accepted nor revoked, so the dead row sits
 * outside it and a second invitation to the same address is allowed to exist
 * beside a membership that never happened.
 *
 * SINGLE USE IS ENFORCED BY THE DATABASE, NOT BY A READ-THEN-WRITE. The row is
 * taken with `SELECT … FOR UPDATE` before anything is decided, so two
 * simultaneous redemptions of one link serialise on the row rather than both
 * observing "pending" and both inserting. The loser is not an exception: it
 * wakes up, re-reads the row it now holds the lock on, finds it accepted, finds
 * the membership already there, and answers `already-a-member`. A double-click
 * on the accept button is the ordinary case here, not a thought experiment.
 *
 * NO TABLE OBJECTS, NO `drizzle-orm/pg-core`, DELIBERATELY. This module is
 * reachable from the package root, and the root is imported by client
 * components for `TENANT_ROLE_TEMPLATES`. Importing the schema — from here or
 * from `@adminigloo/permissions/schema` — would drag the query builder into
 * every one of those bundles, and importing `@adminigloo/db` for `newId` would
 * drag the Neon driver and `ws` with it, which does not merely bloat a client
 * bundle, it fails to build. So the statements are written as SQL against an
 * `execute`-shaped handle, which is also what lets a transaction, a test double
 * or next year's driver satisfy the dependency with no cast at the call site.
 */

/**
 * The sentinel tenant that firm-wide rows use, mirroring `FIRM_WIDE` from
 * `@adminigloo/permissions`.
 *
 * Copied rather than imported for the bundle reason above: that package's root
 * re-exports the constant from the module that declares the tables, so reading
 * it here would pull `drizzle-orm/pg-core` into every client component that
 * imports a tenancy helper. The two are pinned together by a test that DOES
 * import it — a test runs in Node and pays no bundle cost.
 */
const FIRM_WIDE_TENANT = "*";

/** Seven days. The expiry used when a caller does not name one. */
export const DEFAULT_INVITATION_EXPIRY_HOURS = 24 * 7;

/**
 * The narrowest shape of a Drizzle handle this service can work through.
 *
 * `execute` rather than the query builder, for the reason in the block comment
 * above: taking `db.insert(tenantMembers)` would mean importing the table
 * VALUE. Two methods rather than one, because atomicity is not optional here —
 * a handle that cannot open a transaction cannot satisfy this contract, and
 * accepting one that only has `execute` would let the guarantee be lost at a
 * call site instead of at the type.
 *
 * The transaction callback receives the same shape, so a savepoint is a valid
 * argument and so is a plain object in a test.
 */
export interface InvitationDb {
  execute(query: SQL): PromiseLike<unknown>;
  transaction<T>(fn: (tx: InvitationDb) => Promise<T>): Promise<T>;
}

export interface CreateInvitationServiceDeps {
  readonly db: InvitationDb;
  /**
   * The clock, injectable so a test can sit either side of an expiry.
   *
   * ONE CLOCK GOVERNS ONE DECISION. Expiry is compared in JavaScript by
   * `invitationState`, and `expires_at` was written from this same clock in
   * `send`, so the stamp written by `accept` comes from here too rather than
   * from the database's `now()`. Mixing the two lets a skewed application clock
   * classify a row as live and then stamp it accepted at an instant the
   * database considers earlier than the row's own expiry — the kind of
   * inconsistency that surfaces only as a timeline nobody can explain.
   */
  readonly now?: () => Date;
  /** Expiry applied when `send` is not given one. */
  readonly defaultExpiryHours?: number;
  /**
   * Must the accepting account's verified address match the invited one?
   *
   * *** THE SECURITY REGIME OF THE ACCEPT PATH, DECIDED HERE. ***
   *
   * Better Auth's analysis of invitation links splits them in two. An OPAQUE,
   * UNGUESSABLE token can safely skip a second identity check, because holding
   * the link is itself evidence that the holder received the mail it was sent
   * in; nothing else could have produced the value. A PREDICTABLE or ENUMERABLE
   * one cannot, because the link proves nothing — anybody able to guess it
   * arrives holding the same evidence as the invitee — so such a scheme must
   * require the accepting account's verified address to match the invited one.
   *
   * WHICH REGIME IS THIS SCAFFOLD IN: the first. `generateInvitationToken`
   * returns `randomBytes(32).toString("base64url")` — 256 bits from the
   * platform CSPRNG, 43 characters, no counter, no timestamp, no tenant id, no
   * sequence to walk. Only its SHA-256 is stored and `tenant_invitations` is
   * indexed on that hash, so a database dump yields no links either. On the
   * strict reading of that analysis, matching the email is not REQUIRED here.
   *
   * IT IS STILL THE DEFAULT, AND ON PURPOSE. Unguessability defends against an
   * attacker who never saw the link. It does nothing whatsoever about the
   * people who did: the mail traverses relays and scanners, lands in a shared
   * mailbox, gets forwarded to the wrong colleague, pasted into a group chat,
   * or auto-completed to last week's recipient. What sits at the end of this
   * particular link is not a login, it is a ROLE inside somebody else's
   * organisation — the same grant the inviting router guards with a strict rank
   * comparison, precisely because handing one out is how a quiet privilege
   * escalation happens. Requiring the address to match turns a misdirected link
   * into a `wrong-email` screen, which is recoverable and explains itself;
   * without it the same accident is an audited, entirely correct-looking join
   * by the wrong person, and nothing in the trail marks it as wrong.
   *
   * The address compared is the one the identity provider verified and mirrored
   * into `users.email`, never one the caller supplied — `accept` takes a user id
   * and looks the address up itself, so a client cannot present the address it
   * would like to be judged against. An account whose mirrored address is NULL
   * fails the comparison: "we do not know who you are" must not read as "you
   * match".
   *
   * Set it false to take the regime the token strength actually permits. The
   * cost of leaving it true is the invitee whose account uses a different
   * address from the one they were invited at, which is why this is a default
   * and not a law; the cost of setting it false is that a forwarded link works
   * for whoever opens it first.
   */
  readonly requireMatchingEmail?: boolean;
  /**
   * How the accepting account's verified address is found.
   *
   * Defaults to reading `users.email` from the identity mirror that
   * `@adminigloo/auth` owns. Tenancy deliberately does not DEPEND on that
   * package — membership must be installable without an identity provider's
   * schema, exactly as `tenant_members.user_id` carries no foreign key — so the
   * default is a read of one column by name, and a project whose accounts live
   * somewhere else replaces it here rather than forking the service.
   *
   * Returning null means "no verified address on file", which fails the match.
   */
  readonly resolveAccepterEmail?: (
    db: InvitationDb,
    userId: string,
  ) => Promise<string | null>;
}

export interface SendInvitationInput {
  readonly tenantId: string;
  readonly email: string;
  readonly roleTemplateKey: string;
  readonly invitedByUserId: string;
  readonly expiresInHours?: number;
}

export interface SentInvitation {
  readonly id: string;
  /** Returned ONCE. Never stored in plaintext, never logged. */
  readonly token: string;
  readonly expiresAt: Date;
}

/**
 * Everything redeeming a token can mean.
 *
 * A UNION RATHER THAN EXCEPTIONS, because five of these six are not errors.
 * "Your link expired", "somebody withdrew it", "you were already in", "this was
 * sent to a different address" and "we do not recognise this" are five
 * different facts with five different next steps, and a thrown error collapses
 * them into one message that helps with none of them. The invitee is the person
 * in this whole feature with the least context; they are the last person who
 * should be handed a generic failure.
 *
 * `unknown-token` covers a token that never existed and one that has been
 * spent, deliberately and identically. Telling them apart would turn this into
 * an oracle for anybody holding a list of guesses, and no honest caller has a
 * use for the distinction.
 */
export type AcceptResult =
  | { readonly status: "accepted"; readonly tenantId: string }
  | { readonly status: "already-a-member"; readonly tenantId: string }
  | { readonly status: "expired" }
  | { readonly status: "revoked" }
  /** The invited address, for the caller's own logs. Never show it to the holder. */
  | { readonly status: "wrong-email"; readonly invitedEmail: string }
  | { readonly status: "unknown-token" };

export interface InvitationSummary {
  readonly id: string;
  readonly email: string;
  /**
   * The role the invitation carries.
   *
   * Empty when the template it named has since been deleted. The row is still
   * listed — hiding it would leave an invitation that can be redeemed and
   * cannot be seen or withdrawn — and re-sending such a row is refused
   * downstream, because the rank guard denies an unknown key. It fails closed
   * in the one direction that matters.
   */
  readonly roleTemplateKey: string;
  readonly state: InvitationState;
  /** NULL means it never expires. */
  readonly expiresAt: Date | null;
  readonly createdAt: Date;
}

export interface InvitationService {
  /**
   * Issue one, or re-issue the open one for this address.
   *
   * The plaintext token exists for the duration of this call and is written
   * nowhere; only its SHA-256 reaches the database. That is what makes "resend
   * the same link" impossible and a database dump useless, and it is why
   * re-issuing UPSERTS on the partial unique index rather than inserting a
   * second row: pressing resend twice must not leave two live invitations
   * racing for one address.
   */
  send(input: SendInvitationInput): Promise<SentInvitation>;
  /** Redeem a token. Answers with an outcome; does not throw for a refusal. */
  accept(token: string, userId: string): Promise<AcceptResult>;
  /** Withdraw one. Idempotent — the first withdrawal keeps its timestamp. */
  revoke(id: string, byUserId: string): Promise<void>;
  /** Every invitation this tenant has ever issued, newest first. */
  listForTenant(tenantId: string): Promise<InvitationSummary[]>;
}

/**
 * A role that has to exist before anybody can be granted it.
 *
 * Thrown rather than degraded, and the distinction is worth stating: the
 * scaffold's rule is that a missing CREDENTIAL degrades to a documented no-op,
 * because a laptop with no API key must still boot. A missing role template is
 * not a missing credential, it is an unseeded `role_template` table, and
 * quietly issuing an invitation that grants nothing would produce a member with
 * no role and no explanation of why.
 */
export class UnknownRoleTemplateError extends Error {
  readonly name = "UnknownRoleTemplateError";
  constructor(readonly roleTemplateKey: string) {
    super(
      `No tenant role template is seeded under the key "${roleTemplateKey}", ` +
        `so an invitation carrying it would grant nothing. Run \`pnpm db:seed\` ` +
        `to create the shipped templates, or invite at a key that exists.`,
    );
  }
}

/**
 * A driver whose `execute` returned something with no rows in it.
 *
 * Drivers disagree about the shape: node-postgres and the Neon WebSocket client
 * resolve to `{ rows: [...] }`, some HTTP clients resolve to the array itself.
 * Both are read. Anything else throws rather than being treated as an empty
 * result, because "no rows" is a MEANINGFUL answer here — it is how an unknown
 * token and a lost race are both reported — and manufacturing it from a shape
 * we failed to understand would report every invitation in the system as
 * unrecognised.
 */
export class UnreadableDriverResultError extends Error {
  readonly name = "UnreadableDriverResultError";
  constructor(received: unknown) {
    super(
      `The database driver returned a result this service cannot read rows ` +
        `from (got ${describe(received)}). It expects either an array of rows ` +
        `or an object with a \`rows\` array, which is what node-postgres and ` +
        `the Neon clients both produce.`,
    );
  }
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return typeof value;
}

type Row = Record<string, unknown>;

function rowsOf(result: unknown): readonly Row[] {
  if (Array.isArray(result)) return result as readonly Row[];
  if (typeof result === "object" && result !== null) {
    const rows = (result as { rows?: unknown }).rows;
    if (Array.isArray(rows)) return rows as readonly Row[];
  }
  throw new UnreadableDriverResultError(result);
}

async function query(db: InvitationDb, statement: SQL): Promise<readonly Row[]> {
  return rowsOf(await db.execute(statement));
}

function text(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "");
}

/**
 * A timestamptz as it comes back from whichever driver is underneath.
 *
 * node-postgres parses one into a Date; an HTTP driver configured without type
 * parsers hands back the ISO string. Reading only `instanceof Date` would make
 * every invitation on the second kind of driver look as though it had no
 * expiry — which `invitationState` reads as "never expires", the less safe of
 * the two possible mistakes.
 */
function readDate(value: unknown): Date | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === "string" || typeof value === "number") {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}

/** A NOT NULL timestamp column, so a null here means the row is broken. */
function readRequiredDate(value: unknown, column: string): Date {
  const parsed = readDate(value);
  if (parsed === null) {
    throw new Error(`${column} came back as ${describe(value)}, which is not a time.`);
  }
  return parsed;
}

const DEFAULT_RESOLVE_ACCEPTER_EMAIL = async (
  db: InvitationDb,
  userId: string,
): Promise<string | null> => {
  const rows = await query(
    db,
    sql`/* adminigloo:invitations/accepter-email */
      select email from users where id = ${userId} and deleted_at is null limit 1`,
  );
  const email = rows[0]?.["email"];
  return typeof email === "string" ? normaliseInviteEmail(email) : null;
};

export function createInvitationService(
  deps: CreateInvitationServiceDeps,
): InvitationService {
  const { db } = deps;
  const clock = deps.now ?? ((): Date => new Date());
  const requireMatchingEmail = deps.requireMatchingEmail ?? true;
  const resolveAccepterEmail =
    deps.resolveAccepterEmail ?? DEFAULT_RESOLVE_ACCEPTER_EMAIL;
  const defaultExpiryHours = positiveHours(
    deps.defaultExpiryHours,
    DEFAULT_INVITATION_EXPIRY_HOURS,
  );

  async function templateIdFor(key: string): Promise<string> {
    const rows = await query(
      db,
      sql`/* adminigloo:invitations/template-by-key */
        select id from role_template
        where scope = 'tenant'
          and tenant_id = ${FIRM_WIDE_TENANT}
          and key = ${key}
          and deleted_at is null
        limit 1`,
    );
    const id = rows[0]?.["id"];
    if (typeof id !== "string" || id.length === 0) {
      throw new UnknownRoleTemplateError(key);
    }
    return id;
  }

  async function isMember(
    handle: InvitationDb,
    tenantId: string,
    userId: string,
  ): Promise<boolean> {
    const rows = await query(
      handle,
      sql`/* adminigloo:invitations/member-exists */
        select 1 as present from tenant_members
        where tenant_id = ${tenantId} and user_id = ${userId}
        limit 1`,
    );
    return rows.length > 0;
  }

  return {
    async send(input: SendInvitationInput): Promise<SentInvitation> {
      const email = normaliseInviteEmail(input.email);
      // Resolved before the token is minted, so a role key with nothing behind
      // it cannot leave a live invitation that grants nothing.
      const templateId = await templateIdFor(input.roleTemplateKey);

      const { token, tokenHash } = generateInvitationToken();
      const hours = positiveHours(input.expiresInHours, defaultExpiryHours);
      const expiresAt = new Date(clock().getTime() + hours * 3_600_000);

      // The id is minted here because `id` has no database-side default: the
      // convention is a UUID v7 produced in JavaScript. `newId` from
      // @adminigloo/db is the same call and is deliberately not imported — that
      // package's entry point configures the Neon WebSocket driver at module
      // load, which would follow this module into every client bundle that
      // touches the package root.
      const id = uuidv7();

      // UPSERT ON THE PARTIAL UNIQUE INDEX. Re-issuing rotates the hash and
      // pushes the expiry out on the SAME row, which is what that index was
      // designed for: it cannot exclude expired rows, because Postgres requires
      // an index predicate to be IMMUTABLE, so a plain insert against an address
      // holding a dead invitation would fail on a unique violation rather than
      // replace it.
      const rows = await query(
        db,
        sql`/* adminigloo:invitations/upsert */
          insert into tenant_invitations
            (id, tenant_id, email, template_id, token_hash, expires_at, invited_by)
          values
            (${id}, ${input.tenantId}, ${email}, ${templateId}, ${tokenHash},
             ${expiresAt}, ${input.invitedByUserId})
          on conflict (tenant_id, email)
            where accepted_at is null and revoked_at is null
          do update set
            token_hash = excluded.token_hash,
            template_id = excluded.template_id,
            expires_at = excluded.expires_at,
            invited_by = excluded.invited_by
          returning id`,
      );

      const written = rows[0]?.["id"];
      if (typeof written !== "string") {
        // Unreachable through the index above, and worth saying out loud: an
        // upsert that matched nothing would mean no invitation exists while the
        // caller is holding the only copy of a token for it.
        throw new Error(
          "The invitation upsert returned no row, so nothing was stored and the " +
            "token minted for it is already lost.",
        );
      }

      return { id: written, token, expiresAt };
    },

    async accept(token: string, userId: string): Promise<AcceptResult> {
      const tokenHash = hashInvitationToken(token);
      const now = clock();

      return db.transaction(async (tx) => {
        // FOR UPDATE, and everything below happens while that lock is held.
        // Two redemptions of one link serialise here rather than both reading
        // "pending"; the loser resumes after the winner commits and re-reads the
        // row it now owns, which under READ COMMITTED is the updated version.
        // Without the lock both would insert, and the second would either
        // duplicate the grant or die on a primary key from inside a handler that
        // has already told the first invitee they are in.
        const found = await query(
          tx,
          sql`/* adminigloo:invitations/lock-by-token */
            select id, tenant_id, email, template_id, token_hash,
                   expires_at, revoked_at, accepted_at
            from tenant_invitations
            where token_hash = ${tokenHash}
            for update`,
        );

        const row = found[0];
        if (row === undefined) return { status: "unknown-token" };

        // Redundant against the index lookup by design. `verifyInvitationToken`
        // is the one function that owns "is this token this row's token", it
        // compares in constant time, and routing through it means a change to
        // the hash format has one place to be wrong rather than two. It also
        // refuses a row whose stored hash is truncated or garbled, which an
        // equality test in the database would happily match against whatever it
        // managed to decode.
        if (!verifyInvitationToken(token, text(row["token_hash"]))) {
          return { status: "unknown-token" };
        }

        const tenantId = text(row["tenant_id"]);
        const invitedEmail = normaliseInviteEmail(text(row["email"]));

        // THE IDENTITY GATE COMES FIRST, before the state of the invitation is
        // reported. Answering "expired" or "already a member" to somebody this
        // was not sent to would confirm that a token like theirs exists and
        // which organisation it belongs to. Whoever fails this check learns one
        // thing only: it was not for them.
        if (requireMatchingEmail) {
          const accepterEmail = await resolveAccepterEmail(tx, userId);
          if (accepterEmail === null || accepterEmail !== invitedEmail) {
            return { status: "wrong-email", invitedEmail };
          }
        }

        const state = invitationState(
          {
            expiresAt: readDate(row["expires_at"]),
            revokedAt: readDate(row["revoked_at"]),
            acceptedAt: readDate(row["accepted_at"]),
          },
          now,
        );

        if (state === "revoked") return { status: "revoked" };
        if (state === "expired") return { status: "expired" };
        if (state === "accepted") {
          // Spent. If it was spent by THIS account the honest answer is that
          // they are in — which is also what the loser of a double-click sees.
          // If somebody else spent it, the link is simply unusable and says
          // nothing further.
          return (await isMember(tx, tenantId, userId))
            ? { status: "already-a-member", tenantId }
            : { status: "unknown-token" };
        }

        // Already inside, invitation still open. Nothing is consumed and no role
        // is touched: an invitation must never quietly overwrite access somebody
        // already has, and leaving the row pending keeps it visible to whoever
        // sent it, who can then withdraw it or change the role directly.
        if (await isMember(tx, tenantId, userId)) {
          return { status: "already-a-member", tenantId };
        }

        // FROM HERE TO THE END OF THE CALLBACK IS THE ATOMIC PART. Consume, add
        // the member, assign the role. A failure anywhere in it rolls the whole
        // thing back, so the token stays live and the invitee can press the
        // button again.
        const consumed = await query(
          tx,
          sql`/* adminigloo:invitations/consume */
            update tenant_invitations
            set accepted_at = ${now}
            where id = ${text(row["id"])}
              and accepted_at is null
              and revoked_at is null
            returning id`,
        );
        if (consumed.length === 0) {
          // Unreachable while the lock is held. Kept because the alternative to
          // reading it is a membership granted by a statement that updated
          // nothing.
          return { status: "unknown-token" };
        }

        await tx.execute(
          sql`/* adminigloo:invitations/add-member */
            insert into tenant_members (tenant_id, user_id, status)
            values (${tenantId}, ${userId}, 'active')
            on conflict (tenant_id, user_id) do nothing`,
        );

        const templateId = row["template_id"];
        if (typeof templateId === "string" && templateId.length > 0) {
          // DO NOTHING rather than DO UPDATE. One template per person per tenant
          // is a primary key, and an invitation arriving for somebody who
          // somehow already holds a role must not silently move them — in either
          // direction.
          await tx.execute(
            sql`/* adminigloo:invitations/assign-role */
              insert into principal_role (principal_id, scope, tenant_id, template_id)
              values (${userId}, 'tenant', ${tenantId}, ${templateId})
              on conflict (principal_id, scope, tenant_id) do nothing`,
          );
        }
        // A null template_id means the role this invitation named has been
        // deleted since it was sent. The membership still stands: a member with
        // no role is a real, renderable state, and refusing the whole acceptance
        // over a deleted template would strand the invitee with a spent link and
        // nothing to show for it.

        return { status: "accepted", tenantId };
      });
    },

    async revoke(id: string, byUserId: string): Promise<void> {
      // `revoked_at is null` rather than a blind update, so pressing withdraw
      // twice keeps the first timestamp. Accepted rows stay revocable on
      // purpose: `invitationState` ranks revoked above accepted precisely
      // because withdrawing one is usually a response to the wrong person having
      // used it, and an undo that silently did nothing in that case would be
      // worse than no undo at all.
      await db.execute(
        sql`/* adminigloo:invitations/revoke */
          update tenant_invitations
          set revoked_at = ${clock()}, revoked_by = ${byUserId}
          where id = ${id} and revoked_at is null`,
      );
    },

    async listForTenant(tenantId: string): Promise<InvitationSummary[]> {
      const now = clock();
      const rows = await query(
        db,
        sql`/* adminigloo:invitations/list-for-tenant */
          select i.id, i.email, i.expires_at, i.revoked_at, i.accepted_at,
                 i.created_at, t.key as role_template_key
          from tenant_invitations i
          left join role_template t on t.id = i.template_id
          where i.tenant_id = ${tenantId}
          order by i.created_at desc, i.id desc`,
      );

      return rows.map((row) => ({
        id: text(row["id"]),
        email: text(row["email"]),
        roleTemplateKey:
          typeof row["role_template_key"] === "string" ? row["role_template_key"] : "",
        state: invitationState(
          {
            expiresAt: readDate(row["expires_at"]),
            revokedAt: readDate(row["revoked_at"]),
            acceptedAt: readDate(row["accepted_at"]),
          },
          now,
        ),
        expiresAt: readDate(row["expires_at"]),
        createdAt: readRequiredDate(row["created_at"], "tenant_invitations.created_at"),
      }));
    },
  };
}

/**
 * An expiry in hours, or the fallback.
 *
 * A zero, a negative or a NaN produces an invitation that is dead before the
 * mail is written, which reads to the invitee as a link that never worked.
 * Substituting the default is the only outcome that leaves a usable invitation,
 * and it is a substitution rather than a throw because the value arrives from
 * configuration, not from a stranger.
 */
function positiveHours(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}
