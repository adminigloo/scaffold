import type { MembershipVerdict } from "@adminigloo/permissions/server";
import { ctxOf } from "./internals.js";
import type { PublicCompanyLookup, TenancyService } from "./types.js";

/**
 * The seams a feature package's handlers take (Tenancy 2a, 4.6 and 4.7), so
 * scheduling, the estimator, invoicing and comms serve MANY companies from one
 * deployment without any of them importing tenancy:
 *
 *   private (staff pages):  /api/app/{tenantId}/…  → resolveTenant + authorize
 *   public (customers):     /api/t/{slug}/…        → resolveTenant + admit
 *
 * The feature packages already accept `resolveTenant` / `authorize` /
 * `admit` options; these build them from the tenancy service once.
 */

// ── private ─────────────────────────────────────────────────────────────────

export interface CompanyRouteSeams {
  /** The company id in the path after `prefix`, if it has the shape of an id (1–128 of [A-Za-z0-9_-]); never looked up here. */
  readonly resolveTenant: (req: Request) => string | null;
  /**
   * Signed in → a live member of this company → not suspended → holds the
   * permission. Memoised per Request (a route that asks twice pays once).
   */
  readonly authorize: (req: Request, permission: string, tenantId: string) => Promise<{ readonly userId: string } | false | Response>;
}

const TENANT_ID = /^[A-Za-z0-9_-]{1,128}$/;
const SIGNED_OUT = "You've been signed out. Sign in again to keep working.";

/** `{ error: { code, message } }` (3.5): `forbidden` because every feature widget already knows it. */
function refusal(status: 401 | 403, message: string): Response {
  return new Response(JSON.stringify({ error: { code: "forbidden", message } }), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

/** The segment right after `prefix` in the request's path, decoded; null when there isn't one. */
function segmentAfter(req: Request, prefix: string): string | null {
  let pathname: string;
  try {
    pathname = new URL(req.url).pathname;
  } catch {
    return null;
  }
  const at = pathname.indexOf(prefix);
  if (at === -1) return null;
  const raw = pathname.slice(at + prefix.length).split("/")[0] ?? "";
  if (raw === "") return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    return null; // a malformed %-escape is nobody's address
  }
}

/** What one request learned about one company: who, and a way to ask "may they?". Or a refusal to build. */
type Standing =
  | { readonly userId: string; readonly can: (permission: string) => boolean | Promise<boolean> }
  | { readonly refuse: 401 | 403; readonly message: string };

export function createCompanyRouteSeams(options: {
  readonly tenancy: TenancyService;
  readonly principal: (req: Request) => Promise<{ readonly userId: string } | null>;
  /** Where the id sits: the segment right after this. Default "/api/app/". */
  readonly prefix?: string;
}): CompanyRouteSeams {
  if (!options?.tenancy) throw new TypeError("createCompanyRouteSeams needs the tenancy service (`tenancy`).");
  if (typeof options.principal !== "function") {
    throw new TypeError("createCompanyRouteSeams needs `principal(req)`: who is signed in on this request.");
  }
  const { tenancy, principal } = options;
  const prefix = options.prefix ?? "/api/app/";
  const noun = tenancy.noun.singular;
  const notPartOf = `You're not part of this ${noun}.`;
  const suspended = `This ${noun} is suspended. Contact support to restore it.`;

  // Keyed on the Request object: two calls in one request (scheduling's
  // may(), the estimator's "can they see costs?") cost one resolution, and
  // nothing outlives the request. A STANDING is memoised, never a Response: a
  // Response body can be read once, and the second caller would get an
  // already-used stream.
  const memo = new WeakMap<Request, Map<string, Promise<Standing>>>();

  async function resolve(req: Request, tenantId: string): Promise<Standing> {
    const who = await principal(req);
    if (!who || typeof who.userId !== "string" || who.userId === "") return { refuse: 401, message: SIGNED_OUT };
    const userId = who.userId;
    // A made-up id answers exactly like a company you're not in: an id can't be probed.
    if (!TENANT_ID.test(tenantId)) return { refuse: 403, message: notPartOf };

    const ctx = ctxOf(tenancy);
    let verdict: MembershipVerdict;
    let can: (permission: string) => boolean | Promise<boolean>;
    if (ctx) {
      // The service's own loaders and membership gate: one pass, the same
      // answer the tRPC rung and the page gates give.
      const loaders = ctx.loaders(ctx.db);
      const set = await loaders.loadTenantPermissions({ principal: { userId }, tenantId });
      if (set) {
        verdict = "member";
        can = (permission) => set.can(permission as never);
      } else {
        verdict = await loaders.explainTenantDenial({ principal: { userId }, tenantId });
        can = () => false;
      }
    } else {
      verdict = await tenancy.membership({ userId, tenantId });
      can = (permission) => tenancy.hasPermission({ userId, tenantId, permission });
    }
    if (verdict === "company-suspended") return { refuse: 403, message: suspended };
    if (verdict !== "member") return { refuse: 403, message: notPartOf };
    return { userId, can };
  }

  return {
    resolveTenant(req) {
      const id = segmentAfter(req, prefix);
      return id !== null && TENANT_ID.test(id) ? id : null;
    },
    async authorize(req, permission, tenantId) {
      let perRequest = memo.get(req);
      if (!perRequest) {
        perRequest = new Map();
        memo.set(req, perRequest);
      }
      let standing = perRequest.get(tenantId);
      if (!standing) {
        standing = resolve(req, tenantId);
        perRequest.set(tenantId, standing);
      }
      const s = await standing;
      if ("refuse" in s) return refusal(s.refuse, s.message);
      return (await s.can(permission)) ? { userId: s.userId } : false;
    },
  };
}

// ── public ──────────────────────────────────────────────────────────────────

export interface PublicCompanySeams {
  /** The company a `{prefix}{slug}/…` request names (a current or retired address, active or suspended); unknown → null. */
  readonly resolveTenant: (req: Request) => Promise<string | null>;
  /** Open for an active company; closed, with a plain sentence, for a suspended or unknown one. */
  readonly admit: (tenantId: string, req: Request) => Promise<{ readonly open: true } | { readonly open: false; readonly message: string }>;
}

/** The shape of a web address (current or retired); anything else is never looked up. */
const SLUG_SHAPE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const UNKNOWN_CLOSED = "This business isn't taking requests online right now.";

/** "{Name} isn't taking requests online right now." plus how to reach them, when they've said. */
function closedMessage(company: { readonly name: string; readonly contactPhone: string | null; readonly contactEmail: string | null }): string {
  const head = `${company.name} isn't taking requests online right now.`;
  const phone = company.contactPhone;
  const email = company.contactEmail;
  if (phone && email) return `${head} Call ${phone} or email ${email}.`;
  if (phone) return `${head} Call ${phone}.`;
  if (email) return `${head} Email ${email}.`;
  return head;
}

export function createPublicCompanySeams(options: {
  readonly tenancy: TenancyService;
  /** Default "/api/t/". */
  readonly prefix?: string;
}): PublicCompanySeams {
  if (!options?.tenancy) throw new TypeError("createPublicCompanySeams needs the tenancy service (`tenancy`).");
  const { tenancy } = options;
  const prefix = options.prefix ?? "/api/t/";
  // The lookup a request's resolveTenant made, so admit doesn't repeat it: a
  // slug-addressed request costs ONE tenancy query. Promise-valued so two
  // concurrent asks on one request share it too.
  const cache = new WeakMap<Request, Promise<PublicCompanyLookup | null>>();

  function lookup(req: Request): Promise<PublicCompanyLookup | null> {
    let found = cache.get(req);
    if (!found) {
      const segment = segmentAfter(req, prefix);
      const slug = segment === null ? null : segment.trim().toLowerCase();
      found = slug !== null && slug.length <= 64 && SLUG_SHAPE.test(slug) ? tenancy.resolvePublicCompany(slug) : Promise.resolve(null);
      cache.set(req, found);
    }
    return found;
  }

  return {
    async resolveTenant(req) {
      return (await lookup(req))?.company.id ?? null;
    },
    async admit(tenantId, req) {
      const cached = cache.has(req) ? await cache.get(req)! : null;
      if (cached && cached.company.id === tenantId) {
        return cached.status === "active" ? { open: true } : { open: false, message: closedMessage(cached.company) };
      }
      // A tenant reached another way (an embed key): its own lookup. An
      // unknown or deleted id is closed, never open by default.
      const profile = await tenancy.companyProfile(tenantId);
      if (!profile) return { open: false, message: UNKNOWN_CLOSED };
      return profile.status === "active" ? { open: true } : { open: false, message: closedMessage(profile) };
    },
  };
}
