import { dataUrlToBlob } from "./screenshot.js";
import type {
  CapturedError,
  ClientMetadata,
  FeedbackCategoryOption,
  FeedbackPriority,
  FeedbackReporter,
} from "./types.js";

/**
 * The whole client side of the wire contract in one place. Every call carries
 * the website key when there is one; every failure returns a value instead of
 * throwing, because a feedback tool that crashes the page it is reporting on
 * has inverted its job.
 */

const KEY_HEADER = "x-adminigloo-key";

export interface SubmitInput {
  description: string;
  priority: FeedbackPriority;
  category?: string;
  screenshotUrl?: string;
  annotatedScreenshotUrl?: string;
  reporter?: FeedbackReporter;
  clientMetadata: ClientMetadata;
  recentErrors?: CapturedError[];
  /** The honeypot (0.4.0): a field a person never sees. Always "" from a person. */
  website?: string;
}

export type SubmitResult =
  | { ok: true; ticketNumber: string; ticketToken: string | null }
  | { ok: false; error: string };

/** The reporter-visible half of a ticket's conversation (0.4.0 platform). */
export interface ThreadTicket {
  ticketNumber: string;
  title: string;
  status: string;
  statusLabel: string;
  createdAt: string;
}

export interface ThreadMessage {
  id: string;
  senderType: "staff" | "reporter";
  senderName: string;
  body: string;
  createdAt: string;
}

export type ThreadResult =
  | { ok: true; ticket: ThreadTicket; messages: ThreadMessage[] }
  /** `gone` marks a 404 — the ticket (or its token) is no longer recognised,
   *  so the stored entry is stale rather than the network being down. */
  | { ok: false; error: string; gone: boolean };

export type ReplyResult = { ok: true } | { ok: false; error: string };

export interface FeedbackConfigResult {
  categories: FeedbackCategoryOption[] | null;
  /** The platform's sentence when this form takes no new reports (0.4.0); null when it does. */
  closed: string | null;
}

const UNREACHABLE = "We couldn't reach the feedback service. Check your connection and try again.";

/**
 * The server's sentence from a refusal (0.4.0). The platform answers
 * `{ error: "<sentence>" }`; an `{ error: { message } }` is read too, so an
 * object never reaches the screen.
 */
export function errorSentence(body: unknown, fallback: string): string {
  const error = (body as { error?: unknown } | null)?.error;
  if (typeof error === "string" && error.trim() !== "") return error;
  if (error && typeof error === "object") {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.trim() !== "") return message;
  }
  return fallback;
}

export class FeedbackTransport {
  /**
   * `clientKey` is optional since 0.4.0: a company's own feedback page names
   * the company in its address and sends no key.
   */
  constructor(
    private readonly baseUrl: string,
    private readonly clientKey?: string,
  ) {}

  private url(path: string): string {
    return `${this.baseUrl.replace(/\/$/, "")}${path}`;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return this.clientKey ? { [KEY_HEADER]: this.clientKey, ...extra } : { ...extra };
  }

  /** The dropdown and whether the form takes new reports, in one call. Never throws. */
  async fetchConfig(): Promise<FeedbackConfigResult> {
    try {
      const res = await fetch(this.url("/v1/config"), { headers: this.headers() });
      if (!res.ok) return { categories: null, closed: null };
      const body = (await res.json()) as { categories?: FeedbackCategoryOption[]; closed?: unknown };
      return {
        categories: Array.isArray(body.categories) ? body.categories : null,
        closed: typeof body.closed === "string" && body.closed.trim() !== "" ? body.closed : null,
      };
    } catch {
      return { categories: null, closed: null };
    }
  }

  /** null on any failure — the caller falls back to its built-in category list. */
  async fetchCategories(): Promise<FeedbackCategoryOption[] | null> {
    return (await this.fetchConfig()).categories;
  }

  /** null on any failure, including a platform without storage — the report still submits. */
  async uploadScreenshot(dataUrl: string, kind: "screenshot" | "annotated"): Promise<string | null> {
    try {
      const form = new FormData();
      form.append("file", dataUrlToBlob(dataUrl));
      form.append("kind", kind);
      const res = await fetch(this.url("/v1/upload"), {
        method: "POST",
        headers: this.headers(),
        body: form,
      });
      if (!res.ok) return null;
      const body = (await res.json()) as { url?: string };
      return typeof body.url === "string" ? body.url : null;
    } catch {
      return null;
    }
  }

  async submit(input: SubmitInput): Promise<SubmitResult> {
    try {
      const res = await fetch(this.url("/v1/submit"), {
        method: "POST",
        headers: this.headers({ "content-type": "application/json" }),
        body: JSON.stringify(input),
      });
      if (!res.ok) {
        const body: unknown = await res.json().catch(() => null);
        return { ok: false, error: errorSentence(body, "Your report didn't go through. Please try again.") };
      }
      const body = (await res.json()) as { ticketNumber?: string; ticketToken?: string };
      // Null against a pre-0.4 platform, which is a submit that worked and a
      // follow-up that is not on offer — not an error.
      return {
        ok: true,
        ticketNumber: body.ticketNumber ?? "",
        ticketToken: typeof body.ticketToken === "string" ? body.ticketToken : null,
      };
    } catch {
      return { ok: false, error: UNREACHABLE };
    }
  }

  /**
   * POST rather than GET so the ticket token never rides in a URL — request
   * paths land in access logs, and this string is the reporter's whole proof.
   */
  async fetchThread(ticketNumber: string, ticketToken: string): Promise<ThreadResult> {
    try {
      const res = await fetch(this.url("/v1/thread"), {
        method: "POST",
        headers: this.headers({ "content-type": "application/json" }),
        body: JSON.stringify({ ticketNumber, ticketToken }),
      });
      if (!res.ok) {
        const body: unknown = await res.json().catch(() => null);
        return {
          ok: false,
          error: errorSentence(body, "We couldn't load this ticket. Please try again."),
          gone: res.status === 404,
        };
      }
      const body = (await res.json()) as { ticket: ThreadTicket; messages: ThreadMessage[] };
      return { ok: true, ticket: body.ticket, messages: body.messages ?? [] };
    } catch {
      return { ok: false, error: UNREACHABLE, gone: false };
    }
  }

  async sendReply(
    ticketNumber: string,
    ticketToken: string,
    body: string,
  ): Promise<ReplyResult> {
    try {
      const res = await fetch(this.url("/v1/reply"), {
        method: "POST",
        headers: this.headers({ "content-type": "application/json" }),
        body: JSON.stringify({ ticketNumber, ticketToken, body }),
      });
      if (!res.ok) {
        const parsed: unknown = await res.json().catch(() => null);
        return { ok: false, error: errorSentence(parsed, "Your reply didn't go through. Please try again.") };
      }
      return { ok: true };
    } catch {
      return { ok: false, error: UNREACHABLE };
    }
  }
}
