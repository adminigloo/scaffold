/**
 * The reporter's own record of what they sent — localStorage, because that is
 * the entire identity model. A reporter has no account on the feedback
 * platform (deliberately: the person reporting a sign-in problem is the
 * person who cannot sign in), so "my reports" can only mean "reports this
 * browser sent", and the per-ticket token stored here is the capability that
 * proves it. Clearing site data forgets them; that is the honest cost of
 * having no account, and the tickets themselves live on unharmed staff-side.
 *
 * Every function here swallows storage failures. Private browsing modes and
 * enterprise policies make localStorage throw, and a feedback tool that
 * crashes the page it reports on has inverted its job — the same rule the
 * transport follows. Degraded means: submit still works, follow-up is lost.
 */

export interface StoredReport {
  ticketNumber: string;
  /** First line of the description, so the list reads as more than numbers. */
  title: string;
  /** The `aft_…` capability from the submit response — this browser's proof. */
  token: string;
  createdAt: number;
}

/** Enough for a person; an unbounded list is a slow JSON.parse on every open. */
const MAX_STORED = 20;

/**
 * Keyed per install so two apps on one origin (or one app pointed at two
 * platforms during a migration) keep separate lists. The suffix is the tail
 * of the client key — already visible in every request this page makes, so
 * it discloses nothing the network tab does not.
 */
function storageKey(clientKey: string): string {
  return `aif-reports-${clientKey.slice(-8)}`;
}

function isStoredReport(value: unknown): value is StoredReport {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record["ticketNumber"] === "string" &&
    typeof record["title"] === "string" &&
    typeof record["token"] === "string" &&
    typeof record["createdAt"] === "number"
  );
}

/** Newest first. Empty on any failure, including a corrupted entry. */
export function loadReports(clientKey: string): StoredReport[] {
  try {
    const raw = localStorage.getItem(storageKey(clientKey));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isStoredReport);
  } catch {
    return [];
  }
}

export function saveReport(clientKey: string, report: StoredReport): StoredReport[] {
  const next = [
    report,
    ...loadReports(clientKey).filter((r) => r.ticketNumber !== report.ticketNumber),
  ].slice(0, MAX_STORED);
  try {
    localStorage.setItem(storageKey(clientKey), JSON.stringify(next));
  } catch {
    // Storage refused; the in-memory list still serves this session.
  }
  return next;
}

/** For a ticket the platform no longer recognises — deleted, or another install's. */
export function removeReport(clientKey: string, ticketNumber: string): StoredReport[] {
  const next = loadReports(clientKey).filter((r) => r.ticketNumber !== ticketNumber);
  try {
    localStorage.setItem(storageKey(clientKey), JSON.stringify(next));
  } catch {
    // Same rule as above.
  }
  return next;
}
