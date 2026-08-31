import {
  invitationPlainText,
  invitationSubject,
  renderInvitationHtml,
} from "__SCOPE__/email/emails";

/**
 * The invitation email, as this project sends it.
 *
 * THE MARKUP IS NOT HERE, AND THAT IS THE CHANGE. It used to be: a template
 * literal holding a whole HTML document, with an `escapeHtml` helper applied by
 * hand at every interpolation. That is correct exactly as long as nobody
 * forgets one, and forgetting one is stored HTML injection carried by a message
 * sent from this deployment's own authenticated domain — a
 * __TENANT_LABEL_LOWER__ name is typed by a customer, and `<img onerror=…>` in
 * one would have rendered. @__SCOPE_NAME__/email now owns the document as a
 * React Email component, where escaping is a property of the renderer rather
 * than a habit, and where the table scaffolding and the Outlook conditionals
 * that keep a button rectangular live in one place instead of in every
 * generated project.
 *
 * WHAT IS STILL YOURS is everything above: the subject line, the words in the
 * plain-text part, and which template gets rendered. Each is a separate call
 * below, so changing the wording is an edit to one line rather than a fork of
 * the layout. Swap `invitationSubject(props)` for a string of your own and
 * nothing else moves.
 *
 * BOTH BODIES, ALWAYS. `text` is not a fallback for a browser nobody uses: a
 * message with no plain-text part scores as spam at most providers, and the
 * first symptom is not "the layout looked wrong", it is that the invitation was
 * never seen. The two say the same thing, and the URL appears in full in both,
 * because a link whose visible text and target differ is the single strongest
 * phishing signal a filter looks for.
 *
 * The types are declared here rather than re-exported because this module is
 * the contract `src/server/invitation-mail.ts` and the `/setup/email` preview
 * both compile against, and a generated project should be able to read what it
 * is passing without following an import into a package.
 */
export interface InvitationEmailProps {
  /** The __TENANT_LABEL_LOWER__ being joined. Customer-supplied text. */
  readonly tenantName: string;
  /** Who sent it, as a name or an address. Null when we do not know. */
  readonly invitedBy: string | null;
  /** The role the invitation carries, by its human name. */
  readonly roleName: string;
  /** The full absolute URL. Relative paths are not links in an inbox. */
  readonly url: string;
  /** Null means the invitation does not expire. */
  readonly expiresAt: Date | null;
  /** Product name, for the signature line. */
  readonly productName: string;
}

export interface RenderedEmail {
  readonly subject: string;
  readonly html: string;
  readonly text: string;
}

export function renderInvitationEmail(props: InvitationEmailProps): RenderedEmail {
  return {
    subject: invitationSubject(props),
    html: renderInvitationHtml(props),
    text: invitationPlainText(props),
  };
}
