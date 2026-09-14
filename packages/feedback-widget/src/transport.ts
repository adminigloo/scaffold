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
 * the license key; every failure returns a value instead of throwing, because
 * a feedback tool that crashes the page it is reporting on has inverted its
 * job.
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

export class FeedbackTransport {
  constructor(
    private readonly baseUrl: string,
    private readonly clientKey: string,
  ) {}

  private url(path: string): string {
    return `${this.baseUrl.replace(/\/$/, "")}${path}`;
  }

  /** null on any failure — the caller falls back to its built-in category list. */
  async fetchCategories(): Promise<FeedbackCategoryOption[] | null> {
    try {
      const res = await fetch(this.url("/v1/config"), {
        headers: { [KEY_HEADER]: this.clientKey },
      });
      if (!res.ok) return null;
      const body = (await res.json()) as { categories?: FeedbackCategoryOption[] };
      return Array.isArray(body.categories) ? body.categories : null;
    } catch {
      return null;
    }
  }

  /** null on any failure, including a platform without storage — the report still submits. */
  async uploadScreenshot(dataUrl: string, kind: "screenshot" | "annotated"): Promise<string | null> {
    try {
      const form = new FormData();
      form.append("file", dataUrlToBlob(dataUrl));
      form.append("kind", kind);
      const res = await fetch(this.url("/v1/upload"), {
        method: "POST",
        headers: { [KEY_HEADER]: this.clientKey },
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
        headers: { [KEY_HEADER]: this.clientKey, "content-type": "application/json" },
        body: JSON.stringify(input),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        return { ok: false, error: body?.error ?? `submit failed (${res.status})` };
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
      return { ok: false, error: "could not reach the feedback service" };
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
        headers: { [KEY_HEADER]: this.clientKey, "content-type": "application/json" },
        body: JSON.stringify({ ticketNumber, ticketToken }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        return {
          ok: false,
          error: body?.error ?? `could not load the ticket (${res.status})`,
          gone: res.status === 404,
        };
      }
      const body = (await res.json()) as { ticket: ThreadTicket; messages: ThreadMessage[] };
      return { ok: true, ticket: body.ticket, messages: body.messages ?? [] };
    } catch {
      return { ok: false, error: "could not reach the feedback service", gone: false };
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
        headers: { [KEY_HEADER]: this.clientKey, "content-type": "application/json" },
        body: JSON.stringify({ ticketNumber, ticketToken, body }),
      });
      if (!res.ok) {
        const parsed = (await res.json().catch(() => null)) as { error?: string } | null;
        return { ok: false, error: parsed?.error ?? `reply failed (${res.status})` };
      }
      return { ok: true };
    } catch {
      return { ok: false, error: "could not reach the feedback service" };
    }
  }
}
