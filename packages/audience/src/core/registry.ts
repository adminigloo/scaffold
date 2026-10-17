/**
 * ONE AUDIENCE PER COMPANY (0.2): a deployment that serves many companies
 * keeps one audience instance per company — each with its own rules, marks,
 * links, run history and "who is internal" — over ONE store and ONE secret.
 * An instance carries its tenant in every row it writes and every read of
 * its own tables, so company A's rules never reach company B's numbers, and
 * a rule id of A's is "not found" through B's instance.
 *
 *   const audiences = createAudienceRegistry((tenantId) => createAudience({ store, secret, tenantId, … }));
 *   const greenAcres = audiences.for(companyId);       // the same instance every time
 *   createAnalytics({ db, audience: (tenantId) => audiences.for(tenantId) });
 *
 * Instances are built on first use and kept (most recently used first, up to
 * `max`), because each caches its rules and its user lookups for a minute: a
 * fresh instance per request would read the rules table on every beacon.
 */

export interface AudienceRegistry<A> {
  /** This tenant's audience: built on first use, then the same instance. */
  for(tenantId: string): A;
  /** Forget one tenant's instance (or all): the next `for` builds a fresh one with empty caches. */
  invalidate(tenantId?: string): void;
  /** How many instances are kept right now. */
  readonly size: number;
}

export interface AudienceRegistryOptions {
  /** Instances kept at once. Default 500; the least recently used goes first. */
  max?: number;
}

const TENANT_SHAPE = /^[^\u0000-\u001f]{1,200}$/;

export function createAudienceRegistry<A>(build: (tenantId: string) => A, options: AudienceRegistryOptions = {}): AudienceRegistry<A> {
  const max = options.max ?? 500;
  if (!Number.isInteger(max) || max < 1) throw new TypeError("createAudienceRegistry: max must be a positive whole number.");
  const kept = new Map<string, A>();
  return {
    for(tenantId: string): A {
      if (typeof tenantId !== "string" || !TENANT_SHAPE.test(tenantId)) {
        throw new TypeError("An audience needs the tenant it belongs to (a company id).");
      }
      const found = kept.get(tenantId);
      if (found !== undefined) {
        // Most recently used last, so the first key is the one to evict.
        kept.delete(tenantId);
        kept.set(tenantId, found);
        return found;
      }
      const made = build(tenantId);
      kept.set(tenantId, made);
      if (kept.size > max) kept.delete(kept.keys().next().value as string);
      return made;
    },
    invalidate(tenantId?: string): void {
      if (tenantId === undefined) kept.clear();
      else kept.delete(tenantId);
    },
    get size() {
      return kept.size;
    },
  };
}
