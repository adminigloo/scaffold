import { useMemo, type ReactNode } from "react";
import { WidgetRoot, type ChromeProps } from "../parts.js";
import { missingTransport } from "../transport.js";
import { CONSOLE, showingRange, W } from "../words.js";
import { createTenancyAdminClient, type TenancyAdminTransport } from "./client.js";
import { injectTenancyAdminStyles } from "./styles.js";

/**
 * The operator screens' building blocks: the root (both stylesheets), the
 * transport choice, and the pager.
 */

function injectAdminWithNonce(nonce?: string) {
  injectTenancyAdminStyles(nonce ? { nonce } : {});
}

export function AdminRoot({ children, data, ...chrome }: ChromeProps & { children: ReactNode; data?: Record<string, string | undefined> }) {
  return (
    <WidgetRoot
      theme={chrome.theme}
      nonce={chrome.nonce}
      className={chrome.className}
      style={chrome.style}
      extraClass="aitw-admin"
      extraStyles={injectAdminWithNonce}
      data={data}
    >
      {children}
    </WidgetRoot>
  );
}

/** `transport` wins over `baseUrl` (contract 8.1); with neither, every call answers one plain error. */
export function useAdminTransport(transport: TenancyAdminTransport | undefined, baseUrl: string | undefined): TenancyAdminTransport {
  return useMemo(
    () => transport ?? (baseUrl ? createTenancyAdminClient({ baseUrl }) : missingTransport<TenancyAdminTransport>()),
    [transport, baseUrl],
  );
}

/** "Showing 26–50 of 230" with Previous and Next, each disabled at its end. */
export function Pager({
  page,
  pageSize,
  total,
  busy,
  onPage,
}: {
  page: number;
  pageSize: number;
  total: number;
  busy?: boolean;
  onPage: (page: number) => void;
}) {
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, total);
  const last = Math.max(1, Math.ceil(total / pageSize));
  return (
    <nav className="aitw-pager" aria-label={CONSOLE.pages} data-aitw-pager="">
      <span className="aitw-pager-text">{showingRange(from, to, total)}</span>
      <span className="aitw-actions">
        <button type="button" className="aitw-btn aitw-btn-secondary aitw-btn-sm" disabled={busy || page <= 1} onClick={() => onPage(page - 1)}>
          {W.previous}
        </button>
        <button type="button" className="aitw-btn aitw-btn-secondary aitw-btn-sm" disabled={busy || page >= last} onClick={() => onPage(page + 1)}>
          {W.next}
        </button>
      </span>
    </nav>
  );
}

/** The page parameters a list screen keeps in the address bar, read once on mount. */
export function readSearch(): URLSearchParams | null {
  if (typeof window === "undefined") return null;
  try {
    return new URLSearchParams(window.location.search);
  } catch {
    return null;
  }
}

/**
 * Write the list's state into the address bar without a navigation, so a
 * refresh or a shared link reopens the same view. Values equal to their
 * default are left out: the plain URL means the plain view.
 */
export function writeSearch(values: Record<string, string | number | boolean | null | undefined>, defaults: Record<string, string | number | boolean>): void {
  if (typeof window === "undefined" || typeof window.history?.replaceState !== "function") return;
  try {
    const url = new URL(window.location.href);
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined || value === null || value === "" || value === defaults[key]) url.searchParams.delete(key);
      else url.searchParams.set(key, String(value));
    }
    const next = `${url.pathname}${url.search}${url.hash}`;
    if (next !== `${window.location.pathname}${window.location.search}${window.location.hash}`) {
      window.history.replaceState(window.history.state, "", next);
    }
  } catch {
    /* an odd host URL: the view still works, it just isn't in the address bar */
  }
}

/** A positive whole number from the address bar, else the fallback. */
export function pageParam(value: string | null, fallback = 1): number {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 ? n : fallback;
}
