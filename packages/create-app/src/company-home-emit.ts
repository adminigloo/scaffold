import { tenantLabel, type Answers } from "./answers.js";
import { companiesMode } from "./tenancy-emit.js";

/**
 * src/server/company-home.ts — what a company's own public page shows
 * (create-app 0.36, the mini website at /t/{web address}): its tagline,
 * where it works and when, how to reach it, its services with "from $X", and
 * the one big thing to do.
 *
 * Generated, because two of those are questions about the installed
 * features: the services come from the estimator's price book (products
 * marked "Show on your website", each priced by the estimate page's own
 * `startingPrices`), and the big button is "Get an instant estimate" with the
 * estimator, else "Book a visit" with scheduling, else "Book a call". The page
 * itself (app/(company)/t/[slug]/page.tsx) is the same in every project.
 */
export function renderCompanyHome(answers: Answers): string {
  const scope = answers.scope;
  const noun = tenantLabel(answers).toLowerCase();
  const estimator = answers.includeEstimator;
  const primary = answers.includeEstimator
    ? `{ path: "/estimate", label: "Get an instant estimate", hint: "Answer a few questions and see your price in about a minute." }`
    : answers.includeScheduling
      ? `{ path: "/book-visit", label: "Book a visit", hint: "Pick a time that suits you; we confirm it by email." }`
      : answers.includeBooking
        ? `{ path: "/book", label: "Book a call", hint: "Pick a time to talk it through." }`
        : "null";
  const imports = [
    `import { cache } from "react";`,
    estimator ? `import { resolveEstimatorSettings, startingPrices } from "${scope}/estimator";` : null,
    estimator ? `import { db } from "@/db";` : null,
    `import { findPublicCompany } from "@/components/PublicCompanyGate";`,
    estimator ? `import { estimatorCompany } from "@/server/estimator";` : null,
    `import { tenancy } from "@/server/tenancy";`,
    `import { publicLine } from "@/server/tenant-settings";`,
  ].filter((line): line is string => line !== null);
  const services = estimator
    ? `  // The price book's website products, each "from" its smallest job's price.
  let services: readonly CompanyService[] = [];
  try {
    const settings = await resolveEstimatorSettings(db, tenantId, { company: estimatorCompany });
    services = (await startingPrices(db, tenantId, { settings, limit: 9 })).map((one) => ({
      name: one.name,
      description: one.description,
      from: one.from,
    }));
  } catch {
    services = [];
  }`
    : `  // This project has no price book, so the page lists no services.
  const services: readonly CompanyService[] = [];`;
  return `${imports.join("\n")}

/** One service on the ${noun}'s page. */
export interface CompanyService {
  readonly name: string;
  readonly description: string | null;
  /** "$1,450" — the least it costs, by the estimate page's own pricing; null: priced by quote. */
  readonly from: string | null;
}

/** Everything the ${noun}'s home page shows, from its settings and price book. */
export interface CompanyHome {
  readonly tagline: string | null;
  readonly serviceArea: string | null;
  /** When it's open, one line each, as the owner wrote them. */
  readonly hours: readonly string[];
  readonly phone: string | null;
  readonly email: string | null;
  /** The street address on one line, or null. */
  readonly address: string | null;
  readonly services: readonly CompanyService[];
  /** The page's one big button, or null when this project has no customer-facing page to send people to. */
  readonly primary: { readonly path: string; readonly label: string; readonly hint: string } | null;
}

/**
 * The ${noun}'s home, by web address — once per render (React's \`cache\`).
 * Null for an unknown address (the gate has already said "not found").
 */
export const companyHome = cache(async (slug: string): Promise<CompanyHome | null> => {
  const found = await findPublicCompany(slug);
  if (!found) return null;
  const tenantId = found.company.id;
  const profile = await tenancy.companyProfile(tenantId);
  if (!profile) return null;
${services}
  // "1450 Industrial Way, Unit 4, Denver, CO 80216" — the ZIP beside the state, as an envelope has it.
  const place = [[profile.address.city, profile.address.region].filter(Boolean).join(", "), profile.address.postalCode].filter(Boolean).join(" ");
  const address = [profile.address.line1, profile.address.line2, place]
    .filter((part): part is string => Boolean(part && part.trim()))
    .join(", ");
  return {
    tagline: publicLine(profile.settings, "tagline"),
    serviceArea: publicLine(profile.settings, "serviceArea"),
    hours: (publicLine(profile.settings, "hours") ?? "")
      .split(/\\r?\\n/)
      .map((line) => line.trim())
      .filter(Boolean),
    phone: profile.contactPhone,
    email: profile.contactEmail,
    address: address || null,
    services,
    primary: ${primary},
  };
});
`;
}

/** Only companies have a public page of their own. */
export function hasCompanyHome(answers: Answers): boolean {
  return companiesMode(answers);
}
