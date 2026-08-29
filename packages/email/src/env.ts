import { z } from "zod";
import { prefixedSecret } from "@adminigloo/env";
import { parseSenderAddress } from "./sender.js";

/**
 * This package's contribution to the environment contract.
 *
 * `RESEND_API_KEY` is OPTIONAL, and that is the load-bearing decision. A
 * deployment with no key still boots, and every send it makes is recorded as
 * `skipped` — see the note on `EmailStatus`. Making it required means a preview
 * branch, a fresh clone, and a self-hosted install that does not send mail all
 * fail at boot on a credential they do not need.
 */
export function emailServer() {
  return {
    RESEND_API_KEY: prefixedSecret("re_").optional(),

    /**
     * The `From:` header, validated by the parser rather than by `z.email()`.
     *
     * NOT `z.email()`. It accepts only a bare addr-spec, so the moment somebody
     * improves deliverability by setting a display name — the form every
     * provider recommends — the app stops booting, and the message is "Invalid
     * email", which points at a value that is in fact correct. That is a real
     * outage riddler-go shipped, triggered by its own fallback string.
     */
    EMAIL_FROM: z.string().refine((value) => parseSenderAddress(value) !== null, {
      message:
        'must be an email address, either bare ("hello@example.com") or with a ' +
        'display name ("Riddler Go <hello@example.com>"). Quote a display name ' +
        "containing a comma or a colon, since an unquoted one makes the header " +
        "parse as two addresses.",
    }),

    /**
     * Where replies go, when that is not the sending address. Optional, and
     * validated by the same parser so a display name is legal here too.
     */
    EMAIL_REPLY_TO: z
      .string()
      .refine((value) => parseSenderAddress(value) !== null, {
        message:
          'must be an email address, bare or with a display name ("Support ' +
          '<help@example.com>"). Leave it unset to have replies go to EMAIL_FROM.',
      })
      .optional(),

    /**
     * Signs the delivery webhook. Optional in the schema, mandatory at the
     * route: `verifyDeliveryWebhook` refuses to process anything without it,
     * because an unsigned payload is just JSON from a stranger.
     */
    RESEND_WEBHOOK_SECRET: prefixedSecret("whsec_").optional(),
  };
}

/**
 * The variables that only make sense set together.
 *
 * Half-configured is the state that produces silent damage. A key with no
 * webhook secret sends mail and can never learn that any of it bounced, so
 * dead addresses stay on the list and the sending domain's reputation erodes
 * with nothing in the logs. A webhook secret with no key means a live route
 * accepting delivery notifications for mail this deployment cannot have sent.
 *
 * Not enforced by the schema, deliberately: neither is required, and a Zod
 * cross-field rule would have to guess which of the two the operator meant.
 * Exported instead so an app can assert it in the one place that knows whether
 * this deployment is supposed to send mail at all.
 *
 * `EMAIL_FROM` is absent because it is not conditional — it is required on
 * every deployment, since even a `skipped` row records who the mail would have
 * come from.
 */
export const EMAIL_ENV_GROUP = ["RESEND_API_KEY", "RESEND_WEBHOOK_SECRET"] as const;
