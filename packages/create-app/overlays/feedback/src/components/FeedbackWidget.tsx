import type { ReactNode } from "react";
import {
  FeedbackButton,
  FeedbackModal,
  FeedbackProvider,
} from "__SCOPE__/feedback-widget";
import { env } from "@/env";

/**
 * This app consuming the feedback widget, wired the way any buyer wires it:
 * install the package, wrap the tree, pass the licence key.
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
 * tenant-scoped, revocable licence key, not a secret.
 */
export function FeedbackWidget({ children }: { children: ReactNode }) {
  const clientKey = env.ADMINIGLOO_FEEDBACK_KEY;
  if (!clientKey) return <>{children}</>;
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
