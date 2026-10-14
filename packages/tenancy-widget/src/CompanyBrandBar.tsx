import type { CSSProperties, ReactNode } from "react";
import { brandColorReport, normaliseHexColor } from "./color.js";
import { initialsOf, WidgetRoot, type ChromeProps } from "./parts.js";
import type { PublicCompanyWire } from "./types.js";
import { PUBLIC_FACE } from "./words.js";

/**
 * <CompanyBrandBar> (Tenancy 2a, 5.2): the company's public face at the top
 * of its booking, estimate and invoice pages. Its logo (or initials in its
 * colour), its name linked to its public home, and how to reach it.
 *
 * HERE THE COLOUR IS THE POINT. On the company's own screens the brand colour
 * stays out of the way (T1 8.2); on a page its CUSTOMERS see, it's what tells
 * them they're in the right place. So the bar carries a 3 px rule in it, and
 * the initials badge is filled with it, in the text colour the server worked
 * out for it (`onBrandColor`: white or near-black, whichever reads).
 *
 * NOT A HEADING. The page owns its `h1` ("Book a visit"); the company's name
 * is a link, so a screen reader's heading list isn't led by it twice.
 *
 * Server-renderable: no state, no fetch, no effect beyond the stylesheet.
 */

export interface CompanyBrandBarProps extends ChromeProps {
  company: PublicCompanyWire;
  /** The company's public home; the name links there. Default company.publicPath; null = no link. */
  homeHref?: string | null;
  /** Show the contact line (email · phone). Default true. */
  showContact?: boolean;
}

/** "tel:" wants digits (and a leading +); "(555) 010-0100" → "tel:5550100100". Null when there are none. */
export function telHref(phone: string): string | null {
  const trimmed = phone.trim();
  const digits = trimmed.replace(/[^\d]/g, "");
  if (!digits) return null;
  return `tel:${trimmed.startsWith("+") ? "+" : ""}${digits}`;
}

/** The brand colour and the text colour on it, or null for none (or one that doesn't parse). */
export function brandPair(company: Pick<PublicCompanyWire, "brandColor" | "onBrandColor">): { color: string; on: string } | null {
  const color = company.brandColor ? normaliseHexColor(company.brandColor) : null;
  if (!color) return null;
  const on = company.onBrandColor ?? brandColorReport(color)?.textOnColor ?? "#111111";
  return { color, on };
}

/**
 * The contact links, shared by the brand bar (the bare address and number)
 * and the closed panel (`labelled`: "Email …", "Call …", since there they're
 * the only thing to do).
 */
export function contactLinks(
  company: Pick<PublicCompanyWire, "contactEmail" | "contactPhone">,
  options: { labelled?: boolean } = {},
): { key: string; node: ReactNode }[] {
  const out: { key: string; node: ReactNode }[] = [];
  if (company.contactEmail) {
    out.push({
      key: "email",
      node: (
        <a href={`mailto:${company.contactEmail}`} data-aitw-contact="email">
          {options.labelled ? PUBLIC_FACE.email(company.contactEmail) : company.contactEmail}
        </a>
      ),
    });
  }
  if (company.contactPhone) {
    const href = telHref(company.contactPhone);
    const text = options.labelled ? PUBLIC_FACE.call(company.contactPhone) : company.contactPhone;
    out.push({
      key: "phone",
      node: href ? (
        <a href={href} data-aitw-contact="phone">
          {text}
        </a>
      ) : (
        <span data-aitw-contact="phone">{text}</span>
      ),
    });
  }
  return out;
}

export function CompanyBrandBar(props: CompanyBrandBarProps) {
  const { company, showContact = true, theme, nonce, className, style } = props;
  const homeHref = props.homeHref === undefined ? company.publicPath : props.homeHref;
  const brand = brandPair(company);
  const contacts = showContact ? contactLinks(company) : [];
  // The colour reaches the stylesheet as two custom properties on this
  // element, so the CSS never carries a raw colour and a host can override it.
  const brandVars = brand ? ({ "--aitw-brand": brand.color, "--aitw-on-brand": brand.on } as CSSProperties) : undefined;
  const brandAttr = brand ? { "data-brand": "" } : {};

  return (
    <WidgetRoot theme={theme} nonce={nonce} className={className} style={style} data={{ "aitw-brand-bar": "" }}>
      <div className="aitw-brandbar" style={brandVars} {...brandAttr}>
        {company.logoUrl ? (
          // Decorative: the name is right beside it.
          <img className="aitw-brandbar-logo" src={company.logoUrl} alt="" height={40} />
        ) : (
          <span className="aitw-brandbar-initials" aria-hidden="true" {...brandAttr}>
            {initialsOf(company.name)}
          </span>
        )}
        <div className="aitw-brandbar-text">
          {homeHref ? (
            <a className="aitw-brandbar-name" href={homeHref}>
              {company.name}
            </a>
          ) : (
            <span className="aitw-brandbar-name">{company.name}</span>
          )}
          {contacts.length > 0 ? (
            <p className="aitw-contact" aria-label={PUBLIC_FACE.contactLabel(company.name)}>
              {contacts.map((c) => (
                <span key={c.key}>{c.node}</span>
              ))}
            </p>
          ) : null}
        </div>
      </div>
    </WidgetRoot>
  );
}
