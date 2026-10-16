import type { Metadata } from "next";
import { CompanyFeedbackForm } from "@/components/CompanyFeedbackForm";
import { PublicCompanyGate, publicCompanyMetadata } from "@/components/PublicCompanyGate";

/**
 * The tab title and link preview are the __TENANT_LABEL_LOWER__'s: "Send feedback · {name}" (review
 * T2A-BO-01), never this site's name. Not indexed (D17).
 */
export async function generateMetadata({ params }: { readonly params: Promise<{ readonly slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  return publicCompanyMetadata(slug, "Send feedback");
}

export const dynamic = "force-dynamic";

/**
 * A company's feedback page (Tenancy 2b-2a): where its customers tell it
 * something — a problem, an idea, a question — and come back to read its
 * answer and reply, under "My reports" on the same device. The company's name,
 * logo and colour head it (the same gate every /t page uses); a suspended
 * company shows how to reach it instead.
 *
 * The form (the feedback widget, without the screenshot: a customer is
 * writing about the business, not about this page) posts to
 * /api/t/{web address}/feedback, and lands on the company's board at
 * /app/feedback. A company whose plan ended says it isn't taking new
 * feedback, and still shows its customers their own.
 */
export default async function CompanyFeedbackPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly slug: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { slug } = await params;
  const query = await searchParams;
  return (
    <PublicCompanyGate slug={slug} path="/feedback" query={query}>
      {(company) => (
        <section className="flex flex-col gap-4">
          <h1 className="text-2xl font-semibold text-ink">Tell {company.name} what you think</h1>
          <p className="text-ink-muted">
            A problem, an idea or a question — it goes straight to the team. If you leave your email, their answer comes to
            you there too; either way you can read it, and reply, under &ldquo;My reports&rdquo; on this device.
          </p>
          <CompanyFeedbackForm baseUrl={`/api/t/${company.slug}/feedback`} />
        </section>
      )}
    </PublicCompanyGate>
  );
}
