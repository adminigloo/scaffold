"use client";

import { ErrorScreen } from "@/components/ErrorScreen";

/**
 * The account area failing is not the checkout failing, and the difference is
 * the whole reason this boundary exists rather than inheriting the site one.
 *
 * Nothing under `/account` takes money or changes anything. Every page here is
 * a read, and the one mutation — opening the billing portal — answers with a
 * state rather than throwing. So the first sentence a reader needs is that
 * their purchases, keys and subscription are all exactly as they were: a person
 * whose licence keys have just disappeared behind an error page will assume
 * they have lost them, and the assumption is wrong in a way that generates a
 * support ticket within the minute.
 *
 * Retrying genuinely helps, because a failure here is a failed database read
 * rather than a broken state.
 */
export default function AccountError({
  error,
  reset,
}: {
  readonly error: Error & { digest?: string };
  readonly reset: () => void;
}) {
  return (
    <ErrorScreen
      error={error}
      reset={reset}
      boundary="account"
      title="Your account could not be loaded"
      back={{ href: "/", label: "Back to the site" }}
    >
      <p>
        <strong className="font-medium text-ink">Nothing has been lost.</strong>{" "}
        This page only reads — your orders, licence keys and subscription are
        untouched, and nothing has been charged or cancelled.
      </p>
      <p className="mt-2">
        Trying again usually works. If it does not, quote the reference below and
        support can look the same records up from their side.
      </p>
    </ErrorScreen>
  );
}
