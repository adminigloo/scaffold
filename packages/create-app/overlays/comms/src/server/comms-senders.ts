import { seedDefaultTemplates, type CommsSenders } from "__SCOPE__/comms";
import { db as sharedDb } from "@/db";

/**
 * The app's comms senders, injected into __SCOPE__/comms. A sender is a function
 * that actually delivers a message; the package owns the templates, the queue
 * and the log, and takes the delivery from here so the provider is the app's
 * choice, not the package's.
 *
 * SHIPPED WITH NO PROVIDER WIRED, on purpose (configuration-not-flags). With no
 * sender, comms records each due message as "skipped" rather than a fake "sent",
 * and nothing throws. Wire one and it turns on with no other change:
 *   • Email — generate with `--email`, then set `email` to a function that calls
 *     `createEmailSender({ apiKey: env.RESEND_API_KEY, from: env.EMAIL_FROM })`
 *     and throws when the provider does not report "sent" (so the log stays
 *     honest).
 *   • SMS — set `sms` to a Twilio (or other) sender the same way.
 */
export const COMMS_TENANT = "primary";

export const commsSenders: CommsSenders = {
  // email: wire a provider here — see the file header.
  // sms: wire a provider here — see the file header.
};

let templatesSeeded = false;
export async function ensureCommsTemplates(db = sharedDb): Promise<void> {
  if (templatesSeeded) return;
  await seedDefaultTemplates(db, COMMS_TENANT);
  templatesSeeded = true;
}
