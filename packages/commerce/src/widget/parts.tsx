import { storeCss } from "./styles.js";

/** The screens' styles, inline (works in a server render and in the browser; a second copy is harmless). */
export function StoreStyles() {
  return <style data-adminigloo-store="">{storeCss}</style>;
}

/** A refusal's own words, or a fixed sentence (never a stack trace). */
export async function request<T>(url: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { cache: "no-store", ...init, headers: { ...(init?.body ? { "content-type": "application/json" } : {}), ...init?.headers } });
  } catch {
    throw new Error("We couldn't reach the server. Check your connection and try again.");
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (!res.ok) {
    const message = (body as { error?: { message?: unknown } } | null)?.error?.message;
    throw new Error(typeof message === "string" && message ? message : statusWords(res.status));
  }
  return body as T;
}

export function ErrorNote(props: { readonly message: string | null }) {
  return props.message ? (
    <p role="alert" className="aics-error">
      {props.message}
    </p>
  ) : null;
}

/** A date and time in the company's locale (default en-US), never the browser's. */
export function whenText(iso: string, locale = "en-US"): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  try {
    return date.toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" });
  } catch {
    return date.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
  }
}

/**
 * An answer that wasn't the package's own (a platform's error page, a proxy,
 * a timeout): what its HTTP status says, in plain words. The generic sentence
 * only when the status says nothing more (polish 3: no "Something went wrong"
 * where the cause is knowable).
 */
function statusWords(status: number, fallback = "Something went wrong. Please try again."): string {
  switch (status) {
    case 401:
      return "You've been signed out. Sign in again to keep working.";
    case 403:
      return "You don't have permission to do that.";
    case 404:
      return "That isn't here any more. Reload the page.";
    case 408:
    case 504:
      return "The site took too long to answer. Please try again in a minute.";
    case 413:
      return "That's too big to send.";
    case 429:
      return "That's a lot of tries in a short time. Wait a minute, then try again.";
    case 502:
    case 503:
      return "The site isn't answering right now. Please try again in a minute.";
    default:
      return fallback;
  }
}
