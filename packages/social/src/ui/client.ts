import type { PostEdit } from "../types.js";
import type { CardFormatSet, ComposeWire, QueueWire } from "../wire.js";
import type { ActionResult, QueueActions } from "./PostCard.js";

/**
 * THE SCREENS' WAY TO THE HANDLER (social 0.1): plain fetches to the routes
 * of @adminigloo/social/server's handler, wherever the app mounted it
 * (`baseUrl`: "/api/app/{company id}/posts", "/api/admin/posts"). Every
 * refusal comes back as the server's own sentence (`{ error }`), never a
 * throw, so a card shows "Paste the post's own link" rather than a stack.
 */

type Answer<T> = { readonly ok: true; readonly body: T } | { readonly ok: false; readonly message: string };

/** A sentence for an answer that isn't the handler's own (a proxy's page, a timeout), by its status. */
function statusWords(status: number): string {
  if (status === 401) return "You're signed out. Sign in again, then try that again.";
  if (status === 403) return "You don't have permission to do that.";
  if (status === 404) return "That isn't here any more. Reload the page.";
  if (status === 409) return "That post has changed. Reload the page.";
  if (status === 413) return "That's too much to send at once.";
  if (status === 429) return "Too many tries. Wait a minute and try again.";
  if (status === 502 || status === 503) return "The site isn't answering right now. Try again in a minute.";
  if (status === 504) return "The site took too long to answer. Try again.";
  return "That didn't work. Try again.";
}

async function call<T>(fetcher: typeof fetch, url: string, init?: RequestInit): Promise<Answer<T>> {
  let res: Response;
  try {
    res = await fetcher(url, { cache: "no-store", credentials: "same-origin", ...init, headers: { ...(init?.body ? { "content-type": "application/json" } : {}), ...(init?.headers ?? {}) } });
  } catch {
    return { ok: false, message: "We couldn't reach the server. Check your internet connection and try again." };
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (!res.ok) {
    const message = (body as { error?: { message?: unknown } } | null)?.error?.message;
    return { ok: false, message: typeof message === "string" && message ? message : statusWords(res.status) };
  }
  return { ok: true, body: body as T };
}

export interface SocialClient {
  /** The queue as the page shows it. Throws with a sentence when it can't be read. */
  readonly queue: () => Promise<QueueWire>;
  /** Every card format, as samples. */
  readonly cardFormats: () => Promise<readonly CardFormatSet[]>;
  /** What the cards' buttons do. */
  readonly actions: QueueActions;
  /** A post from a person's own facts. */
  readonly compose: (input: { readonly facts: string; readonly link: string; readonly hashtags?: string }) => Promise<ActionResult | { readonly written: ComposeWire }>;
  /** The posting session's list (JSON), for a link. */
  readonly approvedUrl: string;
}

export function createSocialClient(baseUrl: string, fetcher: typeof fetch = (input, init) => fetch(input, init)): SocialClient {
  const base = baseUrl.replace(/\/+$/, "");
  const post = (path: string, body: unknown) => call<unknown>(fetcher, `${base}/v1/admin/${path}`, { method: "POST", body: JSON.stringify(body) });
  const done = (answer: Answer<unknown>): ActionResult => (answer.ok ? undefined : { error: answer.message });
  const id = (value: string) => encodeURIComponent(value);
  return {
    approvedUrl: `${base}/v1/admin/approved`,
    async queue() {
      const answer = await call<QueueWire>(fetcher, `${base}/v1/admin/posts`);
      if (!answer.ok) throw new Error(answer.message);
      return answer.body;
    },
    async cardFormats() {
      const answer = await call<{ sets: readonly CardFormatSet[] }>(fetcher, `${base}/v1/admin/card-formats`);
      if (!answer.ok) throw new Error(answer.message);
      return answer.body.sets ?? [];
    },
    actions: {
      save: async (postId: string, edit: PostEdit) => done(await post(`posts/${id(postId)}`, edit)),
      approve: async (ids: string[]) => done(await post("approve", { ids })),
      markPosted: async (postId: string, url: string) => done(await post(`posts/${id(postId)}/posted`, { url })),
      skip: async (postId: string) => done(await post(`posts/${id(postId)}/skip`, {})),
    },
    async compose(input) {
      const answer = await call<ComposeWire>(fetcher, `${base}/v1/admin/compose`, { method: "POST", body: JSON.stringify({ facts: input.facts, link: input.link, hashtags: input.hashtags ?? "" }) });
      return answer.ok ? { written: answer.body } : { error: answer.message };
    },
  };
}
