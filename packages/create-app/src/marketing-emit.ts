import { consumerProduct, tenantLabel, type Answers } from "./answers.js";
import { companiesMode } from "./tenancy-emit.js";

/**
 * The landing page's words (create-app 0.36, the showroom), for business
 * owners: what it does for them, three outcomes, how it works in three steps,
 * and the plans.
 *
 * src/marketing-copy.ts is THE ONE FILE A PROJECT EDITS TO SPEAK ITS TRADE.
 * The section components (src/components/marketing/*) read every word from
 * it, so a ramp-and-lift installer's site and a cleaning company's site differ
 * by this file alone. It is generated because three of its answers depend on
 * what was installed: the outcomes and steps name only features this project
 * has (no "instant estimates" without the estimator), the screenshots it
 * offers match, and "Go to your dashboard" goes where a signed-in person's
 * work actually is.
 *
 * src/components/marketing/PlansTeaser.tsx has two variants, never an `if`:
 * with a pricing page it reads src/plans.ts (names, promises and the lowest
 * price — no number typed anywhere), without one it renders nothing.
 */

interface Outcome {
  readonly title: string;
  readonly body: string;
  readonly screenshot?: string;
}

function outcomesFor(answers: Answers): readonly Outcome[] {
  const all: Outcome[] = [];
  if (answers.includeEstimator) {
    all.push({
      title: "Quotes in minutes, not days",
      body: "Customers price their own ${TRADE.job} on your website in about a minute, from your price book. You check it and send the quote with one click.",
      screenshot: "estimate",
    });
  }
  if (answers.includeScheduling) {
    all.push({
      title: "A full calendar without the phone tag",
      body: "Customers pick a time that suits your crews. Requests wait for your yes, reminders go out on their own, and each crew sees its own day.",
      screenshot: "schedule",
    });
  }
  if (answers.includeInvoicing) {
    all.push({
      title: "Paid faster",
      body: "Turn an accepted quote into an invoice, send the link, and customers pay by card. What's owed and what's overdue are on your dashboard every morning.",
      screenshot: "invoice",
    });
  }
  if (answers.includeBooking) {
    all.push({
      title: "Calls booked straight into your calendar",
      body: "People pick a time to talk on your own booking page. It lands on your calendar with what they want, and nobody plays email tennis.",
    });
  }
  if (answers.includeCustomers) {
    all.push({
      title: "Every customer's history in one place",
      body: "Each customer's quotes, visits, invoices and messages on one page, so whoever picks up the phone knows the whole story.",
    });
  }
  if (answers.includeStore) {
    all.push({
      title: "Sell online, too",
      body: "Put products on your own store page. Customers pay by card, and every order lands with what they bought and where to send it.",
    });
  }
  // Every project has these, so three outcomes always exist.
  all.push(
    {
      title: "Your whole team, the right access",
      body: "Invite the office and the crew. Each person sees what their job needs, and nothing they shouldn't, on a phone or a laptop.",
    },
    {
      title: "Your business at a glance",
      body: "Today's work, new leads and the money coming in, on one screen, the moment you sign in.",
    },
  );
  return all.slice(0, 3);
}

function heroTitle(answers: Answers): string {
  const verbs = [
    answers.includeEstimator ? "Quote it" : null,
    answers.includeScheduling ? "book it" : answers.includeBooking ? "book the call" : null,
    answers.includeInvoicing ? "get paid" : null,
  ].filter((verb): verb is string => verb !== null);
  if (verbs.length < 2) return "Run the business, not the paperwork.";
  const sentence = verbs.join(", ");
  return `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}. Without the paperwork.`;
}

function heroList(answers: Answers): string {
  const parts = [
    answers.includeEstimator ? "instant estimates on your website" : null,
    answers.includeScheduling ? "a schedule your crews can see" : null,
    answers.includeInvoicing ? "invoices customers pay by card" : null,
    answers.includeBooking ? "calls booked into your calendar" : null,
    answers.includeCustomers ? "every customer's history" : null,
  ].filter((part): part is string => part !== null);
  if (parts.length === 0) return "your team, your customers and your paperwork, in one place";
  if (parts.length === 1) return parts[0]!;
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

function stepsFor(answers: Answers): readonly { readonly title: string; readonly body: string }[] {
  const companies = companiesMode(answers);
  const second = answers.includeEstimator
    ? { title: "Add your prices", body: "Start from a sample price book for your trade and make every price yours: your supplies, your labor, your markup." }
    : answers.includeScheduling
      ? { title: "Set your crews and hours", body: "Add your crews, the hours they work and the services customers can book." }
      : { title: "Invite your team", body: "Add the people who work with you. Each gets the access their job needs." };
  const third = companies
    ? {
        title: "Share your page",
        body: "Put your page on your website, your truck and your Google listing. Requests start arriving, and you answer them from here.",
      }
    : { title: "Start working", body: "Everything is in one place from the first day: nothing to install, nothing to migrate." };
  return [
    { title: "Create your account", body: "Sign up and name your business. It takes a couple of minutes, and there's nothing to install." },
    second,
    third,
  ];
}

function faqFor(answers: Answers): readonly { readonly q: string; readonly a: string; readonly link?: { readonly href: string; readonly label: string } }[] {
  const sells = answers.businessModel !== "none";
  const out: { q: string; a: string; link?: { href: string; label: string } }[] = [
    {
      q: "How long does it take to get started?",
      a: answers.includeEstimator
        ? "An afternoon. Create your account, load your prices and hours, and share your page. There's nothing to install."
        : "An afternoon. Create your account, invite your team, and you're working. There's nothing to install.",
    },
    {
      q: "Do my customers need an account?",
      a: "No. Your page, your quotes and your invoices reach them as a link, and they can answer or pay without signing up.",
    },
  ];
  if (answers.includeScheduling) {
    out.push({
      q: "Can my crew use it on their phones?",
      a: "Yes. Each crew member signs in and sees their own day: where to go, in order, and what the job is.",
    });
  }
  if (sells) {
    out.push({
      q: "What does it cost?",
      a: consumerProduct(answers)
        ? "There's a free account, and plans for more. Each plan lists exactly what it includes, and you can change or cancel whenever you like."
        : "One monthly price for your business, with everything included. You can change plans whenever you like.",
      link: { href: "/pricing", label: "See the plans" },
    });
  }
  out.push({
    q: "Who can see our information?",
    a: "Only the people you invite, each with the access you give them, and the companies that run the service underneath it.",
    link: { href: "/privacy", label: "Our privacy policy" },
  });
  return out;
}

export function renderMarketingCopy(answers: Answers): string {
  const companies = companiesMode(answers);
  const noun = tenantLabel(answers).toLowerCase();
  const dashboard = companies ? "/dashboard" : answers.businessModel !== "none" ? "/account" : answers.adminShell !== "none" ? "/admin" : "/";
  const outcomes = outcomesFor(answers);
  const screenshots = [
    `  /** Under the hero: the dashboard, or the screen your customers love most. */\n  hero: { file: "dashboard.png", alt: "The dashboard: today's visits, new leads and the money coming in" },`,
    ...(answers.includeEstimator ? [`  estimate: { file: "estimate.png", alt: "A customer pricing their own job on the estimate page" },`] : []),
    ...(answers.includeScheduling ? [`  schedule: { file: "schedule.png", alt: "The week's schedule, every crew on one calendar" },`] : []),
    ...(answers.includeInvoicing ? [`  invoice: { file: "invoice.png", alt: "An invoice with a Pay now button" },`] : []),
  ];
  const outcomeLines = outcomes
    .map(
      (one) =>
        `  {\n    title: ${JSON.stringify(one.title)},\n    body: \`${one.body}\`,${one.screenshot ? `\n    screenshot: ${JSON.stringify(one.screenshot)},` : ""}\n  },`,
    )
    .join("\n");
  const steps = stepsFor(answers)
    .map((one) => `  { title: ${JSON.stringify(one.title)}, body: ${JSON.stringify(one.body)} },`)
    .join("\n");
  const faq = faqFor(answers)
    .map(
      (one) =>
        `  {\n    q: ${JSON.stringify(one.q)},\n    a: ${JSON.stringify(one.a)},${one.link ? `\n    link: { href: ${JSON.stringify(one.link.href)}, label: ${JSON.stringify(one.link.label)} },` : ""}\n  },`,
    )
    .join("\n");
  return `import { SITE_NAME } from "@/seo";

/**
 * THE LANDING PAGE'S WORDS — the one file to edit so this site speaks your
 * trade. Every section on / reads from here (src/components/marketing/*), so
 * a ramp installer's site and a cleaning company's site differ by this file
 * alone. Change TRADE first: most sentences below are built from it.
 *
 * Generated for what this project installed: the outcomes and steps name only
 * features it has, and SCREENSHOTS offers a slot for each.
 */

/** Who this is for, and the words that trade uses. */
export const TRADE = {
  /** Plural, as a headline says it: "service businesses", "ramp and lift installers". */
  customers: "service businesses",
  /** One piece of work, as a customer says it: "job", "install", "clean". */
  job: "job",
  /** The people in the field: "crews", "technicians", "cleaners". */
  crew: "crews",
} as const;

export const HERO = {
  eyebrow: \`For \${TRADE.customers}\`,
  title: ${JSON.stringify(heroTitle(answers))},
  lead: \`\${SITE_NAME} runs the office side of your business: ${heroList(answers)}. On your phone or your laptop, for you and your \${TRADE.crew}.\`,
  /** The hero's button for someone signed out. */
  cta: "Get started",
  /** …and the quieter one beside it. */
  secondary: "See how it works",
};

/** Three things it does for an owner — outcomes, not features. */
export const OUTCOMES: readonly { readonly title: string; readonly body: string; readonly screenshot?: keyof typeof SCREENSHOTS }[] = [
${outcomeLines}
];

/** How it works, in three steps. */
export const STEPS: readonly { readonly title: string; readonly body: string }[] = [
${steps}
];

/** Questions an owner asks before signing up. Answer them in your own words. */
export const FAQ: readonly { readonly q: string; readonly a: string; readonly link?: { readonly href: string; readonly label: string } }[] = [
${faq}
];

export const CLOSING = {
  title: \`Try it with your own \${TRADE.job}s.\`,
  body: "Set up your business in an afternoon and see the first request come in. Nothing to install, and nothing to undo if it isn't for you.",
};

/**
 * Product screenshots, shown ONLY when the file exists in public/screenshots/
 * (a missing one leaves no gap and no broken image). Take them from your own
 * demo ${noun} at 1280px wide, light mode, and save them under these names.
 */
export const SCREENSHOTS = {
${screenshots.join("\n")}
} as const;

/** Where "Go to your dashboard" goes for someone already signed in. */
export const DASHBOARD_HREF = ${JSON.stringify(dashboard)};
${pricingCopy(answers)}`;
}

/**
 * The pricing page's words, and the plans section on the landing page
 * (create-app 0.39): every sentence on /pricing that isn't a plan. A person
 * buying for themselves (--audience consumers) reads about their own account,
 * never "the size of your business".
 */
function pricingCopy(answers: Answers): string {
  if (answers.businessModel === "none" || !answers.includeMarketing) return "";
  const personal = consumerProduct(answers);
  const copy = personal
    ? {
        title: "Start free. Upgrade when you want more.",
        intro: "Each plan lists exactly what it includes. Change it or cancel whenever you like.",
        description: "What each plan includes and what it costs, starting with a free account.",
        teaserTitle: "Plans",
        teaserBody: "Start with a free account, and upgrade when you want more.",
        faq: [
          { q: "Can I cancel any time?", a: "Yes, from your account. You keep everything until the end of the period you've paid for, and nothing more is charged." },
          { q: "Can I change plans later?", a: "Yes, up or down, whenever you like. Moving up is charged for the rest of the period, today." },
          { q: "Do I need a card for the free account?", a: "No. Sign up with your email and use it for as long as you like." },
        ],
      }
    : {
        title: "One price. Everything included.",
        intro: "Every plan has every feature. Pick the one that fits the size of your business, and change it whenever you like.",
        description: "What each plan includes and what it costs. Every plan includes everything; they differ in how much.",
        teaserTitle: "One price, everything included",
        teaserBody: "Pick the plan that fits the size of your business. Change it whenever you like.",
        faq: [
          { q: "Can I change plan later?", a: "Yes, up or down, whenever you like. What you've already used this month stays counted on the new plan." },
          { q: "What happens when I reach a limit?", a: "You're told which one and what your plan allows. Nothing is deleted and nothing extra is charged." },
        ],
      };
  const faq = copy.faq.map((item) => `    { q: ${JSON.stringify(item.q)}, a: ${JSON.stringify(item.a)} },`).join("\n");
  return `
/** The pricing page's words (and the plans section on this page). The plans themselves are src/plans.ts. */
export const PRICING = {
  eyebrow: "Pricing",
  title: ${JSON.stringify(copy.title)},
  intro: ${JSON.stringify(copy.intro)},
  /** The page's search description. */
  description: ${JSON.stringify(copy.description)},
  /** The plans section on the landing page. */
  teaserTitle: ${JSON.stringify(copy.teaserTitle)},
  teaserBody: ${JSON.stringify(copy.teaserBody)},
  /** Questions about plans and billing, under the plans. Answer them in your own words. */
  faq: [
${faq}
  ] as readonly { readonly q: string; readonly a: string }[],
};
`;
}

/**
 * The plans teaser on the landing page: the plan names, each one-line
 * promise, and the lowest monthly price — read from src/plans.ts — or nothing
 * in a project with no pricing page.
 */
export function renderPlansTeaser(answers: Answers): string {
  const pricing = answers.includeMarketing && answers.businessModel !== "none";
  if (!pricing) {
    return `/**
 * The plans teaser. Nothing in this project: it has no pricing page to send
 * anyone to. (A project that sells plans shows each plan's name, its one-line
 * promise and its lowest price here, read from src/plans.ts.)
 */
export function PlansTeaser() {
  return null;
}
`;
  }
  return `import Link from "next/link";
import { defaultPlanInterval, planColumns } from "${answers.scope}/billing";
import { buttonClass } from "@/components/ui";
import { PlanCard, PlanCardCell, PlanCards } from "@/components/plans/PlanCard";
import { Section, SectionHeading } from "@/components/marketing/Section";
import { PRICING } from "@/marketing-copy";
import { DEFAULT_CURRENCY, HEADLINE_FEATURES, plans } from "@/plans";

/**
 * The plans, on the landing page: the same \`PlanCard\`s as /pricing and the
 * plan chooser (create-app 0.39), drawn from \`planColumns\` — every word and
 * number read from src/plans.ts, so this can't disagree with the pricing page.
 * The first product line's, yearly first; the buttons all lead to /pricing.
 */
export function PlansTeaser() {
  const columns = planColumns(plans, { interval: defaultPlanInterval(plans), currency: DEFAULT_CURRENCY, headline: HEADLINE_FEATURES });
  if (columns.length === 0) return null;
  return (
    <Section id="plans" label="Plans">
      <SectionHeading title={PRICING.teaserTitle}>{PRICING.teaserBody}</SectionHeading>
      <PlanCards>
        {columns.map((column) => (
          <PlanCardCell key={column.key}>
            <PlanCard column={column} detail={false} />
          </PlanCardCell>
        ))}
      </PlanCards>
      <div className="mt-6">
        <Link href="/pricing" className={buttonClass("secondary")}>
          Compare the plans
        </Link>
      </div>
    </Section>
  );
}
`;
}
