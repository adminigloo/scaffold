/**
 * A PROJECT WHOSE CUSTOMERS ARE PEOPLE (billing 0.5): `--tenant-noun none
 * --audience consumers`. Two files differ from a single business's:
 *
 *   src/plans.ts                 the sample plans are a person's: flags and
 *                                quotas they buy, in two product lines that
 *                                stack on one bill — and no team members,
 *                                because nobody here has a team
 *   app/(site)/settings/team     no team: the page says the account is just
 *                                the person's (old links still land), and the
 *                                seat limit of one refuses every invitation on
 *                                the server (src/server/plan-gate.ts)
 */
import type { Answers } from "./answers.js";

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
 * FREE IS NOT A PLAN: it's a signed-in account with no subscription (no $0
 * subscriptions). PRICES ARE PLACEHOLDERS — set your own, in minor units
 * (500n is $5.00). Yearly is ten months' price, so it leads on the pricing
 * page: Stripe's fee is a smaller share of one bigger charge.
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
          // "Most popular" — at most one per line.
          highlight: true,
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

export function renderConsumerTeamPage(answers: Answers): string {
  const back = answers.businessModel !== "none" ? "/account" : "/";
  return `import Link from "next/link";
import { PageHeader, WORK_MAIN } from "@/components/ui";

/**
 * YOUR ACCOUNT IS JUST YOURS (billing 0.5). This project's customers sign up
 * as themselves and each person's plans are their own, so there is no team
 * to invite anyone into — and the server refuses every invitation (the seat
 * limit of one in src/server/plan-gate.ts), so a plan can't be shared by
 * inviting people in. The page stays for old links (/members lands here) and
 * says so in plain words.
 */
export const dynamic = "force-dynamic";

export default function TeamPage() {
  return (
    <main className={WORK_MAIN}>
      <PageHeader title="Just you" description="This account is for one person." />
      <p className="max-w-[62ch] text-sm text-ink-muted">
        There&apos;s no team to invite here: everything on this site is yours alone. Someone else who wants it can sign up with
        their own email.
      </p>
      <p className="mt-4 text-sm">
        <Link href="${back}" className="font-medium text-accent underline underline-offset-2">
          Back to your account
        </Link>
      </p>
    </main>
  );
}
`;
}
