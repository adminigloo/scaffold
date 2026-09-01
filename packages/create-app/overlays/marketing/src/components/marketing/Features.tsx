import { Section, SectionHeading } from "@/components/marketing/Section";

/**
 * What the product does, as six claims.
 *
 * THE COPY IS DELIBERATELY LIMITED TO THINGS EVERY GENERATED PROJECT ACTUALLY
 * DOES. Members and invitations, permissions checked on the server, an audit
 * trail, recorded errors, a database you own, sign-in without another password
 * — all six are in the base package set, so an unedited landing page advertises
 * nothing this project cannot do. It would have been easy to write a seventh
 * about billing, and it would have been a lie on every project generated with
 * `--model none`. That is the same failure a hand-written pricing page makes,
 * one level up the funnel, and it is why the pricing page reads the plan record
 * rather than prose.
 *
 * Rewrite all of it. These are the client's claims to make, not ours.
 *
 * NO ICONS. There is no icon set in this project and there is not going to be
 * one for six list items; an emoji in place of one is the single clearest tell
 * of a page nobody art-directed. A hairline above each item does the grouping
 * that an icon would only decorate.
 */
const FEATURES: readonly { readonly title: string; readonly body: string }[] = [
  {
    title: "Everyone in one place",
    body:
      "Invite people by email, see who has accepted, and remove somebody the " +
      "moment they leave. Each __TENANT_LABEL_LOWER__ manages its own.",
  },
  {
    title: "Access you can explain",
    body:
      "What each person may do is decided in one place and checked on every " +
      "request — so “they could see it but not change it” is a fact about the " +
      "system rather than a hope about the interface.",
  },
  {
    title: "A record of what happened",
    body:
      "Every administrative change is written down as it happens: who, what " +
      "and when. It is the question nobody can answer afterwards, and the " +
      "answer has to be recorded before it is asked.",
  },
  {
    title: "Nothing quietly breaks",
    body:
      "Failures are captured with enough context to reproduce them, so a " +
      "problem reported once is a problem that can be found.",
  },
  {
    title: "Your data stays yours",
    body:
      "Everything lives in a Postgres database you can connect to, back up and " +
      "take elsewhere. No proprietary store and no export queue.",
  },
  {
    title: "Sign in without another password",
    body:
      "Email, a passkey, or the identity provider your __TENANT_LABEL_LOWER__ " +
      "already uses.",
  },
];

export function Features() {
  return (
    <Section id="what-you-get" label="What you get">
      <SectionHeading title="The parts every __TENANT_LABEL_LOWER__ ends up needing">
        Not a list of everything it does. These are the six that decide whether
        a tool survives its first month.
      </SectionHeading>

      <ul className="grid list-none grid-cols-1 gap-x-10 gap-y-7 p-0 sm:grid-cols-2">
        {FEATURES.map((feature) => (
          <li key={feature.title} className="border-t border-line pt-4">
            <h3 className="text-sm font-semibold tracking-tight text-ink">
              {feature.title}
            </h3>
            <p className="mt-1.5 max-w-[42ch] text-sm leading-relaxed text-ink-muted">
              {feature.body}
            </p>
          </li>
        ))}
      </ul>
    </Section>
  );
}
