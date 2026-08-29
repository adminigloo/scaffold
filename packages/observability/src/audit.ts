import { redactValue } from "./logger.js";

export interface AuditedAction {
  /** Shown in the audit viewer and in the export a compliance reviewer reads. */
  readonly label: string;
  /**
   * The action touched personal or financial data belonging to someone other
   * than the actor: a customer record opened, an export downloaded, an
   * impersonated session started.
   *
   * It is stamped onto the row, not computed at read time, because the query
   * behind it — "who read sensitive data last quarter" — runs against a
   * partial index. A predicate recomputed from a registry that has since
   * changed would return a different answer for the same historical facts.
   */
  readonly sensitive?: boolean;
}

export type AuditedActionMap = Record<string, AuditedAction>;

export interface AuditRegistry<TKey extends string = string> {
  readonly actions: Readonly<Record<TKey, AuditedAction>>;
  readonly keys: readonly TKey[];
  has(key: string): key is TKey;
  get(key: TKey): AuditedAction;
  /** False for an unrecognised key, matching `Catalog.isSealed`. */
  isSensitive(key: string): boolean;
}

export class DuplicateAuditActionError extends Error {
  readonly name = "DuplicateAuditActionError";
  constructor(key: string) {
    super(
      `Audit action "${key}" is declared twice. Two packages claim the same key, ` +
        `so one label and one \`sensitive\` flag would silently win — and which one ` +
        `depends on spread order. Rename one of them.`,
    );
  }
}

export class UnknownAuditActionError extends Error {
  readonly name = "UnknownAuditActionError";
  constructor(key: string) {
    super(
      `Audit action "${key}" is not in the registry. Either it is a typo, or it is ` +
        `an action someone named with a string literal at the call site. Add it to ` +
        `\`defineAuditedActions\` — an action the registry has never heard of is ` +
        `invisible to every audit query written against it.`,
    );
  }
}

/**
 * Declare the vocabulary of auditable actions.
 *
 * Modelled on `definePermissions`, and for the same reason: the value is not
 * the record, it is that there is exactly ONE record.
 *
 * askLou logs some of its actions as inline string literals at the call site —
 * `insert(auditLog).values({ action: "invoice.exported" })` — so an audit
 * sweep that greps the registry misses them entirely. Nothing is broken and
 * nothing is empty; the report is just quietly short, and the actions missing
 * from it are the ad-hoc ones written in a hurry, which is the same set as the
 * ones worth auditing. The registry only works if it is the ONLY way to name
 * an action, which is why `auditEntry` below refuses a key it does not know.
 *
 * Duplicates cannot be expressed in a single object literal — the parser keeps
 * the last one — so, exactly as in `definePermissions`, collisions are caught
 * by re-reading the source fragments an app spread together:
 *
 *   export const auditedActions = defineAuditedActions(
 *     { ...billingActions, ...tenancyActions },
 *     { contributedBy: [billingActions, tenancyActions] },
 *   );
 */
export function defineAuditedActions<const T extends AuditedActionMap>(
  actions: T,
  options: { readonly contributedBy?: readonly AuditedActionMap[] } = {},
): AuditRegistry<Extract<keyof T, string>> {
  type K = Extract<keyof T, string>;

  if (options.contributedBy) {
    const seen = new Set<string>();
    for (const fragment of options.contributedBy) {
      for (const key of Object.keys(fragment)) {
        if (seen.has(key)) throw new DuplicateAuditActionError(key);
        seen.add(key);
      }
    }
  }

  const keys = Object.keys(actions) as K[];
  const sensitive = new Set(keys.filter((k) => actions[k]?.sensitive === true));

  return {
    actions,
    keys,
    has(key): key is K {
      return Object.prototype.hasOwnProperty.call(actions, key);
    },
    get(key) {
      const action = actions[key];
      if (!action) throw new UnknownAuditActionError(key);
      return action;
    },
    isSensitive(key) {
      return sensitive.has(key as K);
    },
  };
}

export type AuditActionKeyOf<TRegistry> =
  TRegistry extends AuditRegistry<infer K> ? K : never;

/**
 * Who performed the action.
 *
 * Structurally satisfied by `Principal` from @adminigloo/auth, so a route
 * passes `ctx.principal` straight in. Typed structurally rather than importing
 * `Principal` to keep this module free of a dependency it only needs two
 * fields from.
 */
export interface AuditActor {
  readonly userId: string;
  /**
   * The staff user acting AS `userId`.
   *
   * Recorded separately, never collapsed into `userId`. Impersonation is the
   * single most audited thing in the product, and attributing an impersonated
   * action to the customer produces an audit trail that actively lies: the
   * customer appears to have deleted their own data.
   */
  readonly impersonatedBy?: string | null;
}

export interface AuditRequestContext {
  readonly ipAddress?: string | null;
  readonly userAgent?: string | null;
}

export interface AuditEntryInput<TKey extends string> {
  readonly action: TKey;
  /** Null for an action taken by a cron job or a webhook, not a person. */
  readonly actor?: AuditActor | null;
  readonly scope?: string | null;
  readonly tenantId?: string | null;
  readonly resourceType?: string | null;
  readonly resourceId?: string | null;
  readonly request?: AuditRequestContext | null;
  readonly metadata?: Record<string, unknown> | null;
}

/** The `audit_log` row, as a plain object. Insert it however you like. */
export interface AuditEntry {
  readonly action: string;
  readonly actorUserId: string | null;
  readonly actorImpersonatedBy: string | null;
  readonly scope: string | null;
  readonly tenantId: string | null;
  readonly resourceType: string | null;
  readonly resourceId: string | null;
  readonly isSensitive: boolean;
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
  readonly metadata: unknown;
}

/**
 * Build the row for an audited action. Pure — no database, no clock.
 *
 * Two things it does that a hand-built object literal does not:
 *
 *   1. `isSensitive` is READ FROM THE REGISTRY and cannot be supplied by the
 *      caller. The compliance query is a partial index on that column, so a
 *      caller who passes `false` for a sensitive action does not merely
 *      mislabel one row — they delete it from the only report anyone runs.
 *   2. `metadata` goes through `redactValue`. It is caller-supplied, it lands
 *      in a `jsonb` column that no reader redacts, and the audit log is the
 *      one table deliberately kept longer than everything else. A token
 *      captured in there outlives the token, the incident and the employee.
 *
 * Throws `UnknownAuditActionError` for a key the registry has not heard of.
 * That throw is the enforcement: a string literal cast to the key type at a
 * call site still fails here, at the first execution, rather than becoming a
 * row nobody can query for.
 */
export function auditEntry<TKey extends string>(
  registry: AuditRegistry<TKey>,
  input: AuditEntryInput<TKey>,
): AuditEntry {
  // Called for the throw as much as for the flag.
  const action = registry.get(input.action);

  return {
    action: input.action,
    actorUserId: input.actor?.userId ?? null,
    actorImpersonatedBy: input.actor?.impersonatedBy ?? null,
    scope: input.scope ?? null,
    tenantId: input.tenantId ?? null,
    resourceType: input.resourceType ?? null,
    resourceId: input.resourceId ?? null,
    isSensitive: action.sensitive === true,
    ipAddress: input.request?.ipAddress ?? null,
    userAgent: input.request?.userAgent ?? null,
    metadata:
      input.metadata === undefined || input.metadata === null
        ? null
        : redactValue(input.metadata),
  };
}
