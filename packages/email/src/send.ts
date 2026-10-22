import {
  formatSenderAddress,
  InvalidSenderAddressError,
  parseSenderAddress,
  sanitizeDisplayName,
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
  /**
   * The display name on THIS message's From. The address stays EMAIL_FROM's:
   * the verified sending domain is the only one the provider sends from, so a
   * company on a shared platform gets its NAME on the platform's address,
   * never an address of its own (Tenancy 2a, D8).
   *
   * Cleaned by `sanitizeDisplayName` (control characters out, whitespace
   * collapsed, cut to 64). Empty after cleaning → the sender's own name, so a
   * blank company name degrades to the platform's From instead of to a bare
   * address with no name at all.
   */
  readonly fromName?: string | null | undefined;
  /**
   * Reply-To for THIS message, in place of EMAIL_REPLY_TO. Bare or named.
   *
   * Unparseable → `EmailMessageInvalidError("replyTo")`. Refusing beats
   * falling back to the default: a customer's "I need to reschedule" sent to
   * the platform owner instead of the business is a reply that reaches the
   * wrong person, and a refused send is one the caller logs and can see.
   */
  readonly replyTo?: string | null | undefined;
  /**
   * Extra message headers (0.5), e.g. RFC 8058's one-click unsubscribe pair:
   *
   *   headers: {
   *     "List-Unsubscribe": "<https://yoursite.com/api/email/v1/unsubscribe?t=…>",
   *     "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
   *   }
   *
   * Names are letters, digits and hyphens; values are one line (no CR, LF or
   * other control character, at most 2,000 characters); at most 20 of them.
   * The headers this package writes itself (From, To, Cc, Bcc, Subject,
   * Reply-To, Sender, Date, Message-ID, the MIME headers) are refused: use
   * the message's own fields. Anything else is `EmailMessageInvalidError`
   * (`field: "headers"`), never silently dropped — a dropped unsubscribe
   * header is a sender Gmail and Yahoo start filtering.
   */
  readonly headers?: Readonly<Record<string, string>> | undefined;
  /**
   * The same key on a repeat of this message makes the provider drop the
   * repeat instead of sending it twice (0.5; Resend's `Idempotency-Key`,
   * honoured for 24 hours). For a retry after a send that may have gone — a
   * timeout, a crash between the send and the write that records it. 1 to
   * 256 visible ASCII characters, no spaces (`field: "idempotencyKey"`
   * otherwise). A custom transport receives it and decides for itself.
   */
  readonly idempotencyKey?: string | null | undefined;
}

/** A validated message, formatted, as the transport receives it. */
export interface OutboundEmail {
  readonly from: string;
  readonly to: string;
  readonly replyTo: string | null;
  readonly subject: string;
  readonly html: string | null;
  readonly text: string | null;
  /** The message's extra headers, validated (0.5). Absent or null: none. */
  readonly headers?: Readonly<Record<string, string>> | null;
  /** The message's idempotency key, validated (0.5). Absent or null: none. */
  readonly idempotencyKey?: string | null;
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
    readonly field: "to" | "subject" | "body" | "replyTo" | "headers" | "idempotencyKey",
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

      // Per-message identity (D8). Both are resolved BEFORE the transport is
      // consulted, so an unconfigured deployment's "skipped" row records the
      // From that would have gone, exactly as a sent one does.
      const messageFromName = sanitizeDisplayName(message.fromName);
      const messageFrom =
        messageFromName === null
          ? fromAddress
          : formatSenderAddress({ name: messageFromName, email: from.email }, "fromName");
      let messageReplyTo = replyToAddress;
      if (typeof message.replyTo === "string" && message.replyTo.trim().length > 0) {
        const parsed = parseSenderAddress(message.replyTo);
        if (parsed === null) {
          throw new EmailMessageInvalidError(
            "replyTo",
            `is not an address a reply can go to: ${JSON.stringify(message.replyTo)}`,
          );
        }
        messageReplyTo = formatSenderAddress(parsed, "replyTo");
      }

      // Checked before the transport is consulted, so a message an
      // unconfigured deployment would have sent wrong is refused there too.
      const headers = validHeaders(message.headers);
      const idempotencyKey = validIdempotencyKey(message.idempotencyKey);

      const base = {
        toAddress: formatSenderAddress(to, "to"),
        // The From actually used, so the log row says what the customer saw.
        fromAddress: messageFrom,
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
          from: messageFrom,
          to: base.toAddress,
          replyTo: messageReplyTo,
          subject,
          html,
          text,
          // Only when the message has them, so a message without either reaches
          // a transport exactly as it did before 0.5.
          ...(headers !== null ? { headers } : {}),
          ...(idempotencyKey !== null ? { idempotencyKey } : {}),
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
          // Resend drops a repeat of the same key for 24 hours (0.5).
          ...(message.idempotencyKey ? { "idempotency-key": message.idempotencyKey } : {}),
        },
        body: JSON.stringify({
          from: message.from,
          to: [message.to],
          subject: message.subject,
          ...(message.html !== null ? { html: message.html } : {}),
          ...(message.text !== null ? { text: message.text } : {}),
          ...(message.replyTo !== null ? { reply_to: message.replyTo } : {}),
          ...(message.headers && Object.keys(message.headers).length > 0 ? { headers: { ...message.headers } } : {}),
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

/**
 * Headers the message's own fields write, refused as extras: a second
 * `Subject` or `To` is either ignored or duplicated depending on the
 * provider, and neither is what the caller meant.
 */
const RESERVED_HEADERS = new Set([
  "from",
  "to",
  "cc",
  "bcc",
  "subject",
  "reply-to",
  "sender",
  "date",
  "message-id",
  "mime-version",
  "content-type",
  "content-transfer-encoding",
  "return-path",
]);

const MAX_HEADERS = 20;
const MAX_HEADER_VALUE = 2_000;

/** The extras, checked (0.5): null when there are none. */
function validHeaders(input: Readonly<Record<string, string>> | undefined): Readonly<Record<string, string>> | null {
  if (input === undefined || input === null) return null;
  if (typeof input !== "object" || Array.isArray(input)) {
    throw new EmailMessageInvalidError("headers", "must be an object of header names to values");
  }
  const entries = Object.entries(input);
  if (entries.length === 0) return null;
  if (entries.length > MAX_HEADERS) {
    throw new EmailMessageInvalidError("headers", `has ${entries.length} entries; at most ${MAX_HEADERS} are sent`);
  }
  const out: Record<string, string> = {};
  const seen = new Set<string>();
  for (const [name, value] of entries) {
    if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,75}$/.test(name)) {
      throw new EmailMessageInvalidError("headers", `has a name that isn't a header name: ${JSON.stringify(name)}`);
    }
    const lower = name.toLowerCase();
    if (RESERVED_HEADERS.has(lower)) {
      throw new EmailMessageInvalidError("headers", `names ${name}, which the message's own fields write`);
    }
    if (seen.has(lower)) throw new EmailMessageInvalidError("headers", `names ${name} twice`);
    seen.add(lower);
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new EmailMessageInvalidError("headers", `gives ${name} no value`);
    }
    if (value.length > MAX_HEADER_VALUE || hasControl(value)) {
      // A CR or LF here ends the header and starts one the caller never
      // wrote: the header-injection rule `formatSenderAddress` holds for From.
      throw new EmailMessageInvalidError(
        "headers",
        `gives ${name} a value that isn't one line of at most ${MAX_HEADER_VALUE} characters`,
      );
    }
    out[name] = value;
  }
  return out;
}

/** The idempotency key, checked (0.5): null when there is none. */
function validIdempotencyKey(input: string | null | undefined): string | null {
  if (input === undefined || input === null) return null;
  if (typeof input !== "string" || !/^[\x21-\x7e]{1,256}$/.test(input)) {
    throw new EmailMessageInvalidError("idempotencyKey", "must be 1 to 256 visible ASCII characters with no spaces");
  }
  return input;
}

/** Any C0 control character or DEL. A scan, so this file holds none itself. */
function hasControl(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
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
