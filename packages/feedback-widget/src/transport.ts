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
  | { ok: true; ticketNumber: string }
  | { ok: false; error: string };

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
      const body = (await res.json()) as { ticketNumber?: string };
      return { ok: true, ticketNumber: body.ticketNumber ?? "" };
    } catch {
      return { ok: false, error: "could not reach the feedback service" };
    }
  }
}
