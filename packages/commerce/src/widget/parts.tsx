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
    throw new Error(typeof message === "string" && message ? message : "Something went wrong. Please try again.");
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
