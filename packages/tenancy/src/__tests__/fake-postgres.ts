import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import type { InvitationDb } from "../service.js";

/**
 * A Postgres small enough to reason about, for the statements this package
 * actually sends.
 *
 * WHY NOT A MOCK OF THE SERVICE'S OWN METHODS: because the thing worth testing
 * here is the SQL. The invitation service is a handful of statements and the
 * order they run in; stubbing them out and asserting the branches would prove
 * only that the branches exist, which is exactly the level of confidence that
 * let an entire missing service pass a green suite. This runs the real
 * statements through Drizzle's own dialect, so the parameters are the
 * parameters the driver would receive, in the order it would receive them.
 *
 * WHY NOT A REAL DATABASE: the concurrent-accept case is the one that matters
 * most and it needs two redemptions genuinely interleaved. Against real
 * Postgres that is a second connection and a suite that will not run on a
 * laptop with no DATABASE_URL — which is the state this scaffold insists must
 * always work. Here `for update` is a real queue: the second reader waits for
 * the first transaction to finish and then re-reads, which is what READ
 * COMMITTED does with a locked row.
 *
 * Statements are dispatched on the `/* adminigloo:… *\/` tag each one carries
 * rather than on a fragile substring match. The tags are not test scaffolding —
 * they show up in `pg_stat_activity` and in slow-query logs, which is where you
 * want to be able to tell an invitation lock from every other `SELECT … FOR
 * UPDATE` in the system.
 *
 * IT IS NOT A DATABASE. It has no isolation beyond the row lock, no constraint
 * checking beyond the conflict targets used below, and no planner. What it
 * emulates is exactly what the service depends on, and nothing else.
 */

export interface InvitationRow {
  id: string;
  tenant_id: string;
  email: string;
  template_id: string | null;
  token_hash: string;
  expires_at: Date | null;
  revoked_at: Date | null;
  revoked_by: string | null;
  accepted_at: Date | null;
  invited_by: string | null;
  created_at: Date;
}

export interface MemberRow {
  tenant_id: string;
  user_id: string;
  status: string;
}

export interface RoleRow {
  principal_id: string;
  scope: string;
  tenant_id: string;
  template_id: string;
}

export interface TemplateRow {
  id: string;
  scope: string;
  tenant_id: string;
  key: string;
  deleted_at: Date | null;
}

export interface UserRow {
  id: string;
  email: string | null;
  deleted_at: Date | null;
}

export interface FakeTables {
  invitations: InvitationRow[];
  members: MemberRow[];
  roles: RoleRow[];
  templates: TemplateRow[];
  users: UserRow[];
}

export interface FakePostgres {
  readonly db: InvitationDb;
  readonly tables: FakeTables;
  /** Every tag executed, in order. Lets a test assert the lock came first. */
  readonly tags: string[];
  /** Make the next statement carrying this tag throw, once. */
  failNext(tag: string, error: Error): void;
}

const dialect = new PgDialect();

const TAG = /\/\*\s*adminigloo:([\w/.-]+)\s*\*\//;

interface Statement {
  readonly tag: string;
  readonly params: readonly unknown[];
}

function parse(query: SQL): Statement {
  const { sql: text, params } = dialect.sqlToQuery(query);
  const matched = TAG.exec(text);
  if (matched?.[1] === undefined) {
    throw new Error(
      `An untagged statement reached the fake database, so it cannot be ` +
        `dispatched:\n${text}`,
    );
  }
  return { tag: matched[1], params };
}

/** Serialises `for update` on one row, the way Postgres does. */
class RowLocks {
  private readonly queue = new Map<string, Promise<void>>();

  async acquire(key: string): Promise<() => void> {
    const ahead = this.queue.get(key) ?? Promise.resolve();
    let release = (): void => {};
    const mine = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.queue.set(
      key,
      ahead.then(() => mine),
    );
    await ahead;
    return release;
  }
}

export function createFakePostgres(seed: Partial<FakeTables> = {}): FakePostgres {
  const tables: FakeTables = {
    invitations: seed.invitations ?? [],
    members: seed.members ?? [],
    roles: seed.roles ?? [],
    templates: seed.templates ?? [],
    users: seed.users ?? [],
  };
  const tags: string[] = [];
  const locks = new RowLocks();
  const failures = new Map<string, Error>();

  function snapshot(): FakeTables {
    return {
      invitations: tables.invitations.map((row) => ({ ...row })),
      members: tables.members.map((row) => ({ ...row })),
      roles: tables.roles.map((row) => ({ ...row })),
      templates: tables.templates.map((row) => ({ ...row })),
      users: tables.users.map((row) => ({ ...row })),
    };
  }

  function restore(taken: FakeTables): void {
    tables.invitations = taken.invitations;
    tables.members = taken.members;
    tables.roles = taken.roles;
    tables.templates = taken.templates;
    tables.users = taken.users;
  }

  function handle(held: (() => void)[]): InvitationDb {
    return {
      async execute(query: SQL): Promise<{ rows: Record<string, unknown>[] }> {
        const { tag, params } = parse(query);
        tags.push(tag);

        const planted = failures.get(tag);
        if (planted) {
          failures.delete(tag);
          throw planted;
        }

        return { rows: await run(tag, params, held) };
      },
      async transaction<T>(fn: (tx: InvitationDb) => Promise<T>): Promise<T> {
        const before = snapshot();
        const taken: (() => void)[] = [];
        try {
          return await fn(handle(taken));
        } catch (error) {
          restore(before);
          throw error;
        } finally {
          // Locks are held to the end of the transaction and released together,
          // which is the whole reason the loser of a race sees committed state
          // rather than a half-written one.
          for (const release of taken) release();
        }
      },
    };
  }

  async function run(
    tag: string,
    params: readonly unknown[],
    held: (() => void)[],
  ): Promise<Record<string, unknown>[]> {
    switch (tag) {
      case "invitations/template-by-key": {
        const [tenantId, key] = params as [string, string];
        const found = tables.templates.find(
          (row) =>
            row.scope === "tenant" &&
            row.tenant_id === tenantId &&
            row.key === key &&
            row.deleted_at === null,
        );
        return found ? [{ id: found.id }] : [];
      }

      case "invitations/upsert": {
        const [id, tenantId, email, templateId, tokenHash, expiresAt, invitedBy] =
          params as [
            string,
            string,
            string,
            string | null,
            string,
            Date | null,
            string | null,
          ];
        // The partial unique index: (tenant_id, email) among rows that are
        // neither accepted nor revoked.
        const open = tables.invitations.find(
          (row) =>
            row.tenant_id === tenantId &&
            row.email === email &&
            row.accepted_at === null &&
            row.revoked_at === null,
        );
        if (open) {
          open.token_hash = tokenHash;
          open.template_id = templateId;
          open.expires_at = expiresAt;
          open.invited_by = invitedBy;
          return [{ id: open.id }];
        }
        tables.invitations.push({
          id,
          tenant_id: tenantId,
          email,
          template_id: templateId,
          token_hash: tokenHash,
          expires_at: expiresAt,
          revoked_at: null,
          revoked_by: null,
          accepted_at: null,
          invited_by: invitedBy,
          created_at: new Date(),
        });
        return [{ id }];
      }

      case "invitations/accepter-email": {
        const [userId] = params as [string];
        const found = tables.users.find(
          (row) => row.id === userId && row.deleted_at === null,
        );
        return found ? [{ email: found.email }] : [];
      }

      case "invitations/member-exists": {
        const [tenantId, userId] = params as [string, string];
        return tables.members.some(
          (row) => row.tenant_id === tenantId && row.user_id === userId,
        )
          ? [{ present: 1 }]
          : [];
      }

      case "invitations/lock-by-token": {
        const [tokenHash] = params as [string];
        const target = tables.invitations.find((row) => row.token_hash === tokenHash);
        if (!target) return [];
        held.push(await locks.acquire(target.id));
        // Re-read after the wait. Under READ COMMITTED a blocked `for update`
        // re-evaluates against the row version the winner committed, which is
        // the behaviour the loser of a double-click depends on.
        const fresh = tables.invitations.find((row) => row.id === target.id);
        return fresh ? [{ ...fresh }] : [];
      }

      case "invitations/consume": {
        const [acceptedAt, id] = params as [Date, string];
        const target = tables.invitations.find(
          (row) => row.id === id && row.accepted_at === null && row.revoked_at === null,
        );
        if (!target) return [];
        target.accepted_at = acceptedAt;
        return [{ id: target.id }];
      }

      case "invitations/add-member": {
        const [tenantId, userId] = params as [string, string];
        const exists = tables.members.some(
          (row) => row.tenant_id === tenantId && row.user_id === userId,
        );
        if (!exists) {
          tables.members.push({ tenant_id: tenantId, user_id: userId, status: "active" });
        }
        return [];
      }

      case "invitations/assign-role": {
        const [userId, tenantId, templateId] = params as [string, string, string];
        const exists = tables.roles.some(
          (row) =>
            row.principal_id === userId &&
            row.scope === "tenant" &&
            row.tenant_id === tenantId,
        );
        if (!exists) {
          tables.roles.push({
            principal_id: userId,
            scope: "tenant",
            tenant_id: tenantId,
            template_id: templateId,
          });
        }
        return [];
      }

      case "invitations/revoke": {
        const [revokedAt, revokedBy, id] = params as [Date, string, string];
        const target = tables.invitations.find(
          (row) => row.id === id && row.revoked_at === null,
        );
        if (target) {
          target.revoked_at = revokedAt;
          target.revoked_by = revokedBy;
        }
        return [];
      }

      case "invitations/list-for-tenant": {
        const [tenantId] = params as [string];
        return tables.invitations
          .filter((row) => row.tenant_id === tenantId)
          .slice()
          .sort(
            (a, b) =>
              b.created_at.getTime() - a.created_at.getTime() || b.id.localeCompare(a.id),
          )
          .map((row) => {
            const template = tables.templates.find(
              (candidate) => candidate.id === row.template_id,
            );
            return {
              id: row.id,
              email: row.email,
              expires_at: row.expires_at,
              revoked_at: row.revoked_at,
              accepted_at: row.accepted_at,
              created_at: row.created_at,
              role_template_key: template?.key ?? null,
            };
          });
      }

      default:
        throw new Error(`The fake database has no handler for "${tag}".`);
    }
  }

  return {
    db: handle([]),
    tables,
    tags,
    failNext(tag: string, error: Error): void {
      failures.set(tag, error);
    },
  };
}
