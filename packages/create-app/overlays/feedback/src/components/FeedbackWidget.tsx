import type { ReactNode } from "react";
import { env } from "@/env";
import { SiteFeedback } from "./SiteFeedback";

/**
 * This app consuming the feedback widget, wired the way any buyer wires it:
 * install the package, wrap the tree, pass the website key.
 *
 * MOUNTED ONLY WHEN A KEY EXISTS — a runtime configuration check, not a
 * feature flag, the same distinction the AuthProvider in `app/layout.tsx`
 * draws. A key cannot exist before the database it is issued against, so a
 * freshly generated project boots with the widget dark, /setup says which
 * variable turns it on, and `pnpm feedback:issue-key` produces the value.
 *
 * A SERVER component deliberately, though everything it renders is client
 * code: the key is read here, through the one module allowed to touch the
 * environment, and handed to the provider as a prop. The provider sends it
 * with every intake request, so it is client-visible by design — it is a
 * revocable website key, not a secret.
 *
 * WHOSE BOARD: this button is THIS SITE'S OWN — its key is issued for the
 * site's own board (`pnpm feedback:issue-key`), so what people report from
 * this site's pages lands at /admin/feedback for the site's staff. It is not
 * shown on a company's public pages (/t/…): there the company's customers
 * write to the company, on its own feedback page (<SiteFeedback>).
 */
export function FeedbackWidget({ children }: { children: ReactNode }) {
  const clientKey = env.ADMINIGLOO_FEEDBACK_KEY;
  if (!clientKey) return <>{children}</>;
  return <SiteFeedback clientKey={clientKey}>{children}</SiteFeedback>;
}
