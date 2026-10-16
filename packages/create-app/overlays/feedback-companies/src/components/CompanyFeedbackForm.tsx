"use client";

import { FeedbackLauncher, FeedbackModal, FeedbackProvider } from "__SCOPE__/feedback-widget";

/**
 * A company's feedback form on its public page (Tenancy 2b-2a): the feedback
 * widget, configured for a page whose whole purpose is the form —
 *
 *   no website key     the web address in `baseUrl` names the company
 *   no screenshot      the customer is writing about the business, not about
 *                      this page, so the form opens straight onto the words
 *   name and email     asked (both optional), so the team's answer can come
 *                      by email in the company's name as well
 *   no shortcut        Ctrl+Shift+B belongs to the site's own button
 *
 * "Send feedback" and "My reports" sit in the page (<FeedbackLauncher>), not
 * in a corner. A company that isn't taking new feedback says so instead of
 * offering to send, and still opens "My reports".
 */
export function CompanyFeedbackForm({ baseUrl }: { readonly baseUrl: string }) {
  return (
    <FeedbackProvider config={{ baseUrl, screenshot: false, askContact: true, enableShortcut: false }}>
      <FeedbackLauncher />
      <FeedbackModal />
    </FeedbackProvider>
  );
}
