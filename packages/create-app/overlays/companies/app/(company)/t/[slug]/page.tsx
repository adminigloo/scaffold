import type { Metadata } from "next";
import Link from "next/link";
import { PublicCompanyGate, publicCompanyMetadata } from "@/components/PublicCompanyGate";
import { PUBLIC_COMPANY_PAGES } from "@/tenancy";

/**
 * A __TENANT_LABEL_LOWER__'s public home, /t/{web-address} (Tenancy 2a): its
 * name, logo and colour, how to reach it, and a button for each public page
 * this site gives every __TENANT_LABEL_LOWER__ — "Get an instant estimate",
 * "Book a visit" — from the generated PUBLIC_COMPANY_PAGES list in
 * src/tenancy.ts (a feature this project doesn't have contributes no button).
 *
 * <PublicCompanyGate> does the rest: an unknown address is "not found", an
 * OLD address (the business renamed itself) redirects permanently to the
 * current one so printed links keep working, and a SUSPENDED
 * __TENANT_LABEL_LOWER__'s page says plainly it isn't taking requests online
 * right now, with how to reach it, and no buttons.
 *
 * Kept out of search (robots.txt disallows /t/ too) — unless the project was
 * made with --seo (Tenancy 2b-4a): then it is listed while the
 * __TENANT_LABEL_LOWER__ is taking requests, with its own canonical address and
 * the business's details, and only its token pages stay out.
 */
export const dynamic = "force-dynamic";

/**
 * The tab title and link preview are the __TENANT_LABEL_LOWER__'s: "{name}" (review
 * T2A-BO-01), never this site's name; `path` is its canonical address (--seo).
 */
export async function generateMetadata({ params }: { readonly params: Promise<{ readonly slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  return publicCompanyMetadata(slug, null, { path: "" });
}

export default async function CompanyPublicPage({
  params,
}: {
  readonly params: Promise<{ readonly slug: string }>;
}) {
  const { slug } = await params;
  return (
    <PublicCompanyGate slug={slug} path="">
      {(company) => (
        <nav aria-label={company.name} className="flex flex-col gap-3 sm:flex-row">
          {PUBLIC_COMPANY_PAGES.map((page) => (
            <Link
              key={page.path}
              href={`${company.publicPath}${page.path}`}
              className="flex min-h-11 items-center justify-center rounded-[6px] border border-line bg-surface px-5 py-3 text-sm font-medium text-ink no-underline hover:bg-canvas"
            >
              {page.label}
            </Link>
          ))}
        </nav>
      )}
    </PublicCompanyGate>
  );
}
