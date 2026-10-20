import type { Metadata } from "next";
import { CompanyHomeView } from "@/components/CompanyHome";
import { PublicCompanyGate, publicCompanyMetadata } from "@/components/PublicCompanyGate";
import { companyHome } from "@/server/company-home";

/**
 * A company's public home, /t/{web-address} (create-app 0.36, the mini
 * website): the page the business's OWN customers land on, so it reads as the
 * business's website, not as a list of buttons.
 *
 *   - Header: its logo and name, its phone, and the one big action.
 *   - Hero: its name, its one-line tagline, where it works, and "Get an
 *     instant estimate" (or "Book a visit" / "Book a call" — whichever this
 *     project's first customer-facing page is, src/server/company-home.ts).
 *   - Services: the price book's products marked "Show on your website",
 *     each "from $X" — priced by the estimate page's own pricing for the
 *     smallest job, never a number typed here.
 *   - Booking and Shop: every other public page this project gives a company
 *     (PUBLIC_COMPANY_PAGES, generated: a feature this project doesn't have
 *     contributes no card), each with one line saying what it's for.
 *   - Contact: phone, email, address and hours, from company settings.
 *   - Feedback: a small link in the footer, never a headline button.
 *
 * Drawn by <CompanyHomeView> (src/components/CompanyHome.tsx). Its colour is
 * the company's (brand colour on the big button). Everything it
 * shows comes from the company's settings ("Your public page", "Business
 * details") and price book, so it changes the moment the owner changes them.
 *
 * <PublicCompanyGate> does the rest: an unknown address is "not found", an
 * OLD address (the business renamed itself) redirects permanently to the
 * current one so printed links keep working, a SUSPENDED company's page says
 * plainly it isn't taking requests online right now, and — with --seo — the
 * page carries the business's LocalBusiness details for search and AI.
 */
export const dynamic = "force-dynamic";

/** The company's name and tagline in the tab and the link preview — never this site's. */
export async function generateMetadata({ params }: { readonly params: Promise<{ readonly slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const home = await companyHome(slug);
  return publicCompanyMetadata(slug, null, { path: "", ...(home?.tagline ? { description: home.tagline } : {}) });
}

export default async function CompanyPublicPage({
  params,
}: {
  readonly params: Promise<{ readonly slug: string }>;
}) {
  const { slug } = await params;
  return (
    <PublicCompanyGate slug={slug} path="" layout="home">
      {async (company) => <CompanyHomeView company={company} home={await companyHome(slug)} />}
    </PublicCompanyGate>
  );
}
