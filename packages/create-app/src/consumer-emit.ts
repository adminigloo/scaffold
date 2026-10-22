/**
 * A PROJECT WHOSE CUSTOMERS ARE PEOPLE (billing 0.5): `--tenant-noun none
 * --audience consumers`. What differs from a single business's:
 *
 *   src/plans.ts                 the sample plans are a person's: a free tier,
 *                                flags and quotas they buy, in two product
 *                                lines that stack on one bill — and no team
 *                                members, because nobody here has a team
 *   no team (create-app 0.39)    no /settings/team, /members or /invite page,
 *                                no invitation email; the seat limit of one
 *                                refuses any invitation on the server
 *                                (src/server/plan-gate.ts), and no role —
 *                                the owner included — holds the keys that
 *                                invite, remove, re-role or hand over
 */
import { consumerProduct, type Answers } from "./answers.js";

export function renderConsumerPlanCatalog(answers: Answers): string {
  const scope = answers.scope;
  return `import { definePlans } from "${scope}/billing";

/**
 * What each plan includes, what it costs, and nothing else — for the PEOPLE
 * who sign up (billing 0.5: each person's own account pays for its plans).
 *
 * THE SOURCE OF TRUTH. The \`plans\` TABLE is a projection of this object plus
 * a cache of two Stripe ids; \`pnpm db:seed:plans\` writes that projection and
 * reports anything in the table this record does not account for. The
 * pricing page and /account/billing render it; \`requireEntitlement(feature)\`
 * (src/server/access.ts) enforces it, from the rows each person's plans wrote.
 *
 * PRODUCT LINES. Each line is something sold on its own, with its own tiers:
 * a person holds ONE tier of each line at once, and the lines STACK on one
 * Stripe subscription — one card, one invoice, one billing date. Moving from
 * Basic to Pro swaps that line's tier (prorated, charged today); adding the
 * Extras line adds it to the same bill; dropping Extras leaves Membership as
 * it is. Tier keys are unique across every line.
 *
 * THE FEATURES ARE WHAT A PERSON BUYS — a flag (on or off) or a quota (how
 * many). Gate each in your code by name: \`<Entitled feature="pro_tools">\` on a
 * page, \`withEntitlement("pro_tools", handler)\` on a route,
 * \`requireEntitlement("pro_tools")\` on a tRPC procedure. A feature nothing
 * checks is a feature you'd be selling that doesn't exist, so rename these to
 * your own.
 *
 * THE FREE TIER (\`free:\`) is what a signed-in account holds with no plan on
 * that line — no $0 subscription, nothing at Stripe. Declared once, it is what
 * \`requireEntitlement\` grants a person with no plan, the Free column on the
 * pricing page and the card the plan chooser marks "Your plan". Delete it and
 * an account with no plan simply has none of these features.
 *
 * ON SALE: a tier is sold unless it says \`onSale: "coming"\` (shown with its
 * price and "Coming soon", never sold — for a plan whose features aren't built
 * yet) or \`onSale: false\` (sold by hand only: free months, a founding
 * member). No tier says "Most popular" until you set \`highlight: true\` on
 * one: a new site's pricing page shouldn't claim a favourite nobody has bought.
 *
 * PRICES ARE PLACEHOLDERS — set your own, in minor units (500n is $5). Yearly
 * is ten months' price ("2 months free"), and it leads on the pricing page:
 * Stripe's fee is a smaller share of one bigger charge.
 *
 * A TIER IS RETIRED, NEVER DELETED: subscriptions reference the rows it
 * projects, so set \`isActive: false\` to take one off sale.
 */
export const plans = definePlans({
  lines: {
    membership: {
      name: "Membership",
      description: "The whole site, sized to how much you use it.",
      features: {
        member_access: { kind: "flag", label: "Everything in the members' area" },
        pro_tools: { kind: "flag", label: "Pro tools" },
        saved_items: { kind: "quota", label: "saved items", labelOne: "saved item" },
      },
      // What a signed-in account gets with no plan.
      free: {
        description: "Look around, and save a few things.",
        features: { member_access: false, pro_tools: false, saved_items: 3 },
      },
      tiers: [
        {
          key: "basic",
          name: "Basic",
          description: "Everything in the members' area.",
          prices: { month: { usd: 500n }, year: { usd: 5000n } },
          features: { member_access: true, pro_tools: false, saved_items: 25 },
        },
        {
          key: "pro",
          name: "Pro",
          description: "Basic, plus the pro tools and room to save everything.",
          prices: { month: { usd: 2000n }, year: { usd: 20000n } },
          features: { member_access: true, pro_tools: true, saved_items: null },
        },
      ],
    },
    extras: {
      name: "Extras",
      description: "Added to your membership, on the same bill.",
      features: {
        extras_pack: { kind: "flag", label: "The extras pack" },
      },
      tiers: [
        {
          key: "extras",
          name: "Extras",
          description: "The extras pack, on top of any membership.",
          prices: { month: { usd: 500n }, year: { usd: 5000n } },
          features: { extras_pack: true },
        },
      ],
    },
  },
});

/**
 * The few features each plan leads with on the plans pages; every other one
 * is under "What's included". Feature keys from the lines above, in order.
 */
export const HEADLINE_FEATURES: readonly string[] = ["member_access", "pro_tools", "saved_items", "extras_pack"];

/** The currency the plans pages open on. */
export const DEFAULT_CURRENCY: string = plans.currencies.includes("usd") ? "usd" : (plans.currencies[0] ?? "usd");
`;
}

/**
 * Does anybody in this project invite anyone into an account? Not in a
 * consumers project (create-app 0.39): each person signs up as themselves and
 * their account is theirs alone.
 */
export function teamInvites(answers: Pick<Answers, "tenantNoun" | "audience">): boolean {
  return !consumerProduct(answers);
}

/**
 * What a consumers project doesn't have (create-app 0.39), by the path the
 * base template or an overlay would otherwise write: the team page, the
 * members redirect, the page an invitation link opens, where invitation links
 * are built, the invitation email and its /setup preview. Deleted from the plan
 * (and so, by `upgrade`, from a project that has them untouched).
 */
export const PERSONAL_ACCOUNT_RETIRED: readonly string[] = [
  "app/(site)/settings/team/page.tsx",
  "app/(site)/members/page.tsx",
  "app/(site)/invite/[token]/page.tsx",
  "src/invitations.ts",
  "src/emails/invitation.ts",
  "app/(site)/setup/email/page.tsx",
];

/**
 * `src/server/mail.ts` (create-app 0.39), in a consumers project with
 * --email: the one sender for this site's own emails to the people who use it
 * (a welcome, a receipt note, a digest) — every send recorded in the delivery
 * log, never thrown. A consumers project has no invitation email, so without
 * this --email would install a mail package nothing sends with.
 */
export function renderConsumerMail(answers: Answers): string {
  const scope = answers.scope;
  return `import { createEmailSender, EmailTransportError, formatSenderAddress } from "${scope}/email";
import { emailEvents } from "${scope}/email/schema";
import { db } from "@/db";
import { env } from "@/env";
import { log } from "@/server/logger";

/**
 * THIS SITE'S EMAILS TO ITS PEOPLE (create-app 0.39). One sender for the
 * process; with no RESEND_API_KEY every send is recorded as "skipped" and
 * nothing goes out, which is what a laptop wants.
 *
 *   const outcome = await sendEmail({
 *     to: person.email, subject: "Your morning summary", html, text,
 *     template: "morning-digest", tenantId,
 *   });
 *
 * Keep each message's words in its own file under src/emails/ (a function
 * from the data to { subject, html, text }), the way @${scope.replace(/^@/, "")}/email's
 * templates are written.
 */

/**
 * EMAIL_FROM is deferred until deployment, so on a laptop it is undefined —
 * and \`createEmailSender\` throws for a From it can't parse. The fallback is an
 * RFC 2606 reserved domain that can never receive anything.
 */
const sender = createEmailSender({
  apiKey: env.RESEND_API_KEY,
  from: env.EMAIL_FROM ?? "hello@example.invalid",
  replyTo: env.EMAIL_REPLY_TO,
});

/** Can this site send email right now (RESEND_API_KEY set)? */
export const emailConfigured: boolean = sender.configured;

export interface OutgoingEmail {
  readonly to: string;
  readonly subject: string;
  readonly html: string;
  readonly text: string;
  /** Recorded in \`email_events.template\`, so the log can be filtered by kind. */
  readonly template: string;
  /** The person's account it is about, when it is about one. */
  readonly tenantId?: string | null;
  /** Ids only, never a token: this column outlives the token. */
  readonly metadata?: Record<string, string>;
  /**
   * Extra headers (create-app 0.40): the digests' RFC 8058 one-click
   * unsubscribe pair (List-Unsubscribe, List-Unsubscribe-Post).
   */
  readonly headers?: Readonly<Record<string, string>>;
  /**
   * The same on every retry of one message: Resend drops the repeat, so a
   * retry after a timeout never sends it twice (create-app 0.40).
   */
  readonly idempotencyKey?: string;
}

/** What happened to one email. \`retryable\` on a failure: the provider may take it later (a timeout, a 429, a 5xx). */
export type SentEmail =
  | { readonly status: "sent" | "skipped" }
  | { readonly status: "failed"; readonly error: string; readonly retryable: boolean };

/**
 * Send one email. Returns the provider's answer ("sent", "skipped" without a
 * key, "failed") and never throws: a message the provider refuses to build is
 * a "failed" with a log row, not an exception in the caller.
 */
export async function sendEmail(email: OutgoingEmail): Promise<SentEmail> {
  let outcome: Awaited<ReturnType<typeof sender.send>>;
  try {
    outcome = await sender.send({
      to: email.to,
      subject: email.subject,
      html: email.html,
      text: email.text,
      template: email.template,
      ...(email.tenantId ? { tenantId: email.tenantId } : {}),
      metadata: email.metadata ?? {},
      ...(email.headers ? { headers: email.headers } : {}),
      ...(email.idempotencyKey ? { idempotencyKey: email.idempotencyKey } : {}),
    });
  } catch (cause) {
    const error = cause instanceof Error ? cause : new Error(String(cause));
    await recordDelivery({
      messageId: null,
      toAddress: email.to,
      fromAddress: formatSenderAddress(sender.from),
      subject: email.subject,
      template: email.template,
      tenantId: email.tenantId ?? null,
      status: "failed",
      error: error.message,
      metadata: email.metadata ?? {},
    });
    // A message the package refused to build: sending it again won't help.
    return { status: "failed", error: error.message, retryable: false };
  }
  // The provider's answer is the truth about the email; the log row is bookkeeping.
  await recordDelivery(outcome.log);
  if (outcome.status === "failed") return { status: "failed", error: outcome.error.message, retryable: mayRetry(outcome.error) };
  return { status: outcome.status };
}

/**
 * May the provider take this message later? Unreachable (no status), asked to
 * slow down (429) or broken on its side (5xx): yes. Anything else — a bad
 * address, an unverified domain — will fail the same way again.
 */
function mayRetry(error: Error): boolean {
  if (!(error instanceof EmailTransportError)) return false;
  return error.status === null || error.status === 429 || error.status >= 500;
}

/** Writes one delivery-log row and never throws. */
async function recordDelivery(row: typeof emailEvents.$inferInsert): Promise<void> {
  try {
    await db.insert(emailEvents).values(row);
  } catch (cause) {
    log.error({ err: cause, template: row.template, status: row.status }, "email: the delivery log row could not be written");
  }
}
`;
}

/**
 * `src/server/membership.ts` (create-app 0.39), in every project: who counts
 * as a member of an account, for the permission loaders — and so for every
 * tenant procedure, every page gate and `requireEntitlement`. Generated in
 * two variants, so src/server/permissions.ts carries no `if`:
 *
 *   consumers   each person is a member of their OWN account and nobody
 *               else's (review: a membership left from the --audience
 *               business days let `requireEntitlement` serve someone the
 *               owner's paid plan, by naming the owner's account id)
 *   otherwise   @adminigloo/tenancy's own gate, unchanged
 */
export function renderMembershipGate(answers: Answers): string {
  const scope = answers.scope;
  if (!consumerProduct(answers)) {
    return `/**
 * WHO COUNTS AS A MEMBER, for the permission loaders (src/server/permissions.ts):
 * an active member of an account that isn't suspended or deleted —
 * ${scope}/tenancy's own gate, unchanged. GENERATED in two variants: in a
 * project whose customers are people (--audience consumers), each person is a
 * member of their own account and of nobody else's.
 *
 * Imports no app module, so it never joins the cycle src/server/tenancy.ts
 * sits in.
 */
export { tenancyMembershipGate as membershipGate } from "${scope}/tenancy/server";
`;
  }
  return `import { and, eq } from "drizzle-orm";
import type { MembershipGate } from "${scope}/permissions/server";
import { personalWorkspaceId } from "${scope}/tenancy";
import { tenants } from "${scope}/tenancy/schema";
import { tenancyMembershipGate } from "${scope}/tenancy/server";

/**
 * WHO COUNTS AS A MEMBER OF AN ACCOUNT, for the permission loaders
 * (src/server/permissions.ts) — and so for every tenant procedure, every page
 * gate, \`requireEntitlement\` and the billing pages (create-app 0.39).
 *
 * ONE PERSON PER ACCOUNT. Each person here signs up as themselves and acts
 * only in their own account. A membership of somebody else's — an invitation
 * accepted while this project was --audience business — is answered "not a
 * member", so a call that names another account's id is refused like a
 * stranger's, and nobody uses what someone else pays for (review). \`pnpm
 * db:seed\` suspends those memberships too (src/permissions/shared-accounts.ts).
 *
 * After that, ${scope}/tenancy's own gate: an active membership of an
 * account that isn't suspended or deleted. Imports no app module, so it never
 * joins the cycle src/server/tenancy.ts sits in.
 */
export const membershipGate: MembershipGate = async (db, input) => {
  if (input.tenantId !== personalWorkspaceId(input.userId)) {
    // A fresh personal account (ws_<user>.2, made after an earlier one was
    // handed over) is still theirs: one of their own that they own.
    const [own] = await db
      .select({ id: tenants.id })
      .from(tenants)
      .where(and(eq(tenants.id, input.tenantId), eq(tenants.ownerUserId, input.userId), eq(tenants.kind, "personal")))
      .limit(1);
    if (own === undefined) return "not-a-member";
  }
  return tenancyMembershipGate(db, input);
};
`;
}

/**
 * `src/permissions/shared-accounts.ts` (create-app 0.39), in every project:
 * what \`pnpm db:seed\` does about accounts more than one person is in.
 * Consumers: every such membership of somebody else's personal account is
 * suspended and named (the switch from --audience business leaves them
 * behind). Anywhere else: nothing — accounts there have teams.
 */
export function renderSharedAccounts(answers: Answers): string {
  const scope = answers.scope;
  if (!consumerProduct(answers)) {
    return `import type { SeedDb } from "./seed";

/**
 * Accounts more than one person is in: nothing to do here — this project's
 * accounts have teams. GENERATED in two variants: in a project whose
 * customers are people (--audience consumers), \`pnpm db:seed\` suspends
 * anyone who is a member of somebody else's account.
 */
export interface SharedMembership {
  readonly tenantId: string;
  readonly userId: string;
}

export async function closeSharedAccounts(_db: SeedDb): Promise<readonly SharedMembership[]> {
  return [];
}
`;
  }
  return `import { and, eq, isNotNull, ne } from "drizzle-orm";
import { tenantMembers, tenants } from "${scope}/tenancy/schema";
import type { SeedDb } from "./seed";

/**
 * ONE PERSON PER ACCOUNT, IN THE DATABASE TOO (create-app 0.39). Every account
 * here is one person's, but a project that ran as --audience business first
 * may still hold memberships of somebody else's account (an invitation that
 * was accepted then). Each one is SUSPENDED by \`pnpm db:seed\` — every deploy
 * runs it — and named in its output: the person keeps their own account and
 * everything in it, and loses nothing of their own. (The permission loaders
 * refuse those memberships anyway: src/server/membership.ts.)
 *
 * Suspended, not deleted: the row says who was there, and an operator can
 * put it back by hand if a project ever has teams again.
 */
export interface SharedMembership {
  readonly tenantId: string;
  readonly userId: string;
}

export async function closeSharedAccounts(db: SeedDb): Promise<readonly SharedMembership[]> {
  const shared = await db
    .select({ tenantId: tenantMembers.tenantId, userId: tenantMembers.userId })
    .from(tenantMembers)
    .innerJoin(tenants, eq(tenants.id, tenantMembers.tenantId))
    .where(
      and(
        eq(tenants.kind, "personal"),
        eq(tenantMembers.status, "active"),
        isNotNull(tenants.ownerUserId),
        ne(tenantMembers.userId, tenants.ownerUserId),
      ),
    );
  for (const row of shared) {
    await db
      .update(tenantMembers)
      .set({ status: "suspended", updatedAt: new Date() })
      .where(and(eq(tenantMembers.tenantId, row.tenantId), eq(tenantMembers.userId, row.userId), eq(tenantMembers.status, "active")));
  }
  return shared;
}
`;
}

/**
 * `src/server/tenant.ts` in a consumers project (create-app 0.39): whose
 * account a page is about is ALWAYS the signed-in person's own — never the
 * session's "active" one. In a project with companies (or one business's
 * staff) a person can belong to several and switch; here nobody can be in
 * anyone else's, and if a stray membership ever existed (an invitation
 * accepted before the seat limit), a plan someone else pays for must not
 * reach this person, so access, billing and the account pages read their own.
 */
export function renderConsumerTenant(answers: Answers): string {
  const scope = answers.scope;
  return `import { personalWorkspaceId } from "${scope}/tenancy";
import { tenancy } from "./tenancy";

/**
 * Which account a signed-in person is looking at: THEIR OWN, always
 * (create-app 0.39). Each person here signs up as themselves and their
 * account is theirs alone, so the plan check (src/server/access.ts), the
 * billing page and the account pages all read the person's own account —
 * never another one the session happens to point at.
 *
 * Null when it isn't ready (made at the person's first sign-in) or is
 * suspended.
 */
export interface CurrentTenant {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  /** Always true here: every account is a person's own. */
  readonly isPersonal: boolean;
}

export async function currentTenantFor(userId: string): Promise<CurrentTenant | null> {
  const session = await tenancy.resolveSession({ userId });
  if (session.state === "needs-onboarding") return null;
  const own = personalWorkspaceId(userId);
  const mine = session.companies.find((company) => company.id === own);
  if (mine === undefined || mine.status !== "active") return null;
  return { id: mine.id, name: mine.name, slug: mine.slug, isPersonal: true };
}
`;
}
