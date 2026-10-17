import type { createAudienceCore } from "./core/audience.js";
import { isAudienceError, type AudienceErrorCode } from "./core/errors.js";
import { RULE_KINDS, type RuleKind } from "./core/labels.js";
import type { AudienceRule, AudienceRun } from "./core/types.js";
import {
  AudienceHttpError,
  CROSS_SITE_MESSAGE,
  errorResponse,
  FORBIDDEN_MESSAGE,
  INTERNAL_MESSAGE,
  isCrossSiteRequest,
  isIdShaped,
  json,
  NOT_HERE,
  readJsonBody,
  segmentsAfter,
  type AudienceErrorCodeWire,
} from "./http.js";
import { ruleDraftSchema } from "./draft.js";
import type { AudiencePermission } from "./permissions.js";
import { AUDIENCE_ROUTE_PERMISSIONS, type AudienceRouteKind } from "./routes.js";

/**
 * WHO IS LEFT OUT, PER COMPANY (0.2): one fetch handler for a company's
 * rules — list, preview, add (which cleans the history at once) and remove
 * (which restores it exactly) — every route under `{mount}/v1/`
 * (AUDIENCE_ADMIN_ROUTES):
 *
 *   // app/api/app/[tenantId]/audience/[...path]/route.ts
 *   const { handle } = createAudienceAdminHandlers({ audienceFor: (id) => audiences.for(id), resolveTenant, authorize });
 *   export { handle as GET, handle as POST };
 *
 * The company is the id in the PATH (`resolveTenant`), asked of `authorize`
 * on every call. Its audience instance writes and reads only that company's
 * rows, so another company's rule id is "not found".
 *
 * Seams, so it installs in an app built differently: `resolveTenant`,
 * `authorize` (a Response is returned as it is, `false` is 403, `{ userId }`
 * names who changed what in the run history), `audienceFor`.
 */

/** What the handlers ask of one company's audience — exactly what `createAudience(...)` returns. */
export type CompanyAudience = Pick<ReturnType<typeof createAudienceCore>, "viewModel" | "preview" | "addRule" | "remove" | "visitorIds">;

export type AudienceAuthorizeResult = boolean | { userId?: string | number | null } | Response;

export interface CreateAudienceAdminHandlersOptions {
  /** This company's audience: `(tenantId) => audiences.for(tenantId)` (createAudiences). */
  audienceFor: (tenantId: string) => CompanyAudience;
  /** One fixed tenant (a single site). Pass this or `resolveTenant`. */
  tenantId?: string;
  /** The company a request is for — the id in the PATH. null → "not found". */
  resolveTenant?: (req: Request) => string | null | Promise<string | null>;
  authorize: (req: Request, permission: AudiencePermission, tenantId: string) => AudienceAuthorizeResult | Promise<AudienceAuthorizeResult>;
  /** The rule kinds the add form offers. Default: the ones that make sense for a business's own website (see below). */
  kinds?: readonly RuleKind[];
  /** The sentences under "Always left out". Default: the package's defaults, in words. */
  defaultsSummary?: readonly string[];
  /** The rule in code, in words ("Everyone on your team"), shown read-only. Default: the audience's own `codeRule`. */
  codeRule?: string | null;
  onError?: (error: unknown, context: { tenantId: string | null; route: string }) => void;
}

export interface AudienceAdminHandlers {
  handle: (req: Request) => Promise<Response>;
}

/**
 * The kinds a company's owner can use, each one a thing they know: a team
 * member's email, everyone at an email domain, an office or home internet
 * connection, a monitoring tool. Left out, each for a reason: `user` and
 * `org` (ids only a developer has), `email_pattern` (test sign-ups are left
 * out by default), `visitor` (a device mark — a cookieless visitor key
 * changes daily; "leave this device out" does that job), `host` (the site
 * register already says which addresses count), `event` and `order` (they
 * name things that don't change website visits). A rule of another kind,
 * added before, still shows and can be removed.
 */
export const COMPANY_RULE_KINDS: readonly RuleKind[] = ["email", "email_domain", "network", "user_agent"];

/** Rules that name ONE person: a preview of one never says whether that person has an account. */
const ONE_PERSON_KINDS: ReadonlySet<RuleKind> = new Set<RuleKind>(["email", "user"]);

/** What the package leaves out with no rule at all, in a business owner's words. */
export const COMPANY_DEFAULTS_SUMMARY: readonly string[] = [
  "Test sign-ups: addresses containing +test@ or +clerk_test@, and made-up domains like example.com.",
  "Automation: test browsers, page-speed checkers and uptime monitors.",
  "Search engines and AI crawlers never count as visits: they're counted apart, as crawlers.",
];

/** What `GET v1/rules` answers. Dates are ISO strings. */
export interface AudienceSettingsWire {
  readonly rules: ReadonlyArray<Omit<AudienceRule, "createdAt" | "disabledAt" | "appliesFrom"> & { createdAt: string; appliesFrom: string | null }>;
  readonly runs: ReadonlyArray<Omit<AudienceRun, "runAt" | "rangeFrom" | "rangeTo"> & { runAt: string; rangeFrom: string | null; rangeTo: string | null }>;
  readonly codeRule: string | null;
  readonly kinds: readonly RuleKind[];
  readonly defaultsSummary: readonly string[];
  /** "rotating": a cookieless visitor key — a rule reaches only the days a person was signed in. */
  readonly visitorIds: "stable" | "rotating";
}

interface Matched {
  kind: AudienceRouteKind;
  id?: string;
}

function route(pathname: string, method: string): Matched | null {
  const parts = segmentsAfter(pathname, "/v1/");
  if (!parts) return null;
  const get = method === "GET" || method === "HEAD";
  const post = method === "POST";
  const [a, b, c] = parts;
  const n = parts.length;
  if (a !== "rules") return null;
  if (n === 1 && get) return { kind: "rules" };
  if (n === 1 && post) return { kind: "rule-add" };
  if (n === 2 && b === "preview" && post) return { kind: "rule-preview" };
  if (n === 3 && c === "remove" && post) return { kind: "rule-remove", id: b as string };
  return null;
}

const WIRE_CODE: Readonly<Record<AudienceErrorCode, AudienceErrorCodeWire>> = {
  invalid_rule: "invalid",
  duplicate_rule: "duplicate",
  not_found: "not_found",
  not_configured: "not_configured",
  invalid_token: "invalid",
  unlicensed: "unlicensed",
};

const iso = (value: Date | null | undefined): string | null => (value ? new Date(value).toISOString() : null);

export function createAudienceAdminHandlers(options: CreateAudienceAdminHandlersOptions): AudienceAdminHandlers {
  if (!options.tenantId && !options.resolveTenant) {
    throw new TypeError("createAudienceAdminHandlers needs `tenantId` (one site) or `resolveTenant` (one per company).");
  }
  if (typeof options.authorize !== "function") throw new TypeError("createAudienceAdminHandlers needs `authorize`.");
  if (typeof options.audienceFor !== "function") throw new TypeError("createAudienceAdminHandlers needs `audienceFor`.");
  const kinds = (options.kinds ?? COMPANY_RULE_KINDS).filter((kind) => RULE_KINDS.includes(kind));
  const defaultsSummary = options.defaultsSummary ?? COMPANY_DEFAULTS_SUMMARY;

  /** A draft from the form, its kind one this site offers. */
  function draftOf(body: unknown) {
    const parsed = ruleDraftSchema.safeParse(body);
    if (!parsed.success) throw new AudienceHttpError("invalid", 400, parsed.error.issues[0]?.message ?? "Check the rule's fields.");
    if (!kinds.includes(parsed.data.kind)) throw new AudienceHttpError("invalid", 400, "That kind of rule isn't offered here.");
    return parsed.data;
  }

  async function dispatch(req: Request, match: Matched, tenantId: string, by: string | null): Promise<Response> {
    const audience = options.audienceFor(tenantId);
    switch (match.kind) {
      case "rules": {
        const view = await audience.viewModel({ canSeeEmails: true, runsLimit: 20 });
        const wire: AudienceSettingsWire = {
          rules: view.rules.map(({ disabledAt: _disabled, ...rule }) => ({ ...rule, createdAt: iso(rule.createdAt) ?? "", appliesFrom: iso(rule.appliesFrom) })),
          runs: view.runs.map((run) => ({ ...run, runAt: iso(run.runAt) ?? "", rangeFrom: iso(run.rangeFrom), rangeTo: iso(run.rangeTo) })),
          codeRule: options.codeRule !== undefined ? options.codeRule : view.codeRule,
          kinds,
          defaultsSummary,
          visitorIds: audience.visitorIds,
        };
        return json(wire);
      }
      case "rule-preview": {
        const draft = draftOf(await readJsonBody(req));
        const preview = await audience.preview(draft);
        // A preview naming one person says how many VISITS it would leave
        // out, never whether an account with that address exists: an owner
        // typing addresses must not learn who has signed up anywhere.
        // (`listUsers` must also only return the company's own people; see
        // the README.)
        if (!ONE_PERSON_KINDS.has(draft.kind)) return json(preview);
        return json({ ...preview, subjects: { ...preview.subjects, users: 0 }, alreadyExcluded: { ...preview.alreadyExcluded, users: 0 } });
      }
      case "rule-add": {
        const { applied } = await audience.addRule(draftOf(await readJsonBody(req)), { by });
        return json({ annotation: applied?.annotation ?? null }, 201);
      }
      case "rule-remove": {
        if (!isIdShaped(match.id)) return errorResponse("not_found", 404, NOT_HERE);
        const { annotation } = await audience.remove(match.id, { by });
        return json({ annotation: annotation ?? null });
      }
    }
  }

  return {
    async handle(req: Request): Promise<Response> {
      let tenantId: string | null = null;
      let kind = "unknown";
      try {
        const match = route(new URL(req.url).pathname, req.method);
        if (!match) return errorResponse("not_found", 404, NOT_HERE);
        kind = match.kind;
        if (req.method === "POST" && isCrossSiteRequest(req)) return errorResponse("cross_site", 403, CROSS_SITE_MESSAGE);
        tenantId = options.tenantId ?? (await options.resolveTenant?.(req)) ?? null;
        if (!tenantId) return errorResponse("not_found", 404, NOT_HERE);
        const verdict = await options.authorize(req, AUDIENCE_ROUTE_PERMISSIONS[match.kind], tenantId);
        if (verdict instanceof Response) return verdict;
        if (verdict === false) return errorResponse("forbidden", 403, FORBIDDEN_MESSAGE);
        const by = typeof verdict === "object" && verdict.userId != null && verdict.userId !== "" ? String(verdict.userId) : null;
        return await dispatch(req, match, tenantId, by);
      } catch (error) {
        if (error instanceof AudienceHttpError) return errorResponse(error.code, error.status, error.message);
        if (isAudienceError(error)) {
          // A rule of another company's is "not found", like one that never existed.
          return errorResponse(WIRE_CODE[error.code], error.status, error.code === "not_found" ? NOT_HERE : error.message);
        }
        options.onError?.(error, { tenantId, route: kind });
        return errorResponse("internal", 500, INTERNAL_MESSAGE);
      }
    },
  };
}
