import { describeAppEnv } from "__SCOPE__/env";
import { env } from "@/env";
import { stripe } from "@/server/stripe";

/**
 * Which checkout is live on this deployment — decided once, here, and nowhere
 * else.
 *
 * *** THE PAGE AND THE PROCEDURE USED TO DISAGREE, IN THE DANGEROUS DIRECTION. ***
 *
 * `app/(site)/checkout/page.tsx` carried a comment promising that "the page and
 * the procedure cannot disagree about which checkout is live". They did. The
 * page branched on `!stripe` alone; the storefront notice branched on
 * `stripe === null` alone; the button branched on nothing at all; and only the
 * procedure also asked what environment it was on. So a deployment with a real
 * catalogue and no Stripe key rendered "payments are not configured, so buying
 * is simulated" to every visitor, drew a Simulate button, and then had the
 * server refuse the click — or, when the environment check itself was wrong,
 * did not refuse it and gave the goods away. Four copies of one rule that
 * agreed on the day they were written.
 *
 * This is the one predicate. The page reads it, the storefront notice reads it,
 * the procedure reads it, and the button is handed its result rather than
 * deriving a fifth opinion in the browser.
 *
 * WHY IT IS STATED POSITIVELY. The old server-side condition was
 * `!stripe && appEnv !== "production"` — a NEGATIVE gate, which grants a
 * dangerous capability unless it can prove it should not. Every negative gate
 * has the same failure mode: something the author did not enumerate arrives,
 * matches none of the exclusions, and is therefore allowed. That is exactly
 * what happened. `resolveAppEnv()` read `VERCEL_ENV` and nothing else, a
 * self-hosted production shop was not `"production"` by that reading, the
 * exclusion did not fire, and a £29 product was minted as a licence key for
 * free on a real host.
 *
 * So the rule is inverted. `simulated` is granted by two named cases and by
 * nothing else:
 *
 *   LOCAL. `describeAppEnv()` positively identified a development server, a
 *   test run, or an operator who wrote `APP_ENV=local`. Note that this is now
 *   an affirmative identification rather than a fall-through default — before
 *   the environment fix, "local" was what an unrecognised host resolved to,
 *   which is to say it was proof of nothing. It is the zero-configuration case
 *   and it needs no opt-in, because that is the entire promise: a shop you can
 *   buy from twenty minutes after generating it, with no Stripe account.
 *
 *   STAGING WITH AN EXPLICIT OPT-IN. `ALLOW_SIMULATED_CHECKOUT=true`. A preview
 *   deployment is where this gets demonstrated to somebody, and that is a real
 *   need — but "somebody is going to demo this" is a fact only a person knows,
 *   so a person has to say it. One variable in the Preview scope, and it is the
 *   sentence in the deployment's own configuration that authorises handing out
 *   paid goods.
 *
 * Everything else falls through to `unavailable`, and that is the point: an
 * environment nobody labelled resolves to `staging` without the opt-in and
 * therefore lands on the safe side without anybody having to have thought of
 * it. A future `AppEnv` value would too.
 *
 * WHAT `unavailable` MEANS ON SCREEN. Not a broken page and not a silent
 * fallback — a deployment that cannot take money and is not permitted to
 * pretend. `reason` says which of the two it is and what to do, and the same
 * string is what the procedure refuses with, so the customer-facing sentence
 * and the API error can never drift apart either.
 */
export type CheckoutModeKind =
  /** A Stripe secret key is set. Real payments, real money. */
  | "stripe"
  /** No Stripe key, and this environment is permitted to book orders without one. */
  | "simulated"
  /** No Stripe key, and nothing here may hand out paid goods. */
  | "unavailable";

export interface CheckoutMode {
  readonly kind: CheckoutModeKind;
  /**
   * Why, in one sentence somebody can act on.
   *
   * Written once so the notice a customer reads, the copy on the checkout page
   * and the message `checkout.simulate` throws are the same words. Two of those
   * three used to be written separately and one of them was wrong.
   */
  readonly reason: string;
}

/** The exact value that turns the simulated checkout on outside a local environment. */
const OPT_IN = "true";

export function checkoutMode(): CheckoutMode {
  // `stripe` is null exactly when STRIPE_SECRET_KEY is absent. Asked first
  // because it is the condition that flips by itself the moment the keys are
  // pasted in — nothing below has to be remembered or removed at launch.
  if (stripe) {
    return {
      kind: "stripe",
      reason: "Stripe is configured on this deployment, so payments are real.",
    };
  }

  const { appEnv, origin } = describeAppEnv();

  // *** THE UNIDENTIFIED REFUSAL COMES FIRST, AND THE ORDER IS THE WHOLE GATE. ***
  //
  // It used to sit below the staging opt-in, and that single line of ordering
  // reopened the hole this module exists to close. An unlabelled host resolves
  // to `staging` by FALL-THROUGH, not by anybody saying so — so a server with
  // `ALLOW_SIMULATED_CHECKOUT=true` and nothing else reached the opt-in branch
  // and gave paid goods away. Measured, not reasoned about: `next start` with
  // no VERCEL_ENV and no APP_ENV minted order ORD-20260831-000008-17 and
  // licence key HQWBH-2B88J-BRCXC-YWMNA against a £29 product. A mistyped
  // `APP_ENV=prod` did the same, because a value that fails to parse also falls
  // through to the same default — while `app-env.ts` promised in writing that a
  // typo would not be the permissive answer.
  //
  // So the opt-in is only ever consulted for an environment somebody NAMED. A
  // fall-through default may refuse; it may never permit.
  if (origin === "unidentified") {
    return {
      kind: "unavailable",
      reason:
        "Nothing on this host says which environment it is — no VERCEL_ENV, " +
        "no APP_ENV — so it is treated as a deployment, and a deployment does " +
        "not hand out paid goods. Set APP_ENV to local, staging or production. " +
        "To demonstrate the simulated checkout here, that means APP_ENV=staging " +
        "with ALLOW_SIMULATED_CHECKOUT=true.",
    };
  }

  if (appEnv === "local") {
    return {
      kind: "simulated",
      reason:
        "Stripe is not configured and this is a local environment, so orders " +
        "are recorded without a payment.",
    };
  }

  if (appEnv === "staging" && env.ALLOW_SIMULATED_CHECKOUT === OPT_IN) {
    return {
      kind: "simulated",
      reason:
        "Stripe is not configured and this environment has " +
        "ALLOW_SIMULATED_CHECKOUT=true, so orders are recorded without a " +
        "payment.",
    };
  }

  // Three different faults, three different people, three different fixes.
  // Collapsing them into one sentence would send somebody to change the wrong
  // thing — and the middle case is the one that gave products away, so it says
  // plainly that the environment was never named.
  if (appEnv === "production") {
    return {
      kind: "unavailable",
      reason:
        "This is a production deployment with no STRIPE_SECRET_KEY, so there " +
        "is nothing to charge with and simulated orders are never available " +
        "here. Configure Stripe.",
    };
  }

  return {
    kind: "unavailable",
    reason:
      "Stripe is not configured on this deployment and simulated orders are " +
      "switched off. Set ALLOW_SIMULATED_CHECKOUT=true to record orders " +
      "without a payment here, or configure Stripe to take real ones.",
  };
}
