import type { ReactNode } from "react";

/**
 * A __TENANT_LABEL_LOWER__'s public pages — /t/{web address} and everything under it —
 * belong to the __TENANT_LABEL_LOWER__, not to this site (Tenancy 2a review T2A-BO-01).
 *
 * A ROUTE GROUP OF ITS OWN, outside `(site)`, so none of this site's chrome
 * reaches them: no site wordmark, no "Sign in" or menu, no footer inviting a
 * customer to make an account here, no link to this site's home page. Green
 * Acres' customer opening Green Acres' estimate or invoice link sees Green
 * Acres' bar (<CompanyBrandBar>, drawn by each page's <PublicCompanyGate>) and
 * the page — the same thing on a phone in a text message as on Green Acres'
 * own website. The tab title and link preview are the __TENANT_LABEL_LOWER__'s too
 * (`publicCompanyMetadata`).
 *
 * The root layout still wraps it (the html, the body, the theme), and the
 * group changes no URL.
 */
export default function CompanyPublicLayout({ children }: { readonly children: ReactNode }) {
  return <div className="min-h-dvh">{children}</div>;
}
