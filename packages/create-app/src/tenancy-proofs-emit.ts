/**
 * The emitted proofs (contract 12.8): every generated project proves, in its
 * own unit suite and on its own schema, that procedures sit on the right rung,
 * that one company can't reach another's rows, and that setting a person up
 * works whichever of the webhook and the first page arrives first.
 *
 * PGlite — a real Postgres in-process — so these run in `pnpm test` on every
 * laptop and in CI, with no database to set up.
 */

import { consumerProduct, tenantLabelPlural, type Answers } from "./answers.js";
import { companiesMode } from "./tenancy-emit.js";

export type RouterScope = "public" | "authenticated" | "tenant" | "staff";

/** One router (or one dotted path inside a router) and the rung it must sit on. */
export interface RouterScopeRow {
  /** A router name ("billing") or a full path ("billing.subscribeToPlan"); the path wins. */
  readonly key: string;
  readonly scope: RouterScope;
  /** The answer that mounts it. */
  readonly installedBy: (answers: Answers) => boolean;
  /** The overlay router file, relative to `overlays/`, for the generator test that greps it. */
  readonly source: string | null;
}

const always = (): boolean => true;
const sells = (answers: Answers): boolean => answers.businessModel !== "none";
/** This site's own shop (create-app 0.39): --model one-time or both. */
const shop = (answers: Answers): boolean => answers.businessModel === "one-time" || answers.businessModel === "both";

/**
 * Every router a generated project can mount, the rung it must be built
 * from, and the answer that mounts it (PC-19). The emitted procedure-scopes
 * test checks the BUILT procedures against this, so a procedure that lost its
 * `requireStaff` fails the project's own `pnpm test`.
 *
 * A generator test fails when an overlay router exists with no row here, and a
 * second greps each router for its rungs and checks the rows against them — so
 * this table can't silently fall behind the overlays.
 *
 * NO FIELD-SERVICE ROUTERS (Tenancy 2a, D3): invoicing's and messages' tRPC
 * routers are retired, like scheduling's and the estimator's before them.
 * Those features are package HTTP handlers, and the project's feature
 * isolation proof (feature-isolation.test.ts) drives every one of their
 * routes instead.
 */
export const ROUTER_SCOPES: readonly RouterScopeRow[] = [
  { key: "health", scope: "public", installedBy: always, source: null },
  { key: "members", scope: "tenant", installedBy: always, source: null },
  { key: "admin", scope: "staff", installedBy: always, source: null },
  { key: "ai", scope: "tenant", installedBy: (a) => a.includeAi, source: "ai/src/server/routers/ai.ts" },
  // No notifications or files router (Tenancy 2b-1): alerts and files run on
  // their packages' own HTTP handlers, proved by the feature isolation suite.
  // Nor feedback (Tenancy 2b-2a): its board is the package's handlers too.
  // Nor seo or aeo (Tenancy 2b-4b): the search check and AI mentions are too.
  { key: "assistant", scope: "staff", installedBy: (a) => a.includeAssistant, source: "assistant/src/server/routers/assistant.ts" },
  { key: "catalog", scope: "staff", installedBy: shop, source: "shop/src/server/routers/catalog.ts" },
  { key: "checkout", scope: "public", installedBy: shop, source: "shop/src/server/routers/checkout.ts" },
  { key: "checkout.createIntent", scope: "authenticated", installedBy: shop, source: "shop/src/server/routers/checkout.ts" },
  { key: "account", scope: "tenant", installedBy: sells, source: "account/src/server/routers/account.ts" },
  { key: "billing", scope: "staff", installedBy: sells, source: "stripe/src/server/routers/billing.ts" },
  { key: "billing.subscribeToPlan", scope: "tenant", installedBy: sells, source: "stripe/src/server/routers/billing.ts" },
  { key: "billing.simulateSubscription", scope: "tenant", installedBy: sells, source: "stripe/src/server/routers/billing.ts" },
  // Changing plan on the company's one subscription (billing 0.3).
  { key: "billing.previewPlanChange", scope: "tenant", installedBy: sells, source: "stripe/src/server/routers/billing.ts" },
  { key: "billing.changePlan", scope: "tenant", installedBy: sells, source: "stripe/src/server/routers/billing.ts" },
  // Adding a product line to the one subscription (billing 0.5).
  { key: "billing.previewAddLine", scope: "tenant", installedBy: sells, source: "stripe/src/server/routers/billing.ts" },
  { key: "billing.addLine", scope: "tenant", installedBy: sells, source: "stripe/src/server/routers/billing.ts" },
];

/**
 * Every TENANT procedure a generated project can have, by the answer that
 * installs it. The emitted isolation test proves each one refuses another
 * company's id; a tenant procedure missing from here fails that test by name,
 * and a generator test greps the overlay routers for `requireTenant(` so the
 * list keeps up.
 *
 * Every one shipped today is "tenant-only": the only COMPANY-owned id it takes
 * is the company's. `globals` fills its other required fields, which belong
 * to no company (a plan tier, a currency), so the proof checks its input
 * with B's own id — and a procedure that needs more than that, or that MAY be
 * given another id (an optional or a nested one), can't pass as tenant-only
 * (review R2 TB2-01, R3). A procedure taking the id of a company's row (an
 * order, a visit, a member) is a "by-id" case, written in the project.
 *
 * NOTHING ELSE UNLESS IT'S SAID WHY (review R4 TB2-01). A tenant-only
 * procedure may declare no input besides `tenantId` and its globals — an
 * optional `email` or `who` is refused like an optional `userId` — unless
 * `allow` names it with the reason it can't reach another company's rows.
 * Each one here is a number, a flag or a fixed choice the procedure reads for
 * B's own company.
 */
export const TENANT_PROCEDURES: readonly {
  readonly path: string;
  readonly installedBy: (answers: Answers) => boolean;
  readonly globals?: Readonly<Record<string, unknown>>;
  /** Input field path → why it can't reach another company's rows. */
  readonly allow?: Readonly<Record<string, string>>;
}[] = [
  { path: "members.list", installedBy: always },
  {
    path: "ai.spend",
    installedBy: (a) => a.includeAi,
    // A count of days, 1–366: how far back to sum B's own spend (ctx.tenantId).
    allow: { days: "a number of days to look back over the caller's own company's spend; it names no row" },
  },
  { path: "account.billingPortal", installedBy: sells },
  // Billing 0.5: which of B's OWN product lines (a key from src/plans.ts).
  {
    path: "account.cancelSubscription",
    installedBy: sells,
    allow: { line: "a product line's key from src/plans.ts, on the caller's own company's subscription; it names no row" },
  },
  {
    path: "account.resumeSubscription",
    installedBy: sells,
    allow: { line: "a product line's key from src/plans.ts, on the caller's own company's subscription; it names no row" },
  },
  {
    path: "account.invoices",
    installedBy: sells,
    // A page size, 1–24, over B's own invoices (ctx.tenantId).
    allow: { limit: "a page size (1-24) over the caller's own company's invoices; it names no row" },
  },
  { path: "billing.subscribeToPlan", installedBy: sells, globals: { tierKey: "starter", interval: "month", currency: "usd" } },
  // Billing 0.3: both act on B's OWN subscription (looked up by ctx.tenantId), never on an id in the input.
  { path: "billing.previewPlanChange", installedBy: sells, globals: { tierKey: "starter", interval: "month", currency: "usd" } },
  {
    path: "billing.changePlan",
    installedBy: sells,
    globals: { tierKey: "starter", interval: "month", currency: "usd", prorationDate: 1800000000 },
    allow: { prorationDate: "the Unix time the caller's own preview gave, so the charge matches it; it names no row" },
  },
  // Billing 0.5: a line added to B's OWN subscription (looked up by ctx.tenantId).
  { path: "billing.previewAddLine", installedBy: sells, globals: { tierKey: "starter", interval: "month", currency: "usd" } },
  {
    path: "billing.addLine",
    installedBy: sells,
    globals: { tierKey: "starter", interval: "month", currency: "usd", prorationDate: 1800000000 },
    allow: { prorationDate: "the Unix time the caller's own preview gave, so the charge matches it; it names no row" },
  },
  {
    path: "billing.simulateSubscription",
    installedBy: sells,
    globals: { tierKey: "starter", interval: "month", currency: "usd" },
    // Which state to simulate B's OWN subscription in: a fixed list and a flag.
    allow: {
      status: "one of six fixed subscription states to simulate for the caller's own company; it names no row",
      cancelAtPeriodEnd: "a true/false flag on the caller's own company's simulated subscription; it names no row",
    },
  },
];

/**
 * A consumers project (billing 0.5) lets nobody invite anyone (one person per
 * account: the plan gate's seat limit of one, proved in
 * personal-plans.test.ts). These proofs build a team to prove the invitation
 * machinery and the isolation around it, so they lift that limit — for the
 * machinery, not for the product.
 */
function consumerSeatLift(answers: Answers): string {
  if (!consumerProduct(answers)) return "";
  return `
// One person per account in this project (billing 0.5, create-app 0.39):
// lifted here only so the team these cases need can be built — the seat
// limit of one, and the team keys no role holds (the owner's are given back
// for this file). personal-plans.test.ts proves both locks themselves.
vi.mock("@/server/plan-gate", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/plan-gate")>()),
  seatLimitOption: {},
}));
vi.mock("@/permissions/catalog", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/permissions/catalog")>();
  const { definePermissions } = await import("${answers.scope}/permissions");
  const { tenancyPermissions } = await import("${answers.scope}/tenancy");
  return {
    ...original,
    tenantCatalog: definePermissions("tenant", { ...original.tenantCatalog.permissions, ...tenancyPermissions }),
    HELD_BY_NOBODY: [],
  };
});
`;
}

export function renderProcedureScopesTest(answers: Answers): string {
  const rows = ROUTER_SCOPES.filter((row) => row.installedBy(answers));
  const body = rows.map((row) => `  ${JSON.stringify(row.key)}: ${JSON.stringify(row.scope)},`).join("\n");
  return `import { describe, expect, it } from "vitest";
import { auditBuiltProcedures, inventoryOf, type ProcedureScope } from "${answers.scope}/trpc";
import { appRouter } from "@/server/routers/_app";

/**
 * Every procedure in the app sits on the rung it was meant to (PC-19).
 *
 * The rung a procedure was BUILT from — publicProcedure, protectedProcedure,
 * requireTenant, requireStaff — is read off the procedure itself, not off its
 * \`.meta({ scope })\` label, so a procedure that lost its \`requireStaff\` fails
 * here even if its label still says "staff". A router this list doesn't know
 * fails too: a new router can't ship unaudited.
 *
 * GENERATED from the routers this project installed. When you add a router,
 * add its row; when one procedure in a router is meant to be more open than
 * the rest (an invoice a customer opens from an email link), add its full
 * path, and the path wins over the router.
 */
const EXPECTED_SCOPES: Readonly<Record<string, ProcedureScope>> = {
${body}
};

describe("procedure scopes", () => {
  it("every procedure is built from the rung its router requires", () => {
    const result = auditBuiltProcedures(inventoryOf(appRouter), EXPECTED_SCOPES);
    expect(result.violations.map((v) => \`\${v.path}: \${v.reason}\`)).toEqual([]);
    expect(result.ok).toBe(true);
  });
});
`;
}

export function renderTenantIsolationTest(answers: Answers): string {
  const scope = answers.scope;
  const companies = companiesMode(answers);
  const cases = TENANT_PROCEDURES.filter((p) => p.installedBy(answers))
    .map((p) => {
      const parts = [`kind: "tenant-only"`];
      if (p.globals) {
        parts.push(
          `globals: { ${Object.entries(p.globals)
            .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
            .join(", ")} }`,
        );
      }
      if (!p.allow) return `  ${JSON.stringify(p.path)}: { ${parts.join(", ")} },`;
      const allow = Object.entries(p.allow)
        .map(([key, why]) => `      ${/^[A-Za-z_$][\w$]*$/.test(key) ? key : JSON.stringify(key)}: ${JSON.stringify(why)},`)
        .join("\n");
      return `  ${JSON.stringify(p.path)}: {\n    ${parts.join(",\n    ")},\n    allow: {\n${allow}\n    },\n  },`;
    })
    .join("\n");
  const companyOf = companies
    ? `/** Companies mode: each owner names their company in onboarding. */
async function companyOf(owner: Person, name: string): Promise<string> {
  const out = await tenancy.createCompany({
    userId: owner.id,
    name,
    requestKey: \`iso-\${owner.id}\`.slice(0, 64),
    purpose: "onboarding",
  });
  return out.company.id;
}`
    : `/** Single-business mode: each person's workspace was made when they were set up. */
async function companyOf(owner: Person, _name: string): Promise<string> {
  return personalWorkspaceId(owner.id);
}`;
  const companyImport = companies ? "" : `import { personalWorkspaceId } from "${scope}/tenancy";\n`;
  return `import { beforeAll, describe, expect, it, vi } from "vitest";
import { sql, type SQL } from "drizzle-orm";
import type { Principal } from "${scope}/auth";
import { users } from "${scope}/auth/schema";
${companyImport}import { TENANCY_ROUTES, type TenancyRoute, type TenancyRouteKind } from "${scope}/tenancy/server";
import { createScaffoldContext, inputFieldsOf, inventoryOf, looksLikeAnId, scopeOfProcedure } from "${scope}/trpc";
import { db } from "@/db";
import { seedPermissions } from "@/permissions/seed";
import { appRouter } from "@/server/routers/_app";
import { tenancy } from "@/server/tenancy";
import { buildTenancyHandlers } from "@/server/tenancy-handlers";
import { createCallerFactory } from "@/server/trpc";

/**
 * ONE COMPANY CAN'T READ OR CHANGE ANOTHER'S ROWS (SR-22) — proved on this
 * project's own schema, in-process, on every \`pnpm test\`.
 *
 * Two ${tenantLabelPlural(answers).toLowerCase()}, A and B, each with an owner; A also has a second member (A2)
 * and an open invitation. Then, signed in as B's owner:
 *
 *   - B even holds a stray owner role in A (no membership), so each refusal
 *     is the membership gate's, not a missing grant's;
 *   - every TENANT procedure in the app, called with A's id, is refused
 *     (FORBIDDEN) — and every one must have an isolation case below, so a new
 *     tenant procedure nobody proved fails this file by name. Then, with B's
 *     own id: a "tenant-only" one must take nothing else at all unless its
 *     case says why (its input parsers are checked, mutations included,
 *     OPTIONAL, nested and array inputs too, so one that reads by a member's
 *     id, an address or a name can't hide there) and a query's answer must
 *     say nothing of A, even handed A's ids, addresses, names and web
 *     address; a "by-id" one is called with A's row ids under B's company —
 *     queries and mutations — and must answer not-found or nothing of A's;
 *   - every company ROUTE (/api/tenancy/v1/companies/{id}/…), called with A's
 *     id, is refused as "not a member"; called with B's own id but A's member
 *     or invitation id, it is "not found"; and nothing B gets back mentions A;
 *   - and afterwards, nothing of A's has changed.
 *
 * PGlite: a real Postgres in this process, built from src/db/schema.ts. No
 * database to set up, so it runs on every laptop and in CI.
 */
vi.mock("@/db", async () => {
  const { createAppPglite } = await import("@/test/pglite");
  return { db: (await createAppPglite()).db };
});
${consumerSeatLift(answers)}
interface Person {
  readonly id: string;
  readonly email: string;
  readonly name: string;
}

const fx = {} as {
  A: Person;
  A2: Person;
  B: Person;
  aId: string;
  bId: string;
  aInvitationId: string;
  /**
   * Ids of company A's own rows, for "by-id" cases: create A's order, visit or
   * quote in the beforeAll below and keep its id here (and push anything that
   * identifies it onto \`aStrings\`).
   */
  aRows: Record<string, string>;
  /** Everything that identifies A: ids, addresses, names, web address. */
  aStrings: string[];
};

${companyOf}

async function person(externalId: string, email: string, name: string): Promise<Person> {
  const [row] = await db.insert(users).values({ externalId, email, displayName: name }).returning();
  if (!row) throw new Error("could not create the test person");
  await tenancy.provisionUser({ userId: row.id, email });
  return { id: row.id, email, name };
}

function principalOf(p: Person): Principal {
  return { userId: p.id, externalId: \`ext_\${p.id}\`, email: p.email };
}

function rowsOf(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  const rows = (result as { rows?: unknown }).rows;
  return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
}

async function all(query: SQL): Promise<Record<string, unknown>[]> {
  return rowsOf(await db.execute(query));
}

/** Everything of A's that B must not be able to change. */
async function snapshotOfA(): Promise<string> {
  const a = fx.aId;
  return JSON.stringify({
    company: await all(sql\`select * from tenants where id = \${a}\`),
    members: await all(sql\`select user_id, status from tenant_members where tenant_id = \${a} order by user_id\`),
    roles: await all(sql\`select principal_id, template_id from principal_role where scope = 'tenant' and tenant_id = \${a} order by principal_id\`),
    overrides: await all(sql\`select * from principal_override where scope = 'tenant' and tenant_id = \${a} order by principal_id, permission\`),
    invitations: await all(sql\`select id, email, template_id, token_hash, accepted_at, revoked_at from tenant_invitations where tenant_id = \${a} order by id\`),
  });
}

/**
 * Every TENANT procedure, and how its isolation is proved. GENERATED from the
 * procedures this project installed; add yours here.
 *
 *   { kind: "tenant-only", globals?: {…}, allow?: { field: "why" } }
 *     The ONLY company-owned id it takes is the company's (\`globals\` fills
 *     other fields that belong to no company: a plan tier, a currency).
 *     Proof: its input parsers accept B's id and the globals alone, and it
 *     declares NO other input — required, optional, nested or in an array,
 *     whatever it's called (\`userId\`, \`email\`, \`who\`,
 *     \`filter.memberIds[]\`), queries and mutations alike — unless \`allow\`
 *     names it with the reason it can't reach another company's rows (a page
 *     size, a number of days, a fixed choice; never a row's id). And a
 *     query's answer for B says nothing of A, even with each of A's ids,
 *     addresses, names and web address put in every text input it has.
 *
 *   { kind: "by-id", input: (f) => ({ tenantId: f.bId, …ids of A's rows }), expect: "not-found" | "empty" }
 *     It takes the id of a row a company owns. Proof: called as B, under B's
 *     company, with A's row ids (keep them on \`fx.aRows\`), it answers
 *     NOT_FOUND ("not-found") or returns nothing of A's ("empty").
 *
 * Nothing either returns may mention company A.
 */
type IsolationCase =
  | {
      readonly kind: "tenant-only";
      readonly globals?: Readonly<Record<string, unknown>>;
      /** Input field path (as \`inputFieldsOf\` prints it) → why it can't reach another company's rows. */
      readonly allow?: Readonly<Record<string, string>>;
    }
  | { readonly kind: "by-id"; readonly input: (f: typeof fx) => Record<string, unknown>; readonly expect: "not-found" | "empty" };

const ISOLATION_CASES: Readonly<Record<string, IsolationCase>> = {
${cases}
};

/**
 * Would this procedure accept \`input\`? Its own input parsers, run WITHOUT
 * running the procedure — so a mutation (a checkout, a cancellation) is
 * checked for its shape without doing anything.
 */
function acceptsInput(procedure: unknown, input: unknown): { readonly ok: boolean; readonly issue: string } {
  const parsers = (procedure as { _def?: { inputs?: unknown[] } })._def?.inputs ?? [];
  for (const parser of parsers) {
    const zod = parser as { safeParse?: (value: unknown) => { success: boolean; error?: { message?: string } } };
    if (typeof zod.safeParse !== "function") continue;
    const result = zod.safeParse(input);
    if (!result.success) return { ok: false, issue: result.error?.message ?? "invalid input" };
  }
  return { ok: true, issue: "" };
}

/**
 * \`input\` with one more field set: \`["filter", "memberIds", "[]"]\` sets
 * \`filter.memberIds\` to \`[value]\`. Objects on the way are kept or made.
 */
function withField(input: Record<string, unknown>, segments: readonly string[], value: unknown): Record<string, unknown> {
  const build = (at: unknown, rest: readonly string[]): unknown => {
    if (rest.length === 0) return value;
    const [head, ...tail] = rest;
    if (head === "[]") return [build(undefined, tail)];
    if (head === "*") return { probe: build(undefined, tail) };
    const base = typeof at === "object" && at !== null && !Array.isArray(at) ? (at as Record<string, unknown>) : {};
    return { ...base, [head!]: build(base[head!], tail) };
  };
  return build(input, segments) as Record<string, unknown>;
}

/** The smallest valid body for each company route, sent first with A's id and then with B's. */
const ISOLATION_BODIES: Readonly<Record<string, unknown>> = {
  "company-get": null,
  "profile-update": { name: "Bravo Roofing" },
  "branding-update": { brandColor: "#1d4ed8" },
  "logo-upload": "file",
  "logo-remove": {},
  "settings-get": null,
  "settings-update": { values: { timeZone: "America/Denver" } },
  "checklist-get": null,
  "checklist-dismiss": {},
  "checklist-restore": {},
  "checklist-hide": {},
  "checklist-show": {},
  "team-get": null,
  "member-role": { roleKey: "viewer" },
  "member-remove": {},
  leave: {},
  transfer: { toUserId: "(A2)", confirmName: "Bravo Roofing" },
  "invitations-list": null,
  "invitation-send": { email: "isolation.invitee@bravo-roofing.test", roleKey: "member" },
  "invitation-resend": {},
  "invitation-revoke": {},
} satisfies Partial<Record<TenancyRouteKind, unknown>>;

/** A 1x1 PNG, so the logo route gets a real image and refuses for the right reason. */
const PNG = Uint8Array.from(
  atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="),
  (c) => c.charCodeAt(0),
);

function requestFor(route: TenancyRoute<TenancyRouteKind>, tenantId: string): Request {
  const path = route.path
    .replace(":tenantId", tenantId)
    .replace(":userId", fx.A2.id)
    .replace(":invitationId", fx.aInvitationId)
    .replace(":section", "company")
    .replace(":itemKey", "team.invite");
  const url = \`http://localhost/api/tenancy/\${path}\`;
  const headers = { "sec-fetch-site": "same-origin" };
  if (route.method === "GET") return new Request(url, { headers });
  if (route.kind === "logo-upload") {
    const form = new FormData();
    form.append("file", new Blob([PNG], { type: "image/png" }), "logo.png");
    return new Request(url, { method: "POST", headers, body: form });
  }
  const raw = ISOLATION_BODIES[route.kind];
  // The hand-over names a member of A — the one id B must not be able to use.
  const body = route.kind === "transfer" ? { ...(raw as object), toUserId: fx.A2.id } : raw;
  return new Request(url, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
}

const companyRoutes = TENANCY_ROUTES.filter((route) => route.scope === "company");

beforeAll(async () => {
  await seedPermissions(db, { log: () => {} });
  fx.A = await person("ext_iso_a", "ada.alpha@alpha-lawn.test", "Ada Alpha");
  fx.A2 = await person("ext_iso_a2", "arlo.alpha@alpha-lawn.test", "Arlo Alpha");
  fx.B = await person("ext_iso_b", "ben.bravo@bravo-roofing.test", "Ben Bravo");
  fx.aId = await companyOf(fx.A, "Alpha Lawn Care");
  fx.bId = await companyOf(fx.B, "Bravo Roofing");
  fx.aRows = {};

  const joined = await tenancy.sendInvitation({
    actorUserId: fx.A.id,
    tenantId: fx.aId,
    email: fx.A2.email,
    roleKey: "member",
  });
  const accepted = await tenancy.acceptInvitation({ token: joined.token, userId: fx.A2.id });
  expect(accepted.status).toBe("accepted");
  const pending = await tenancy.sendInvitation({
    actorUserId: fx.A.id,
    tenantId: fx.aId,
    email: "pat.pending@alpha-lawn.test",
    roleKey: "viewer",
  });
  fx.aInvitationId = pending.invitation.id;

  // A STRAY ROLE ROW: B holds the owner role in A without being a member of
  // it — what a half-finished removal or a bad import leaves behind. The
  // membership gate is what refuses B anyway; without it, this row alone
  // would let B into A. So every refusal below is proved against the worst
  // case, not the tidy one.
  await db.execute(sql\`insert into principal_role (principal_id, scope, tenant_id, template_id)
    select \${fx.B.id}, 'tenant', \${fx.aId}, id from role_template
    where scope = 'tenant' and key = 'owner' and tenant_id = '*'\`);

  const a = await tenancy.companyFor(fx.aId);
  if (!a) throw new Error("company A is missing");
  fx.aStrings = [
    fx.A.id,
    fx.A2.id,
    fx.aId,
    fx.aInvitationId,
    fx.A.email,
    fx.A2.email,
    "pat.pending@alpha-lawn.test",
    fx.A.name,
    fx.A2.name,
    a.name,
    a.slug,
  ];
});

function mentionsA(text: string): string[] {
  return fx.aStrings.filter((s) => s.length > 0 && text.includes(s));
}

describe("company isolation: tRPC", () => {
  it("every tenant procedure refuses another company's id, and has an isolation case", async () => {
    const caller = createCallerFactory(appRouter)(createScaffoldContext({ principal: principalOf(fx.B) }));
    const tenantProcedures = inventoryOf(appRouter).filter((e) => scopeOfProcedure(e.procedure) === "tenant");
    expect(tenantProcedures.length).toBeGreaterThan(0);
    for (const entry of tenantProcedures) {
      const isolation = ISOLATION_CASES[entry.path];
      expect(
        isolation,
        \`Add an isolation case for \${entry.path}: { kind: "tenant-only" } if the only company-owned id it takes is the company's, \` +
          \`or { kind: "by-id", input: (f) => ({ tenantId: f.bId, …ids of A's rows }), expect: "not-found" } if it takes a company's row id. \` +
          \`A tenant procedure nobody proved can read another company's rows.\`,
      ).toBeDefined();
      if (!isolation) continue;

      // The rung runs before the procedure's own input parser, so the
      // company's id is the only input needed to be refused.
      const call = (input: unknown): Promise<unknown> => {
        let target: unknown = caller;
        for (const segment of entry.path.split(".")) target = (target as Record<string, unknown>)[segment];
        return (target as (input: unknown) => Promise<unknown>)(input);
      };
      await expect(call({ tenantId: fx.aId }), entry.path).rejects.toMatchObject({ code: "FORBIDDEN" });

      const type = (entry.procedure as { _def?: { type?: string } })._def?.type;
      const run = async (input: unknown): Promise<{ answer: unknown; failure: unknown }> => {
        try {
          return { answer: await call(input), failure: null };
        } catch (error) {
          return { answer: { error: error instanceof Error ? error.message : String(error) }, failure: error };
        }
      };

      if (isolation.kind === "tenant-only") {
        // It must take NOTHING a company owns besides the company's id: its
        // input parsers accept B's id and the globals alone (queries and
        // mutations alike). One that also needs a member's, an order's or a
        // visit's id can't pass as tenant-only — that would prove nothing
        // about the id it actually reads by (review R2 TB2-01).
        const globals = isolation.globals ?? {};
        const input = { ...globals, tenantId: fx.bId };
        const shape = acceptsInput(entry.procedure, input);
        expect(
          shape.ok,
          \`\${entry.path} is marked "tenant-only" but needs more than the company's id (\${shape.issue}). \` +
            \`If the extra input is the id of a row a company owns, make it a "by-id" case; if it belongs to no company, put it in its globals.\`,
        ).toBe(true);
        // …and the inputs it MAY be given, not only the ones it insists on
        // (review R3 TB2-01): an OPTIONAL \`userId\`, a \`filter.memberIds[]\`.
        // Parsing B's id alone never sends those, so a procedure that read
        // any company's member by an optional id used to pass here. Every
        // declared field is read off its parsers; the rung's own top-level
        // tenantId, the globals and what \`allow\` names (with its reason) are
        // the only ones it may take.
        const fields = inputFieldsOf(entry.procedure).filter((f) => f.path !== "tenantId");
        const allow = isolation.allow ?? {};
        const extra = fields.filter((f) => !(f.segments[0]! in globals));
        // A query is safe to run: whatever it returns for B's own company
        // (or the error it raises) says nothing of A's — asked plainly, and
        // again with EVERYTHING that identifies A — its ids, its people's
        // addresses and names, its name and web address (review R4 TB2-01) —
        // in every text input it may be given, whatever that input is called
        // and whether or not it's allowed. (The value echoed back is not a
        // leak; what it found with it is.)
        if (type === "query") {
          const { answer } = await run(input);
          expect(mentionsA(JSON.stringify(answer ?? null)), entry.path).toEqual([]);
          const probes = [...new Set([...fx.aStrings, ...Object.values(fx.aRows)])].filter((s) => s.length > 0);
          for (const field of extra.filter((f) => f.kind === "string")) {
            for (const value of probes) {
              const probe = withField(input, field.segments, value);
              if (!acceptsInput(entry.procedure, probe).ok) continue;
              const probed = await run(probe);
              expect(
                mentionsA(JSON.stringify(probed.answer ?? null)).filter((s) => s !== value),
                \`\${entry.path} given A's \${JSON.stringify(value)} in \${field.path} answered with A's rows\`,
              ).toEqual([]);
            }
          }
        }
        // Queries and mutations alike: NOTHING else, unless \`allow\` says why
        // (review R4 TB2-01). An optional \`email\` or \`who\` can find another
        // company's row as surely as a \`userId\`, and a mutation is never run
        // here to show it doesn't. A procedure that may be handed a row's id
        // is a "by-id" case, proved with A's ids — even when that id is optional.
        const unexplained = extra.filter((f) => !(f.path in allow)).map((f) => (f.optional ? \`\${f.path} (optional)\` : f.path));
        expect(
          unexplained,
          \`\${entry.path} is marked "tenant-only" but may also be given \${unexplained.join(", ")}. \` +
            \`If that is the id (or the address, name or anything else) of a row a company owns, make it a "by-id" case; \` +
            \`if it belongs to no company, put it in its globals, or list it in its allow with the reason it can't reach another company's rows.\`,
        ).toEqual([]);
        // An allow entry says why, names a field the procedure really has, and is never a row's id.
        for (const [path, why] of Object.entries(allow)) {
          expect(why.trim().length, \`\${entry.path} allows \${path} without saying why\`).toBeGreaterThanOrEqual(10);
          const field = fields.find((f) => f.path === path);
          expect(field, \`\${entry.path} allows \${path}, which it doesn't take: take it out of allow\`).toBeDefined();
          expect(
            looksLikeAnId(field?.key ?? path),
            \`\${entry.path} allows \${path}, but that names a row: a procedure that may be given a row's id is a "by-id" case\`,
          ).toBe(false);
        }
      } else {
        // By id, queries AND mutations: A's rows, asked for under B's company.
        const { answer, failure } = await run(isolation.input(fx));
        if (isolation.expect === "not-found") {
          expect((failure as { code?: unknown } | null)?.code, \`\${entry.path} with A's ids under B's company\`).toBe("NOT_FOUND");
        }
        expect(mentionsA(JSON.stringify(answer ?? null)), entry.path).toEqual([]);
      }
    }
  });
});

describe("company isolation: the company routes", () => {
  it("has a body for every company route", () => {
    for (const route of companyRoutes) {
      expect(route.kind in ISOLATION_BODIES, \`Add an ISOLATION_BODIES entry for the "\${route.kind}" route\`).toBe(true);
    }
  });

  it("refuses every company route for a company the caller isn't in, and leaks nothing", async () => {
    const before = await snapshotOfA();
    const { handle } = buildTenancyHandlers({
      principal: async () => ({ userId: fx.B.id, email: fx.B.email }),
      verifiedEmails: async () => [fx.B.email],
    });

    for (const route of companyRoutes) {
      const res = await handle(requestFor(route, fx.aId));
      const text = await res.text();
      expect(res.status, \`\${route.kind} with A's id: \${text}\`).toBe(403);
      expect(JSON.parse(text).error.code, route.kind).toBe("not_a_member");
      expect(mentionsA(text), route.kind).toEqual([]);
    }

    for (const route of companyRoutes) {
      const res = await handle(requestFor(route, fx.bId));
      const text = await res.text();
      if (route.path.includes(":userId") || route.path.includes(":invitationId")) {
        expect(res.status, \`\${route.kind} in B with A's ids: \${text}\`).toBe(404);
        expect(JSON.parse(text).error.code, route.kind).toBe("not_found");
      } else {
        expect(res.status, \`\${route.kind} in B: \${text}\`).toBeLessThan(500);
      }
      expect(mentionsA(text), route.kind).toEqual([]);
    }

    expect(await snapshotOfA()).toBe(before);
  });
});
`;
}

/**
 * The provisioning proof for this mode: both orders the webhook and the first
 * page can arrive in end in the same place, and a 0.21 account the race left
 * with nothing is set up on its next visit (PC-01).
 */
export function renderProvisioningTest(answers: Answers): string {
  const scope = answers.scope;
  const companies = companiesMode(answers);
  const expected = companies ? "needs-onboarding" : "ready";
  // Single-business mode only: two workspaces in one menu must be tellable
  // apart (TB-DEPLOY-10), so each is named after its owner.
  const namedWorkspace = companies
    ? ""
    : `

  it("names each person's workspace after them, so two in one menu can be told apart (TB-DEPLOY-10)", async () => {
    clerk.externalId = "user_named";
    clerk.email = "named@example.test";
    const principal = await currentPrincipal();
    const session = await tenancy.resolveSession({ userId: principal!.userId });
    expect(session.state).toBe("ready");
    expect(session.state === "ready" ? session.company.name : null).toBe("Sam Lee's workspace");
  });`;
  return `import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { users } from "${scope}/auth/schema";
import { db } from "@/db";
import { seedPermissions } from "@/permissions/seed";
import { currentPrincipal } from "@/server/auth";
import { tenancy } from "@/server/tenancy";

/**
 * Setting a person up works whichever arrives first — the Clerk webhook or
 * their first page request — and repairs the people the 0.21 race left with
 * nothing (PC-01). PGlite, so it runs on every \`pnpm test\`.
 *
 * In this project (${companies ? "companies" : "single-business"} mode) a person who has just signed up
 * is "${expected}": ${companies ? "they have no company until they name one in onboarding" : "their own workspace was made for them"}.
 */
vi.mock("@/db", async () => {
  const { createAppPglite } = await import("@/test/pglite");
  return { db: (await createAppPglite()).db };
});

/** Clerk keys present, so currentPrincipal() runs instead of answering null. */
vi.mock("@/env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/env")>();
  return {
    ...actual,
    env: new Proxy(actual.env, {
      get(target, prop) {
        if (prop === "CLERK_SECRET_KEY") return "sk_test_provisioning";
        if (prop === "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY") return "pk_test_provisioning";
        return Reflect.get(target, prop);
      },
    }),
  };
});

const clerk = vi.hoisted(() => ({ externalId: null as string | null, email: "" }));

vi.mock("@clerk/nextjs/server", () => ({
  auth: () => Promise.resolve({ userId: clerk.externalId }),
  currentUser: () =>
    Promise.resolve(
      clerk.externalId === null
        ? null
        : {
            primaryEmailAddressId: "idn_1",
            emailAddresses: [{ id: "idn_1", emailAddress: clerk.email, verification: { status: "verified" } }],
            firstName: "Sam",
            lastName: "Lee",
            imageUrl: "",
          },
    ),
}));

const EXPECTED_AFTER_SIGN_UP = "${expected}";

beforeAll(async () => {
  await seedPermissions(db, { log: () => {} });
});

afterEach(() => {
  clerk.externalId = null;
});

async function rowFor(externalId: string) {
  const [row] = await db.select().from(users).where(eq(users.externalId, externalId));
  return row;
}

describe("setting a person up", () => {
  it("the first page request alone sets a new person up", async () => {
    clerk.externalId = "user_page_first";
    clerk.email = "page.first@example.test";
    const principal = await currentPrincipal();
    expect(principal?.email).toBe("page.first@example.test");
    expect((await rowFor("user_page_first"))?.provisionedAt).not.toBeNull();
    const session = await tenancy.resolveSession({ userId: principal!.userId });
    expect(session.state).toBe(EXPECTED_AFTER_SIGN_UP);
  });

  it("webhook first (row written and set up), then the first page: set up once, not twice", async () => {
    // What the webhook does on user.created: write the row, then provision.
    const [row] = await db
      .insert(users)
      .values({ externalId: "user_webhook_first", email: "webhook.first@example.test", displayName: "Sam Lee" })
      .returning();
    await tenancy.provisionUser({ userId: row!.id, email: row!.email });
    const stamped = (await rowFor("user_webhook_first"))?.provisionedAt;
    expect(stamped).not.toBeNull();

    clerk.externalId = "user_webhook_first";
    clerk.email = "webhook.first@example.test";
    const principal = await currentPrincipal();
    expect(principal?.userId).toBe(row!.id);
    expect((await rowFor("user_webhook_first"))?.provisionedAt?.getTime()).toBe(stamped?.getTime());
    const session = await tenancy.resolveSession({ userId: row!.id });
    expect(session.state).toBe(EXPECTED_AFTER_SIGN_UP);
  });

  it("a 0.21 account the webhook race left with nothing is set up on its next visit", async () => {
    // The bug: the webhook wrote the row, the page found it and skipped
    // setting the person up, and nothing ever came back to it.
    const [row] = await db
      .insert(users)
      .values({ externalId: "user_left_behind", email: "left.behind@example.test", displayName: "Sam Lee" })
      .returning();
    expect(row!.provisionedAt).toBeNull();

    clerk.externalId = "user_left_behind";
    clerk.email = "left.behind@example.test";
    await currentPrincipal();
    expect((await rowFor("user_left_behind"))?.provisionedAt).not.toBeNull();
    const session = await tenancy.resolveSession({ userId: row!.id });
    expect(session.state).toBe(EXPECTED_AFTER_SIGN_UP);
  });${namedWorkspace}
});
`;
}

/**
 * Accepting by the mailed link, through the project's OWN route and Clerk
 * wiring (review R3 TB2-10). The package's handlers are tested with a fake
 * principal; this proves the generated `app/api/tenancy/[...path]/route.ts`
 * hands them the caller's verified addresses, so dropping that one line from
 * `src/server/tenancy-handlers.ts` fails `pnpm test` instead of shipping.
 */
export function renderInviteAcceptRouteTest(answers: Answers): string {
  const scope = answers.scope;
  const companies = companiesMode(answers);
  const companyOf = companies
    ? `async function companyOf(ownerId: string): Promise<string> {
  const out = await tenancy.createCompany({ userId: ownerId, name: "Greenblade Lawn", requestKey: "accept-route-owner", purpose: "onboarding" });
  return out.company.id;
}`
    : `/** Single-business mode: the owner's workspace was made when they were set up. */
async function companyOf(ownerId: string): Promise<string> {
  return personalWorkspaceId(ownerId);
}`;
  const companyImport = companies ? "" : `import { personalWorkspaceId } from "${scope}/tenancy";\n`;
  return `import { beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { users } from "${scope}/auth/schema";
${companyImport}import { db } from "@/db";
import { seedPermissions } from "@/permissions/seed";
import { tenancy } from "@/server/tenancy";
import { POST } from "../../../app/api/tenancy/[...path]/route";

/**
 * ACCEPTING BY THE LINK, WITH ANY ADDRESS CLERK VERIFIED — through this
 * project's own route (app/api/tenancy/[...path]/route.ts), its own sign-in
 * (src/server/auth.ts) and its own wiring (src/server/tenancy-handlers.ts),
 * not the package's handlers with a stand-in (review R3 TB2-10).
 *
 * Pat signed up with a home address and later added and verified a work one
 * in Clerk. The owner invites the work address. Pressing Accept must work:
 * the route hands the package every address Clerk VERIFIED. If that wiring is
 * dropped, the package falls back to the one address mirrored onto Pat's row
 * (home) and Pat is told the invitation "was sent to someone else" — the bug
 * this file exists to catch. An address Pat only TYPED into Clerk (never
 * verified) and an address that isn't Pat's must still be refused.
 *
 * PGlite: a real Postgres in this process. Clerk is the only thing stood in
 * for, at its own module boundary.
 */
vi.mock("@/db", async () => {
  const { createAppPglite } = await import("@/test/pglite");
  return { db: (await createAppPglite()).db };
});
${consumerSeatLift(answers)}
/** Clerk keys present, so the route signs the caller in instead of answering "signed out". */
vi.mock("@/env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/env")>();
  return {
    ...actual,
    env: new Proxy(actual.env, {
      get(target, prop) {
        if (prop === "CLERK_SECRET_KEY") return "sk_test_accept_route";
        if (prop === "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY") return "pk_test_accept_route";
        return Reflect.get(target, prop);
      },
    }),
  };
});

const PAT = {
  externalId: "user_pat_accept_route",
  home: "pat.home@example.test",
  work: "pat.work@greenblade.test",
  typed: "pat.typed@greenblade.test",
};

vi.mock("@clerk/nextjs/server", () => ({
  auth: () => Promise.resolve({ userId: PAT.externalId }),
  currentUser: () =>
    Promise.resolve({
      primaryEmailAddressId: "idn_home",
      emailAddresses: [
        { id: "idn_home", emailAddress: PAT.home, verification: { status: "verified" } },
        // Added later and verified: Mixed case, as people type it.
        { id: "idn_work", emailAddress: "Pat.Work@Greenblade.test", verification: { status: "verified" } },
        // Typed into the profile, never verified.
        { id: "idn_typed", emailAddress: PAT.typed, verification: { status: "unverified" } },
      ],
      firstName: "Pat",
      lastName: "Lee",
      imageUrl: "",
    }),
}));

${companyOf}

const fx = {} as { ownerId: string; tenantId: string; tokens: Record<"work" | "typed" | "stranger", string> };

beforeAll(async () => {
  await seedPermissions(db, { log: () => {} });
  const [owner] = await db
    .insert(users)
    .values({ externalId: "user_owner_accept_route", email: "olivia@greenblade.test", displayName: "Olivia" })
    .returning();
  await tenancy.provisionUser({ userId: owner!.id, email: owner!.email });
  fx.ownerId = owner!.id;
  fx.tenantId = await companyOf(owner!.id);
  const invite = async (email: string) =>
    (await tenancy.sendInvitation({ actorUserId: fx.ownerId, tenantId: fx.tenantId, email, roleKey: "member" })).token;
  fx.tokens = { work: await invite(PAT.work), typed: await invite(PAT.typed), stranger: await invite("someone.else@greenblade.test") };
});

/** Pressing Accept on the invite page: the same request the widget sends. */
async function accept(token: string): Promise<{ status: number; body: { status?: string; company?: { id: string } | null } }> {
  const res = await POST(
    new Request("http://localhost/api/tenancy/v1/invitations/accept", {
      method: "POST",
      headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" },
      body: JSON.stringify({ token }),
    }),
  );
  return { status: res.status, body: (await res.json()) as { status?: string; company?: { id: string } | null } };
}

async function patId(): Promise<string | null> {
  const [row] = await db.select().from(users).where(eq(users.externalId, PAT.externalId));
  return row?.id ?? null;
}

describe("accepting by the link, through this project's route", () => {
  it("refuses an address Clerk hasn't verified, and one that isn't the caller's", async () => {
    for (const token of [fx.tokens.typed, fx.tokens.stranger]) {
      const out = await accept(token);
      expect(out.status).toBe(200);
      expect(out.body.status).toBe("wrong-email");
    }
    expect(await tenancy.membership({ userId: (await patId())!, tenantId: fx.tenantId })).toBe("not-a-member");
  });

  it("accepts an invitation sent to a SECOND verified address, not only the one on the account", async () => {
    // Pat's row carries the home address (the verified primary) — so this
    // only passes if the route handed the package the work one too.
    const [row] = await db.select().from(users).where(eq(users.externalId, PAT.externalId));
    expect(row?.email).toBe(PAT.home);
    const out = await accept(fx.tokens.work);
    expect(out.body.status, "an invitation to a verified second address").toBe("accepted");
    expect(out.body.company?.id).toBe(fx.tenantId);
    expect(await tenancy.membership({ userId: row!.id, tenantId: fx.tenantId })).toBe("member");
  });
});
`;
}

/**
 * `src/server/__tests__/invite-email-route.test.ts` (review R4 SEC-T1-B): the
 * team page's "We emailed …" is only ever said about an email that went —
 * proved through THIS project's own handlers and mailer wiring, in both the
 * email and the no-email variants.
 */
export function renderInviteEmailRouteTest(answers: Answers): string {
  const scope = answers.scope;
  const companies = companiesMode(answers);
  const companyOf = companies
    ? `async function companyOf(ownerId: string): Promise<string> {
  const out = await tenancy.createCompany({ userId: ownerId, name: "Greenblade Lawn", requestKey: "invite-email-owner", purpose: "onboarding" });
  return out.company.id;
}`
    : `/** Single-business mode: the owner's workspace was made when they were set up. */
async function companyOf(ownerId: string): Promise<string> {
  return personalWorkspaceId(ownerId);
}`;
  const companyImport = companies ? "" : `import { personalWorkspaceId } from "${scope}/tenancy";\n`;
  return `import { beforeAll, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { users } from "${scope}/auth/schema";
${companyImport}import { db } from "@/db";
import { seedPermissions } from "@/permissions/seed";
import { tenancy } from "@/server/tenancy";
import { buildTenancyHandlers } from "@/server/tenancy-handlers";

/**
 * "WE EMAILED" ONLY ABOUT AN EMAIL THAT WENT — through this project's own
 * handlers (src/server/tenancy-handlers.ts) and mailer
 * (src/server/invitation-mail.ts) (review R4 SEC-T1-B).
 *
 * One company emails one address at most once every 10 minutes. That limit
 * must count only emails that actually went: a Resend straight after an
 * invitation the mailer SKIPPED (no RESEND_API_KEY, no email package), FAILED
 * or THREW on used to be held back with "We emailed … a minute ago" — a
 * sentence about an email nobody sent, while the owner waited for it.
 *
 *   - as this project is set up here (no RESEND_API_KEY, or no email
 *     package): never held, the link every time, nothing counted;
 *   - the mailer answering skipped or failed, or throwing: the next Resend is
 *     emailed, not held;
 *   - and once an email DID go, the limit holds, and says so truly.
 *
 * PGlite: a real Postgres in this process. The mailer is stood in for only
 * where a test says so, at its own module boundary.
 */
vi.mock("@/db", async () => {
  const { createAppPglite } = await import("@/test/pglite");
  return { db: (await createAppPglite()).db };
});
${consumerSeatLift(answers)}
/** No RESEND_API_KEY, whatever this laptop's .env.local says: nothing here may send real mail. */
vi.mock("@/env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/env")>();
  return {
    ...actual,
    env: new Proxy(actual.env, {
      get(target, prop) {
        if (prop === "RESEND_API_KEY") return undefined;
        return Reflect.get(target, prop);
      },
    }),
  };
});

type Mode = "project" | "sent" | "skipped" | "failed" | "throws";
const mail = vi.hoisted(() => ({ mode: "project" as Mode, tried: [] as string[], projectAsked: 0 }));

/**
 * "project": this project's own mailer, exactly as it is set up here.
 * Otherwise a mailer that can send, answering as the test says.
 */
vi.mock("@/server/invitation-mail", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/invitation-mail")>();
  return {
    ...actual,
    get invitationEmailsConfigured() {
      return mail.mode === "project" ? actual.invitationEmailsConfigured : true;
    },
    sendInvitationEmail: async (request: Parameters<typeof actual.sendInvitationEmail>[0]) => {
      if (mail.mode === "project") {
        mail.projectAsked += 1;
        return actual.sendInvitationEmail(request);
      }
      mail.tried.push(request.to);
      if (mail.mode === "throws") throw new Error("the mail provider timed out");
      return { status: mail.mode, delivered: mail.mode === "sent" };
    },
  };
});

${companyOf}

const OWNER_EMAIL = "olivia@greenblade.test";
const fx = {} as { ownerId: string; tenantId: string };

beforeAll(async () => {
  await seedPermissions(db, { log: () => {} });
  const [owner] = await db
    .insert(users)
    .values({ externalId: "user_owner_invite_email", email: OWNER_EMAIL, displayName: "Olivia" })
    .returning();
  await tenancy.provisionUser({ userId: owner!.id, email: OWNER_EMAIL });
  fx.ownerId = owner!.id;
  fx.tenantId = await companyOf(owner!.id);
});

interface Issued {
  delivery?: string;
  note?: string | null;
  link?: string | null;
  invitation?: { id: string };
}

/** The team page's Invite and Resend buttons, through this project's handlers. */
async function post(path: string, body: unknown): Promise<Issued> {
  const { handle } = buildTenancyHandlers({
    principal: async () => ({ userId: fx.ownerId, email: OWNER_EMAIL }),
    verifiedEmails: async () => [OWNER_EMAIL],
  });
  const res = await handle(
    new Request(\`http://localhost/api/tenancy/v1/companies/\${fx.tenantId}/\${path}\`, {
      method: "POST",
      headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" },
      body: JSON.stringify(body),
    }),
  );
  const text = await res.text();
  expect(res.status, text).toBe(200);
  return JSON.parse(text) as Issued;
}

const invite = (email: string) => post("invitations", { email, roleKey: "member" });
const resend = (id: string) => post(\`invitations/\${id}/resend\`, {});

/** How many emails the limits count for this invitation. */
async function emailsCounted(invitationId: string): Promise<number> {
  const result = await db.execute(sql\`select cardinality(emailed_at) as n from tenant_invitations where id = \${invitationId}\`);
  const rows = (result as unknown as { rows: { n: number | string }[] }).rows;
  return Number(rows[0]?.n ?? -1);
}

describe("invitation emails, through this project's handlers", () => {
  it("as set up here nothing is emailed, so nothing is ever held: the link every time, never 'We emailed'", async () => {
    mail.mode = "project";
    mail.projectAsked = 0;
    const first = await invite("crew.unsent@greenblade.test");
    const again = await resend(first.invitation!.id);
    const third = await resend(first.invitation!.id);
    for (const out of [first, again, third]) {
      expect(out.delivery, JSON.stringify(out)).toBe("skipped");
      expect(out.link).toMatch(/\\/invite\\//);
      expect(out.note ?? "").not.toMatch(/We emailed/);
    }
    expect(await emailsCounted(first.invitation!.id)).toBe(0);
    // A project that can't send isn't even told it emails: the handlers get no
    // mailer, so not even two Resends at once can be held for an email that
    // was never going to go.
    expect(mail.projectAsked).toBe(0);
  });

  for (const outcome of ["skipped", "failed", "throws"] as const) {
    it(\`the mailer \${outcome === "throws" ? "throws" : \`answers \${outcome}\`}: Resend straight after is emailed, never held, never 'We emailed'\`, async () => {
      mail.mode = outcome;
      mail.tried.length = 0;
      const address = \`crew.\${outcome}@greenblade.test\`;
      const first = await invite(address);
      expect(first.delivery).toBe(outcome === "skipped" ? "skipped" : "failed");
      expect(first.link).toMatch(/\\/invite\\//);
      expect(await emailsCounted(first.invitation!.id)).toBe(0);

      mail.mode = "sent";
      const again = await resend(first.invitation!.id);
      expect(again.delivery, JSON.stringify(again)).toBe("sent");
      expect(again.note ?? null).toBeNull();
      expect(mail.tried).toEqual([address, address]);

      // The one that went counts: the limit holds now, and says so truly.
      const held = await resend(first.invitation!.id);
      expect(held.delivery).toBe("held");
      expect(held.note).toContain(\`We emailed \${address} less than a minute ago\`);
      expect(held.link).toMatch(/\\/invite\\//);
      expect(mail.tried).toHaveLength(2);
    });
  }
});
`;
}
