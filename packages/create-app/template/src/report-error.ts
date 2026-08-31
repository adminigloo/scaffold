/**
 * The browser half of error reporting.
 *
 * A React error boundary is a CLIENT component. It cannot open a database
 * connection, cannot read a server environment variable and cannot import
 * anything that does — so the only way a caught render error becomes a row is
 * for the browser to post it to a route handler. That handler is
 * `app/api/error-report/route.ts`, and this is the only thing that calls it.
 *
 * THE DIGEST IS THE POINT. In production React does not send the real error to
 * the browser: the boundary receives a generic message and a `digest`, and the
 * server has already logged the true error and stack against that same digest.
 * Carrying it back is what turns "something broke on somebody's screen" into a
 * line in the server log — without it the two records exist and cannot be
 * joined, which is the same as not having the client one at all.
 *
 * Errors here are swallowed. The page is already showing a failure; a reporter
 * that throws on top of it replaces a recoverable error screen with a blank
 * one, and the person looking at it learns less than before.
 */
export function reportClientError(error: unknown, boundary: string): void {
  // Rendered on the server first, where there is no `fetch` target and no
  // window to read a URL from. Not a guard against a missing feature — the
  // boundary's effect only runs in the browser, and this makes that true of the
  // module as well so it stays safe to import anywhere.
  if (typeof window === "undefined") return;

  const described = error instanceof Error ? error : null;
  const digest =
    typeof (error as { digest?: unknown } | null)?.digest === "string"
      ? (error as { digest: string }).digest
      : undefined;

  void fetch("/api/error-report", {
    method: "POST",
    headers: { "content-type": "application/json" },
    // The boundary often renders immediately before a reload or a navigation
    // away from the broken page, and a plain fetch is cancelled when the
    // document goes. `keepalive` lets the report outlive the page that produced
    // it, which is the report most worth having.
    keepalive: true,
    body: JSON.stringify({
      boundary,
      digest,
      name: described?.name,
      // Truncated here as well as on the server. The handler is the boundary
      // that actually enforces it; this keeps a runaway message from being
      // serialised at all on a page that is already in trouble.
      message: described?.message.slice(0, 500),
      url: window.location.href.slice(0, 2000),
    }),
  }).catch(() => {
    // Deliberately empty. See above.
  });
}
