import {
  formatSenderAddress,
  InvalidSenderAddressError,
  parseSenderAddress,
  type SenderAddress,
} from "./sender.js";
// Type-only, and it has to stay that way. `./schema.ts` is a separate tsup
// entry; a value import from here would pull drizzle-orm/pg-core into the
// barrel bundle, and since tsup does not code-split CJS a require() consumer
// would end up holding two distinct objects for one physical table.
import type { EmailMetadata, EmailStatus } from "./schema.js";

/** What a caller asks to send. */
export interface EmailMessage {
  /**
   * A single recipient, bare or with a display name.
   *
   * One address, not a list, because the delivery log stores one row per
   * message and a bounce webhook names exactly one recipient. A row covering
   * five addresses cannot record that the third one bounced, which is the only
   * fact anybody needs from it.
   */
  readonly to: string;
  readonly subject: string;
  readonly html?: string | undefined;
  readonly text?: string | undefined;
  /** Recorded, not rendered. Rendering belongs to the app. */
  readonly template?: string | undefined;
  readonly tenantId?: string | undefined;
  readonly metadata?: EmailMetadata | undefined;
}

/** A validated message, formatted, as the transport receives it. */
export interface OutboundEmail {
  readonly from: string;
  readonly to: string;
  readonly replyTo: string | null;
  readonly subject: string;
  readonly html: string | null;
  readonly text: string | null;
}

export interface TransportResult {
  /** The provider's id, or null if it did not return one. */
  readonly id: string | null;
}

export type EmailTransport = (message: OutboundEmail) => Promise<TransportResult>;

/**
 * The row to write to `email_events`. Shaped to be handed straight to
 * `db.insert(emailEvents).values(outcome.log)`.
 *
 * Returned rather than written, so `send` needs no database handle and the
 * entire decision path — validate, skip, dispatch, record — is unit-testable
 * with no Postgres and no network.
 */
export interface EmailLogEntry {
  readonly messageId: string | null;
  readonly toAddress: string;
  readonly fromAddress: string;
  readonly subject: string;
  readonly template: string | null;
  readonly tenantId: string | null;
  readonly status: EmailStatus;
  readonly provider: string;
  readonly error: string | null;
  readonly metadata: EmailMetadata | null;
}

export type SendOutcome =
  | { readonly status: "sent"; readonly messageId: string | null; readonly log: EmailLogEntry }
  | { readonly status: "skipped"; readonly reason: SkipReason; readonly log: EmailLogEntry }
  | { readonly status: "failed"; readonly error: Error; readonly log: EmailLogEntry };

/**
 * Only one reason exists today, and it is spelled out rather than implied by
 * the status so a log line can say WHY nothing was sent. "skipped" alone reads
 * like a deliberate suppression rule.
 */
export type SkipReason = "no-transport";

export class EmailMessageInvalidError extends Error {
  readonly name = "EmailMessageInvalidError";
  constructor(
    readonly field: "to" | "subject" | "body",
    reason: string,
  ) {
    super(`Refusing to send: ${field} ${reason}.`);
  }
}

export class EmailTransportError extends Error {
  readonly name = "EmailTransportError";
  constructor(
    /** The provider's HTTP status, or null if the request never completed. */
    readonly status: number | null,
    detail: string,
    cause?: unknown,
  ) {
    super(
      status === null
        ? `The email provider could not be reached: ${detail}`
        : `The email provider rejected the message with HTTP ${status}: ${detail}`,
      { cause },
    );
  }
}

export interface CreateEmailSenderOptions {
  /**
   * `re_…`. Undefined is a supported state, not a misconfiguration — see the
   * `skipped` note on `EmailStatus`.
   */
  readonly apiKey?: string | undefined;
  /** `EMAIL_FROM`. Bare or `Display Name <address>`; both parse. */
  readonly from: string;
  readonly replyTo?: string | undefined;
  /**
   * Replaces the built-in Resend transport.
   *
   * This is how the dispatch path gets tested without a Resend account, and
   * it is also the seam for a deployment that sends through something else.
   * An injected transport counts as being configured, because a caller who
   * hands us a way to send has said so explicitly — but the two-line rule
   * still holds: with neither an API key nor an injection, nothing is
   * dispatched and nothing touches the network.
   */
  readonly send?: EmailTransport | undefined;
  /** Recorded in `email_events.provider`. */
  readonly provider?: string;
}

export interface EmailSender {
  /** False means every send will be skipped. Gate UI on it, not on the key. */
  readonly configured: boolean;
  readonly from: SenderAddress;
  readonly replyTo: SenderAddress | null;
  send(message: EmailMessage): Promise<SendOutcome>;
}

/**
 * Build the sender for this process.
 *
 * Throws only for a `from`/`replyTo` that cannot be parsed — a value that
 * cannot become a `From:` header is a configuration error with no correct
 * behaviour available, and failing at construction points at the variable
 * instead of at the first customer who did not get a receipt. Note the
 * asymmetry with a missing API key, which is NOT an error: one is a broken
 * value, the other is an integration nobody has set up yet.
 */
export function createEmailSender(options: CreateEmailSenderOptions): EmailSender {
  const from = parseSenderAddress(options.from);
  if (from === null) throw new InvalidSenderAddressError(options.from, "EMAIL_FROM");

  let replyTo: SenderAddress | null = null;
  if (options.replyTo !== undefined && options.replyTo.trim().length > 0) {
    replyTo = parseSenderAddress(options.replyTo);
    if (replyTo === null) {
      throw new InvalidSenderAddressError(options.replyTo, "EMAIL_REPLY_TO");
    }
  }

  const apiKey = options.apiKey?.trim();
  const transport: EmailTransport | null =
    options.send ?? (apiKey ? createResendTransport(apiKey) : null);

  const provider = options.provider ?? "resend";
  const fromAddress = formatSenderAddress(from, "EMAIL_FROM");
  const replyToAddress =
    replyTo === null ? null : formatSenderAddress(replyTo, "EMAIL_REPLY_TO");

  return {
    configured: transport !== null,
    from,
    replyTo,
    async send(message: EmailMessage): Promise<SendOutcome> {
      const to = parseSenderAddress(message.to);
      if (to === null) {
        throw new EmailMessageInvalidError(
          "to",
          `is not an address we can send to: ${JSON.stringify(message.to)}`,
        );
      }

      // `typeof` rather than a bare `.trim()`: the types say this is a string,
      // and a JavaScript caller passing undefined would otherwise get a
      // TypeError from inside this package instead of the typed error that
      // names the field.
      const subject = typeof message.subject === "string" ? message.subject.trim() : "";
      if (subject.length === 0) {
        // An empty subject is not merely ugly. Most filters score it as spam,
        // so the mail is delivered to nowhere visible and the log says "sent".
        throw new EmailMessageInvalidError("subject", "is empty");
      }

      const html = nonEmpty(message.html);
      const text = nonEmpty(message.text);
      if (html === null && text === null) {
        throw new EmailMessageInvalidError(
          "body",
          "is empty — pass html, text, or both. A message with neither is " +
            "accepted by the provider and arrives blank",
        );
      }

      const base = {
        toAddress: formatSenderAddress(to, "to"),
        fromAddress,
        subject,
        template: message.template ?? null,
        tenantId: message.tenantId ?? null,
        provider,
        metadata: message.metadata ?? null,
      } as const;

      if (transport === null) {
        // The whole point of the package. No credential, no network call, no
        // exception — a row saying precisely what would have been sent.
        return {
          status: "skipped",
          reason: "no-transport",
          log: { ...base, messageId: null, status: "skipped", error: null },
        };
      }

      let result: TransportResult;
      try {
        result = await transport({
          from: fromAddress,
          to: base.toAddress,
          replyTo: replyToAddress,
          subject,
          html,
          text,
        });
      } catch (cause) {
        // Returned, not rethrown. A provider being down is not a defect in the
        // call site, and the caller's real job here is to write the row: an
        // exception at this point loses the record of an attempt that already
        // may have been delivered.
        const error = asError(cause);
        return {
          status: "failed",
          error,
          log: { ...base, messageId: null, status: "failed", error: error.message },
        };
      }

      return {
        status: "sent",
        messageId: result.id,
        log: { ...base, messageId: result.id, status: "sent", error: null },
      };
    },
  };
}

/** How long the provider gets before we give up on it. */
const TRANSPORT_TIMEOUT_MS = 10_000;

const RESEND_ENDPOINT = "https://api.resend.com/emails";

/**
 * The default transport: one POST, via `fetch`.
 *
 * Not the `resend` SDK. This package's entire premise is that it works with no
 * Resend account, and making every consumer install a provider SDK to reach
 * that state is the opposite. One documented endpoint against a built-in
 * `fetch` also runs unchanged on Node and on the edge, where the SDK's
 * transitive dependencies do not.
 *
 * The API key is captured here rather than passed to the transport, so an
 * injected test double is never handed the production credential.
 */
export function createResendTransport(apiKey: string): EmailTransport {
  return async (message: OutboundEmail): Promise<TransportResult> => {
    let response: Response;
    try {
      response = await fetch(RESEND_ENDPOINT, {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          from: message.from,
          to: [message.to],
          subject: message.subject,
          ...(message.html !== null ? { html: message.html } : {}),
          ...(message.text !== null ? { text: message.text } : {}),
          ...(message.replyTo !== null ? { reply_to: message.replyTo } : {}),
        }),
        // Without a deadline a hung provider holds the request open until the
        // platform kills the whole function, so the caller never reaches the
        // line that would have logged the failure.
        signal: AbortSignal.timeout(TRANSPORT_TIMEOUT_MS),
      });
    } catch (cause) {
      throw new EmailTransportError(null, asError(cause).message, cause);
    }

    // Parsed before the status check: a 4xx from Resend carries the reason in
    // its body ("domain is not verified"), and reporting only "HTTP 403" sends
    // the reader to a dashboard to find out what we were already told.
    const body: unknown = await response.json().catch(() => null);

    if (!response.ok) {
      throw new EmailTransportError(
        response.status,
        providerMessage(body) ?? response.statusText,
      );
    }

    return { id: readMessageId(body) };
  };
}

function providerMessage(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const message = (body as { readonly message?: unknown }).message;
  if (typeof message === "string" && message.length > 0) return message;
  const error = (body as { readonly error?: unknown }).error;
  if (typeof error === "string" && error.length > 0) return error;
  return null;
}

function readMessageId(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const id = (body as { readonly id?: unknown }).id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

/** Whitespace is not a body, and `""` is not a template name. */
function nonEmpty(value: string | undefined): string | null {
  if (value === undefined) return null;
  return value.trim().length > 0 ? value : null;
}

/** A transport may throw anything; the log column takes a string. */
function asError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}
