/**
 * The templates, on their own entry point.
 *
 * SEPARATE FROM THE PACKAGE ROOT for the same reason `./schema` is. Importing
 * `createEmailSender` must not drag React, `react-dom/server` and the whole of
 * `@react-email/components` in behind it — a webhook route, a queue worker or a
 * script that only wants to send a message would pay for a renderer it never
 * calls, and `react-dom/server` is not something to have resolving in an edge
 * runtime that has no business rendering anything.
 *
 * It is also the seam a project customises. A generated app re-exports through
 * `src/emails/invitation.ts`, which composes the three pieces below — subject,
 * markup, plain text — so rewording a line is an edit to one call rather than a
 * fork of the layout.
 *
 * A NEXT.JS APP MUST NOT BUNDLE THIS ENTRY, and the cost of getting it wrong is
 * the whole application rather than the mail. Everything here reaches
 * `renderToStaticMarkup`, so it imports `react-dom/server` — and React ships a
 * `react-server` export condition for that module whose entire body is
 * `throw new Error("react-dom/server is not supported in React Server
 * Components")`. Every module a bundler pulls into the React Server Component
 * graph resolves under that condition, route handlers included. Reached from a
 * tRPC router, as the invitation template is, that is not a broken email — it
 * is every page that calls the server-side caller.
 *
 * The remedy is one line in the app, not a change here: name
 * `@adminigloo/email` in `serverExternalPackages` in `next.config.ts`. Node
 * then loads this module at request time under node conditions, where
 * `react-dom/server` is the real renderer. Rendering an email stays server work
 * and stays synchronous; what moves is only who loads the module.
 * `@adminigloo/create-app` emits that line for any project generated with
 * `--email`.
 *
 * TWO THINGS WORTH KNOWING, both measured rather than assumed. Turbopack
 * exempts node_modules from its react-dom/server rule, so an INSTALLED copy of
 * this package is bundled into the RSC chunks and works without the setting —
 * which is a heuristic about a path rather than a contract, and is exactly what
 * the setting replaces. And an external has to be installed: Next matches on a
 * resolved path inside `node_modules`, so a `link:` to a checkout is not
 * externalised, is treated as project source, and fails the build with "You're
 * importing a component that imports react-dom/server". `transpilePackages`
 * does not help, because transpiling is bundling.
 */
export { renderEmailHtml, articleFor, formatEmailDate } from "./emails/render.js";
export type { RenderedEmail } from "./emails/render.js";

export {
  InvitationEmail,
  invitationSubject,
  invitationPlainText,
  renderInvitationHtml,
  renderInvitationEmail,
} from "./emails/invitation.js";
export type { InvitationEmailProps } from "./emails/invitation.js";
