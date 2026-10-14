import { useId } from "react";
import { contactLinks } from "./CompanyBrandBar.js";
import { WidgetRoot, type ChromeProps } from "./parts.js";
import type { PublicCompanyWire } from "./types.js";
import { PUBLIC_FACE } from "./words.js";

/**
 * <CompanyUnavailable> (Tenancy 2a, 5.3): what a CUSTOMER sees on a company's
 * public page (booking, an estimate, an invoice) while the company is
 * suspended. It isn't taking requests online; here's how to reach them.
 *
 * NOTHING ABOUT WHY, and no other actions: a customer of a suspended company
 * is owed a way to reach the business, not its account status. (The
 * company's own people see <CompanySuspended>, which says more.)
 *
 * Server-renderable: no state, no fetch.
 */

export interface CompanyUnavailableProps extends ChromeProps {
  company: PublicCompanyWire;
}

export function CompanyUnavailable(props: CompanyUnavailableProps) {
  const { company, theme, nonce, className, style } = props;
  const headingId = useId();
  const contacts = contactLinks(company, { labelled: true });
  return (
    <WidgetRoot theme={theme} nonce={nonce} className={className} style={style} data={{ "aitw-unavailable": "" }}>
      <section className="aitw-panel aitw-centre" aria-labelledby={headingId}>
        <h1 className="aitw-title" id={headingId}>
          {PUBLIC_FACE.unavailableHeading(company.name)}
        </h1>
        <p>{PUBLIC_FACE.unavailableBody}</p>
        {contacts.length > 0 ? (
          <ul className="aitw-contact-list" aria-label={PUBLIC_FACE.contactLabel(company.name)}>
            {contacts.map((c) => (
              <li key={c.key}>{c.node}</li>
            ))}
          </ul>
        ) : null}
      </section>
    </WidgetRoot>
  );
}
