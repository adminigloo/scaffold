/**
 * Where an invitation link points.
 *
 * One function, and every surface that mints, prints or renders an invite link
 * goes through it — the mail template, the copy-the-link button on the members
 * page, and the sign-up round trip that has to send somebody back to the
 * invitation they arrived with. Three copies of one route is two copies that
 * get missed: move the page to `/join/[token]` and the mail carries on sending
 * a URL that 404s, with nothing failing to build and nobody noticing until an
 * invitee says the link is broken. Named once, that move breaks a single line.
 *
 * The same reasoning as `productHref`, and the same encoding rule for a
 * stronger reason: an invitation token is base64url, which is URL-safe by
 * construction, so encoding it changes nothing today. It is here because the
 * token generator is free to change its alphabet, and the failure mode if it
 * ever did — a `+` or a `/` splitting the value across path segments — is an
 * invitation that resolves to a DIFFERENT hash and reports itself as unknown.
 * That reads as "this link never existed", which is the one message that sends
 * an invitee to support instead of back to the sender.
 *
 * Relative, deliberately. Every in-app link wants a path; only the mail wants
 * an absolute URL, and `invitationUrl` in src/server/invitations.ts builds that
 * one from this and NEXT_PUBLIC_APP_URL. A function that returned an absolute
 * URL would put the deployment's origin into every href on the page, which
 * breaks preview deployments in the least obvious way possible.
 */

/** In-app path of the page that accepts one invitation. */
export function invitePath(token: string): string {
  return `/invite/${encodeURIComponent(token)}`;
}
