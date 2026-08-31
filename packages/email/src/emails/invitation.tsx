import {
  Body,
  Button,
  Container,
  Head,
  Hr,
  Html,
  Link,
  Preview,
  Section,
  Text,
} from "@react-email/components";
import type { ReactElement } from "react";
import {
  articleFor,
  formatEmailDate,
  renderEmailHtml,
  type RenderedEmail,
} from "./render.js";

/**
 * The invitation email, and the first template this package ships.
 *
 * It lives here rather than in the generated app because the markup is the part
 * nobody should be maintaining per project: the table scaffolding, the MSO
 * conditionals that keep a button rectangular in Outlook, the inline styles
 * that survive Gmail stripping `<style>` blocks. A project that wants different
 * words changes the words; a project that wants a different LAYOUT has a real
 * decision to make and should make it once, here.
 *
 * INLINE STYLES AND HEX LITERALS, DELIBERATELY. Email clients are not browsers.
 * Gmail strips `<style>` in some contexts, Outlook renders through Word, and
 * every class-based stylesheet in this repository — Tailwind included —
 * resolves to nothing in an inbox. This is the one place in the codebase where
 * a hex literal is correct rather than a theme violation, because there is no
 * theme to read from.
 *
 * NOTHING IS ESCAPED BY HAND. A tenant name is typed by a customer and lands
 * inside a document sent from our own authenticated domain, which makes an
 * unescaped `<img onerror=…>` in an organisation name stored HTML injection
 * with a transactional email's deliverability behind it. React escapes children
 * and attributes by construction, which is the whole reason the previous
 * hand-rolled template string was replaced: it was correct, and it was correct
 * only for as long as every future interpolation remembered the helper.
 */
export interface InvitationEmailProps {
  /** The organisation being joined. Customer-supplied text. */
  readonly tenantName: string;
  /** Who sent it, as a name or an address. Null when we do not know. */
  readonly invitedBy: string | null;
  /** The role the invitation carries, by its human name. */
  readonly roleName: string;
  /**
   * The full absolute URL, and a bearer credential.
   *
   * Relative paths are not links in an inbox. The token is in this string, so
   * it must never reach a log line, an audit row or the delivery log's
   * metadata — only the message body.
   */
  readonly url: string;
  /** Null means the invitation does not expire. */
  readonly expiresAt: Date | null;
  /** Product name, for the sentence and the signature line. */
  readonly productName: string;
}

const INK = "#12161a";
const MUTED = "#5f6a76";
const BRAND = "#17635a";
const PAPER = "#ffffff";
const PAGE = "#f7f8f9";
const RULE = "#e3e6ea";

const FONT_STACK =
  "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

function senderName(props: InvitationEmailProps): string {
  return props.invitedBy === null ? "Someone" : props.invitedBy;
}

function expiryLine(props: InvitationEmailProps): string {
  return props.expiresAt === null
    ? "This link does not expire."
    : `This link stops working on ${formatEmailDate(props.expiresAt)}.`;
}

/**
 * What lands in the inbox list.
 *
 * The organisation name is in the subject because that is what a recipient
 * scans for in a crowded inbox. "You have been invited" on its own is
 * indistinguishable from every marketing mail ever sent, and an invitation that
 * reads as marketing is an invitation that is never opened.
 */
export function invitationSubject(props: InvitationEmailProps): string {
  return `${senderName(props)} invited you to ${props.tenantName}`;
}

/**
 * The plain-text part.
 *
 * Written rather than derived, and it says the same thing as the HTML. The URL
 * appears in full because a client showing only anchor text has nothing to
 * paste, and because a filter comparing the two parts treats a mismatch as
 * phishing.
 */
export function invitationPlainText(props: InvitationEmailProps): string {
  const who = senderName(props);
  return [
    `${who} has invited you to join ${props.tenantName} on ${props.productName} ` +
      `as ${articleFor(props.roleName)} ${props.roleName}.`,
    "",
    "Open this link to accept:",
    props.url,
    "",
    expiryLine(props),
    "It can only be used once.",
    "",
    "If you were not expecting this, you can ignore it — nothing happens until",
    "somebody opens the link, and it will expire on its own.",
  ].join("\n");
}

/** The document. */
export function InvitationEmail(props: InvitationEmailProps): ReactElement {
  const who = senderName(props);
  return (
    <Html lang="en">
      <Head />
      {/* The line a client shows beside the subject. Without one it shows the
          first words of the body, which here would be the sender's name twice. */}
      <Preview>
        {`Accept your invitation to ${props.tenantName} — the link works once.`}
      </Preview>
      <Body
        style={{
          margin: 0,
          padding: "24px",
          backgroundColor: PAGE,
          fontFamily: FONT_STACK,
          color: INK,
        }}
      >
        <Container
          style={{
            maxWidth: "520px",
            margin: "0 auto",
            backgroundColor: PAPER,
            border: `1px solid ${RULE}`,
            borderRadius: "6px",
          }}
        >
          <Section style={{ padding: "24px" }}>
            <Text style={{ margin: "0 0 16px", fontSize: "16px", lineHeight: "24px" }}>
              <strong>{who}</strong> has invited you to join{" "}
              <strong>{props.tenantName}</strong> on {props.productName} as{" "}
              {articleFor(props.roleName)} {props.roleName}.
            </Text>

            <Button
              href={props.url}
              style={{
                display: "inline-block",
                backgroundColor: BRAND,
                color: PAPER,
                textDecoration: "none",
                padding: "10px 16px",
                borderRadius: "6px",
                fontSize: "14px",
                fontWeight: 600,
              }}
            >
              Accept the invitation
            </Button>

            <Text
              style={{
                margin: "24px 0 16px",
                fontSize: "13px",
                lineHeight: "20px",
                color: MUTED,
              }}
            >
              {expiryLine(props)} It can only be used once.
            </Text>

            <Text
              style={{ margin: "0 0 8px", fontSize: "13px", lineHeight: "20px", color: MUTED }}
            >
              If the button does not work, copy this address into your browser:
            </Text>
            {/* The URL in full, and as its own visible text. A link whose label
                and target differ is the single strongest phishing signal a
                filter looks for, and this is a message we need delivered. */}
            <Text
              style={{
                margin: "0 0 24px",
                fontSize: "12px",
                lineHeight: "18px",
                wordBreak: "break-all",
              }}
            >
              <Link href={props.url} style={{ color: BRAND }}>
                {props.url}
              </Link>
            </Text>

            <Hr style={{ borderColor: RULE, margin: "0 0 16px" }} />

            <Text style={{ margin: 0, fontSize: "12px", lineHeight: "18px", color: MUTED }}>
              If you were not expecting this you can ignore it. Nothing happens
              until somebody opens the link, and it will expire on its own.
            </Text>
          </Section>
        </Container>
      </Body>
    </Html>
  );
}

/** Just the HTML part, for a caller composing its own subject and text. */
export function renderInvitationHtml(props: InvitationEmailProps): string {
  return renderEmailHtml(<InvitationEmail {...props} />);
}

/** Subject, HTML and text in one call. */
export function renderInvitationEmail(props: InvitationEmailProps): RenderedEmail {
  return {
    subject: invitationSubject(props),
    html: renderInvitationHtml(props),
    text: invitationPlainText(props),
  };
}
