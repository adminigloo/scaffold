"use client";

import type { ReactNode } from "react";
import { usePathname } from "next/navigation";
import { FeedbackButton, FeedbackModal, FeedbackProvider } from "__SCOPE__/feedback-widget";

/**
 * This site's own feedback button, on this site's own pages — and NOT on a
 * company's public pages (/t/{web address}/…, Tenancy 2b-2a review M5).
 *
 * Those pages are the company's, not this site's: its customers on them are
 * telling the company something, on the company's own feedback page. The
 * site's button there would send a company's customers' reports — with
 * screenshots of the company's pages — to this site's staff. So under /t the
 * button, its form, its Ctrl+Shift+B shortcut and its click recording are
 * all off (a check on the page's address, which is request data, not a
 * feature switch).
 */
export function SiteFeedback({ clientKey, children }: { readonly clientKey: string; readonly children: ReactNode }) {
  const pathname = usePathname() ?? "";
  const companyPage = pathname === "/t" || pathname.startsWith("/t/");
  if (companyPage) return <>{children}</>;
  return (
    // A relative baseUrl: this app mounts its own intake route, so the widget
    // posts back to the origin it is served from — previews, staging and
    // production included, with nothing to configure per environment.
    <FeedbackProvider config={{ baseUrl: "/api/igloo", clientKey }}>
      {children}
      <FeedbackButton />
      <FeedbackModal />
    </FeedbackProvider>
  );
}
