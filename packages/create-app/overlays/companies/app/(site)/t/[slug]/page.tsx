import type { Metadata } from "next";
import { notFound, permanentRedirect } from "next/navigation";
import { tenancy } from "@/server/tenancy";
import { PUBLIC_COMPANY_PREFIX } from "@/tenancy";

/**
 * A __TENANT_LABEL_LOWER__'s reserved public address, /t/{web-address}
 * (Tenancy 1).
 *
 * RESERVED NOW, USED IN TENANCY 2: today it shows a small card — logo, name,
 * and how to reach them — so the address a business picked in onboarding goes
 * somewhere. Its real public pages (booking, estimates) arrive with Tenancy 2.
 * Not indexed until then.
 *
 * An OLD address (the business renamed itself) redirects permanently to the
 * current one, so links already printed keep working. A suspended
 * __TENANT_LABEL_LOWER__ has no public face: its address answers "not found".
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = { robots: { index: false } };

export default async function CompanyPublicPage({
  params,
}: {
  readonly params: Promise<{ readonly slug: string }>;
}) {
  const { slug } = await params;
  const found = await tenancy.resolveCompanyBySlug(slug);
  if (!found) notFound();
  if (found.retiredSlug !== null) permanentRedirect(`${PUBLIC_COMPANY_PREFIX}${found.company.slug}`);

  const company = found.company;
  return (
    <main className="mx-auto flex max-w-md flex-col items-center gap-4 px-6 py-16 text-center">
      {company.logoUrl ? (
        // A plain <img>: the logo lives in the project's blob store, whose
        // host next.config doesn't list for the image optimiser.
        // eslint-disable-next-line @next/next/no-img-element
        <img src={company.logoUrl} alt="" className="h-16 w-auto max-w-[200px] object-contain" />
      ) : null}
      <h1 className="text-2xl font-semibold tracking-tight text-ink">{company.name}</h1>
      {company.contactEmail || company.contactPhone ? (
        <p className="text-sm text-ink-muted">
          {company.contactEmail ? (
            <a href={`mailto:${company.contactEmail}`} className="text-accent underline underline-offset-2">
              {company.contactEmail}
            </a>
          ) : null}
          {company.contactEmail && company.contactPhone ? " · " : null}
          {company.contactPhone ? (
            <a href={`tel:${company.contactPhone}`} className="text-accent underline underline-offset-2">
              {company.contactPhone}
            </a>
          ) : null}
        </p>
      ) : null}
    </main>
  );
}
