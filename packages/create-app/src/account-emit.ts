/**
 * THE ACCOUNT AREA'S GENERATED FILES (create-app 0.39): the words it uses for
 * whoever pays, its heading and tabs, and — in a project with no shop — its
 * overview page. Generated because each differs by two answers the static
 * account overlay can't see:
 *
 *   who pays     a person's own account (`--audience consumers`): "your
 *                account", never "workspace", "company" or "team"; or a
 *                company / one business's workspace, named
 *   is there a   a shop (--model one-time / both): orders and licence keys
 *   shop         have a tab and the overview is the shop's (account-shop
 *                overlay); plans only (--model subscription): Overview and
 *                Billing, and the overview is what you're on
 */
import { consumerProduct, tenantLabel, type Answers } from "./answers.js";
import { sellsShop } from "./shop-emit.js";

// ---------------------------------------------------------------------------
// src/account-copy.ts
// ---------------------------------------------------------------------------

export function renderAccountCopy(answers: Answers): string {
  const personal = consumerProduct(answers);
  const noun = tenantLabel(answers).toLowerCase();
  if (personal) {
    return `/**
 * HOW THE ACCOUNT AND BILLING PAGES NAME WHOEVER PAYS (create-app 0.39).
 * GENERATED: this project's customers are people, each with their own
 * account, so it is always "your account" — never a workspace, a company or
 * a team, which a person here has no reason to know exist. Edit freely.
 */

/** Each person's own account pays for their plans. */
export const PERSONAL_ACCOUNTS = true;

/** What pays, mid-sentence ("Nothing is being charged to your account"). */
export function payerName(_tenantName: string): string {
  return "your account";
}

/** The billing page, signed out. */
export const SIGNED_OUT_BILLING = "Your plan and billing are tied to your account. Sign in to see them.";

/** The billing page for someone with no account yet (it is made at their first sign-in). */
export const NO_ACCOUNT = {
  title: "Your account isn't ready yet",
  body: "It's made the first time you sign in. Reload this page in a moment.",
} as const;

/** Under "Choose a plan". */
export const CHOOSER_HINT = "Change it or cancel whenever you like.";

/** Why the plan can't be changed from here (never shown: a person always owns their own account). */
export function onlyTheOwner(_tenantName: string): string {
  return "Only you can change your plan.";
}

/** The account area's heading. */
export const ACCOUNT_HEADING = {
  title: "Your account",
  description: ${JSON.stringify(sellsShop(answers) ? "Your plan, what you've bought, and your billing." : "Your plan, what it includes, and your billing.")},
} as const;
`;
  }
  return `/**
 * HOW THE ACCOUNT AND BILLING PAGES NAME WHOEVER PAYS (create-app 0.39).
 * GENERATED: in this project a plan belongs to a ${noun}, so the pages name
 * it. Edit freely.
 */

/** A ${noun} pays for its plan, and more than one person can be in it. */
export const PERSONAL_ACCOUNTS = false;

/** What pays, mid-sentence ("Nothing is being charged to Acme"). */
export function payerName(tenantName: string): string {
  return tenantName;
}

/** The billing page, signed out. */
export const SIGNED_OUT_BILLING = "What is being charged depends on which ${noun} you are in, and that depends on who you are.";

/** The billing page for someone who isn't in a ${noun} yet. */
export const NO_ACCOUNT = {
  title: "You're not part of a ${noun} yet",
  body: "A plan belongs to a ${noun}. Once you make one, or someone invites you to theirs, its billing is here.",
} as const;

/** Under "Choose a plan". */
export const CHOOSER_HINT = "Change it whenever you like.";

/** Why the plan can't be changed from here. */
export function onlyTheOwner(tenantName: string): string {
  return \`Only the owner of \${tenantName} can change its plan.\`;
}

/** The account area's heading. */
export const ACCOUNT_HEADING = {
  title: "Your account",
  description: ${JSON.stringify(sellsShop(answers) ? "What you have bought, what it granted you, and what you are being charged for." : "Your plan, what it includes, and what you are being charged for.")},
} as const;
`;
}

// ---------------------------------------------------------------------------
// app/(site)/account/layout.tsx
// ---------------------------------------------------------------------------

export function renderAccountLayout(_answers: Answers): string {
  return `import type { ReactNode } from "react";
import { ACCOUNT_HEADING } from "@/account-copy";
import { AccountTabs } from "@/components/account/AccountTabs";
import { PageHeader } from "@/components/ui";

/**
 * Chrome for everything under \`/account\`: one heading and one tab strip.
 *
 * A LAYOUT RATHER THAN A SHARED COMPONENT EACH PAGE REMEMBERS TO CALL, so the
 * next page somebody adds has the nav without being told to.
 *
 * IT CHECKS NOTHING. Every page below does its own sign-in check and its own
 * ownership check: "the parent layout checked" is not something the type
 * system enforces. Chrome here, authorisation there.
 *
 * THE HEADING IS DRAWN HERE, ABOVE the account pages' loading boundary
 * (loading.tsx beside this file), so it is in the first chunk of every page.
 */
export default function AccountLayout({ children }: { readonly children: ReactNode }) {
  return (
    <main className="mx-auto max-w-3xl px-6 py-10">
      <PageHeader title={ACCOUNT_HEADING.title} description={ACCOUNT_HEADING.description} />
      <AccountTabs />
      {children}
    </main>
  );
}
`;
}

// ---------------------------------------------------------------------------
// src/components/account/AccountTabs.tsx
// ---------------------------------------------------------------------------

export function renderAccountTabs(answers: Answers): string {
  const tabs = sellsShop(answers)
    ? [
        ["/account", "Overview"],
        ["/account/orders", "Orders"],
        ["/account/billing", "Billing"],
      ]
    : [
        ["/account", "Overview"],
        ["/account/billing", "Plan and billing"],
      ];
  return `"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cx } from "@/components/ui";

/**
 * The account area's tabs. GENERATED: ${sellsShop(answers) ? "this project has a shop, so its orders have a tab" : "this project sells plans and no products, so there are no orders to list"}.
 *
 * Every href is written out literally, so the project's link checks can see
 * each route this strip points at.
 */
const TABS: readonly { readonly href: string; readonly label: string }[] = [
${tabs.map(([href, label]) => `  { href: "${href}", label: "${label}" },`).join("\n")}
];

export function AccountTabs() {
  const pathname = usePathname();

  return (
    <nav
      aria-label="Account"
      className="mb-6 flex flex-wrap items-center gap-1 border-b border-line"
    >
      {TABS.map((tab) => {
        // The overview is the prefix of everything else, so it is the one tab
        // that has to match exactly — otherwise it stays lit on every page.
        const active =
          tab.href === "/account"
            ? pathname === "/account"
            : pathname.startsWith(tab.href);

        return (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={active ? "page" : undefined}
            className={cx(
              "-mb-px border-b-2 px-3 py-2 text-sm no-underline transition-colors",
              active
                ? "border-accent text-ink"
                : "border-transparent text-ink-muted hover:text-ink",
            )}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
`;
}

// ---------------------------------------------------------------------------
// app/(site)/account/page.tsx — a project with no shop
// ---------------------------------------------------------------------------

export function renderPlansAccountPage(answers: Answers): string {
  const scope = answers.scope;
  const personal = consumerProduct(answers);
  return `import Link from "next/link";
import { isDbConfigured } from "${scope}/db";
import { planFeatureBullet } from "${scope}/billing";
import { Card, CardBody, CardHeader, Notice, buttonClass } from "@/components/ui";
import { describeSubscription } from "@/account";
import { payerName } from "@/account-copy";
import { OperatorOnly } from "@/components/OperatorOnly";
import { db } from "@/db";
import { plans } from "@/plans";
import { currentPrincipal } from "@/server/auth";
import { readLineHoldings, readSubscriptionsForTenant, type AccountSubscription, type LineHolding } from "@/server/account";
import { loadTenantPermissions } from "@/server/permissions";
import { currentTenantFor } from "@/server/tenant";

/**
 * YOUR ACCOUNT: what you're on and what it includes (create-app 0.39).
 * GENERATED for a project that sells plans and no products — there are no
 * orders, licence keys or deliveries to show, so this is the plan, one card
 * per product line, and where to change it. Your sign-in and email are
 * Clerk's, from the menu under your picture.
 */
export const dynamic = "force-dynamic";

export default async function AccountPage() {
  const principal = await currentPrincipal();
  if (!principal) {
    return (
      <Notice tone="info" title="Sign in to see your account">
        <p>Your plan is tied to your account.</p>
        <p className="mt-3">
          <Link href="/sign-in?redirect_url=%2Faccount" className={buttonClass("primary")}>
            Sign in
          </Link>
        </p>
      </Notice>
    );
  }
  if (!isDbConfigured(db)) {
    return (
      <Notice tone="info" title="This isn't available on this site yet">
        <OperatorOnly>DATABASE_URL isn&apos;t set, so there is no plan to read. /setup lists what is outstanding.</OperatorOnly>
      </Notice>
    );
  }
  const tenant = await currentTenantFor(principal.userId);
  const permissions = tenant ? await loadTenantPermissions({ principal, tenantId: tenant.id }) : null;
  const canView = permissions?.can("subscriptions.view") ?? false;
  const byLine: ReadonlyMap<string, AccountSubscription> =
    tenant && canView ? await readSubscriptionsForTenant(tenant.id) : new Map();
  // What the account is ON, per line, as the plan check reads it (review):
  // never the latest row's status, which kept listing Pro's features after
  // free months ended and for a plan whose first payment never went through.
  const holdings: ReadonlyMap<string, LineHolding> =
    tenant && canView ? await readLineHoldings(tenant.id) : new Map();
  const multiLine = plans.lines.length > 1;

  return (
    <div className="flex flex-col gap-6">
      {tenant === null || !canView ? (
        <Notice tone="info" title="Your plan isn't shown here">
          ${personal ? "It's made the first time you sign in. Reload this page in a moment." : "What a plan includes is shown to the owner and admins of the account that pays for it."}
        </Notice>
      ) : (
        plans.lines.map((line) => {
          const subscription = byLine.get(line.key) ?? null;
          const holding = holdings.get(line.key);
          // The tier the plan check serves on this line right now, if any.
          const tier = holding?.tierKey ? (plans.tier(holding.tierKey) ?? null) : null;
          const live = tier !== null;
          // What the account holds on this line: the served tier's features, else the free tier's.
          const held = tier?.features ?? (holding?.onFree ? (line.free?.features ?? null) : null);
          const bullets = held === null ? [] : Object.values(held).flatMap((feature) => {
            const text = planFeatureBullet(feature);
            return text === null ? [] : [{ feature: feature.feature, text }];
          });
          const name = tier?.name ?? (holding?.onFree ? (line.free?.name ?? null) : null);
          const banner = subscription !== null ? describeSubscription(subscription) : null;
          return (
            <Card key={line.key}>
              <CardHeader
                title={name === null ? (multiLine ? \`No \${line.name} plan\` : "No plan yet") : multiLine ? \`\${line.name}: \${name}\` : name}
                hint={live ? banner?.title : name !== null ? "Free, with no plan." : \`Nothing is being charged to \${payerName(tenant.name)}.\`}
                actions={
                  <Link href="/account/billing" className={buttonClass("secondary")}>
                    {live ? "Change plan" : "See plans"}
                  </Link>
                }
              />
              <CardBody className="flex flex-col gap-2">
                {bullets.length > 0 ? (
                  <ul className="flex list-none flex-col gap-1.5 p-0 text-sm text-ink-muted">
                    {bullets.map((bullet) => (
                      <li key={bullet.feature}>{bullet.text}</li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-sm text-ink-muted">Choose a plan to get started.</p>
                )}
              </CardBody>
            </Card>
          );
        })
      )}

      <Card>
        <CardHeader title="Sign-in and email" hint="Your email address, password and sign-in methods." />
        <CardBody>
          <p className="max-w-[62ch] text-sm text-ink-muted">
            Change them from the menu under your picture at the top of the page (Manage account).
          </p>
        </CardBody>
      </Card>
    </div>
  );
}
`;
}
