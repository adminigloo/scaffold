/**
 * The browser's side of the staff routes (0.10.0): one method per route of
 * FEEDBACK_ADMIN_ROUTES, over `fetch`, against a base URL —
 *
 *   new FeedbackAdminClient(`/api/app/${company.id}/feedback`)   a company's board
 *   new FeedbackAdminClient("/api/admin/feedback")               the platform's own
 *
 * — so a company's page and the platform's page drive the same component
 * through the same client, and only the address differs. Same-origin, cookie
 * credentials, no-store. A refusal throws `FeedbackAdminError` carrying the
 * server's own plain sentence, which the screens show as it is.
 *
 * 0.12.0: the epics — list, read, make, edit, move along, fill and delete.
 *
 * 0.11.0: the board read takes the filters (board-filters.ts, the same names
 * the address bar carries), and the client gains New ticket, editing, the
 * activity trail and the company's people. The settings screens (./admin)
 * take any object with the editors' methods — `FeedbackSettingsTransport` —
 * so a host with its own API can drive them without these routes.
 */

import { EMPTY_FILTERS, filtersToSearchParams, type BoardFilters } from "./board-filters";
import type { EpicBucket, EpicProgress, EpicStatus } from "./epic-core";

export interface FeedbackColumnWire {
  id: string;
  key: string;
  label: string;
  color: string | null;
  sortOrder: number;
  isTerminal: boolean;
  /** Work here waits on someone else (0.12.0): an epic counts these tickets as waiting. */
  isWaiting?: boolean;
  wipLimit: number | null;
  agingWarnHours: number | null;
  agingStaleHours: number | null;
  allowAiTransition: boolean;
  /** How many tickets sit in it (the columns list only). */
  ticketCount?: number;
}

export interface FeedbackTicketWire {
  id: string;
  ticketNumber: string;
  title: string;
  priority: string;
  category: string | null;
  status: string;
  assignee: string | null;
  /** The host's id of the assignee, when picked from the company's people (0.11.0). */
  assigneeId?: string | null;
  /** "widget" | "page" | "staff" (0.11.0). */
  source?: string;
  /** False: the reporter isn't emailed about it (a team ticket filed without "tell them"). */
  notifyReporter?: boolean;
  /** The epic it's part of (0.12.0), one of `FeedbackBoardWire.epics`. */
  epicId?: string | null;
  reporterName: string | null;
  reporterEmail: string | null;
  pagePathname: string | null;
  screenshotUrl: string | null;
  annotatedScreenshotUrl: string | null;
  createdAt: string;
  statusChangedAt: string | null;
  archivedAt: string | null;
  archivedBy: string | null;
  hasUnreadReporterReply: boolean;
}

/** Per-option counts with every OTHER filter applied; "__none" counts the empty value. */
export interface FeedbackFacetsWire {
  status: Record<string, number>;
  priority: Record<string, number>;
  category: Record<string, number>;
  assignee: Record<string, number>;
  /** Per epic id, and "__none" for no epic (0.12.0). */
  epic?: Record<string, number>;
  source: Record<string, number>;
}

/** An epic as the board carries it (0.12.0): the badge, the filter, the pickers. */
export interface FeedbackBoardEpicWire {
  id: string;
  name: string;
  color: string;
  status: EpicStatus;
}

export interface FeedbackBoardWire {
  statuses: FeedbackColumnWire[];
  tickets: FeedbackTicketWire[];
  /** The company's epics, every status (0.12.0). */
  epics?: FeedbackBoardEpicWire[];
  archivableCount: number;
  /** 0.11.0: the board's size, the filtered size, whether some matches were left out, and the option counts. */
  totalCount?: number;
  matchCount?: number;
  truncated?: boolean;
  facets?: FeedbackFacetsWire;
}

/** One line of a ticket's activity trail (0.11.0). */
export interface FeedbackEventWire {
  id: string;
  ticketId: string;
  kind: "created" | "title" | "priority" | "category" | "assignee" | "status" | "archived" | "unarchived" | "epic";
  fromValue: string | null;
  toValue: string | null;
  actorId: string | null;
  actorName: string;
  createdAt: string;
}

/** Someone a ticket can be assigned to (0.11.0). */
export interface FeedbackPersonWire {
  id: string;
  name: string;
}

/** What the team fills in on "New ticket" (0.11.0). */
export interface NewTicketInput {
  title: string;
  description?: string;
  priority?: "low" | "medium" | "high" | "critical";
  category?: string | null;
  /** A column's key; absent = the board's first unfinished column. */
  status?: string;
  assigneeId?: string | null;
  reporterName?: string | null;
  reporterEmail?: string | null;
  /** Email the customer when the team replies or moves it. Off unless chosen: they never used the form. */
  tellReporter?: boolean;
  /** The epic it's part of (0.12.0). */
  epicId?: string | null;
}

/** What the ticket editor changes (0.11.0). Absent = unchanged; null clears. */
export interface TicketPatch {
  title?: string;
  priority?: "low" | "medium" | "high" | "critical";
  category?: string | null;
  assigneeId?: string | null;
  /** The epic it's part of (0.12.0); null takes it out. */
  epicId?: string | null;
}

/** An epic as the epics list shows it (0.12.0): with its progress. */
export interface FeedbackEpicWire {
  id: string;
  name: string;
  description: string | null;
  status: EpicStatus;
  ownerId: string | null;
  ownerName: string | null;
  /** "YYYY-MM-DD", or null. */
  targetDate: string | null;
  color: string;
  completedAt: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  progress: EpicProgress;
}

/** One of an epic's tickets, with the bucket its progress counts it in. */
export interface FeedbackEpicTicketWire {
  id: string;
  ticketNumber: string;
  title: string;
  status: string;
  statusLabel: string;
  priority: string;
  assignee: string | null;
  archivedAt: string | null;
  createdAt: string;
  bucket: EpicBucket;
}

export interface FeedbackEpicDetailWire extends FeedbackEpicWire {
  tickets: FeedbackEpicTicketWire[];
  truncated: boolean;
}

/** What the epic form sends (0.12.0). `ownerId`: one of the company's people, or null for nobody. */
export interface EpicInput {
  name?: string;
  description?: string | null;
  targetDate?: string | null;
  color?: string;
  ownerId?: string | null;
}

export interface FeedbackTicketDetailWire extends FeedbackTicketWire {
  description: string;
  context: Record<string, unknown> | null;
  errors: Array<Record<string, unknown>>;
}

export interface FeedbackMessageWire {
  id: string;
  ticketId: string;
  senderType: "staff" | "reporter" | "system";
  senderName: string;
  body: string;
  createdAt: string;
}

export interface FeedbackCategoryWire {
  id: string;
  key: string;
  label: string;
  description: string | null;
  sortOrder: number;
  showToCustomer: boolean;
}

export interface FeedbackKeyWire {
  id: string;
  label: string;
  createdAt: string;
  revokedAt: string | null;
}

/**
 * What the settings screens (./admin) need, and nothing else (0.11.0): the
 * columns, the categories and the website keys. `FeedbackAdminClient` is one;
 * a host whose tickets live in its own tables passes its own.
 */
export interface FeedbackSettingsTransport {
  columns(): Promise<FeedbackColumnWire[]>;
  createColumn(input: { key: string; label: string; color?: string | null; isTerminal?: boolean }): Promise<FeedbackColumnWire>;
  updateColumn(
    id: string,
    patch: Partial<Pick<FeedbackColumnWire, "label" | "color" | "isTerminal" | "isWaiting" | "wipLimit" | "agingWarnHours" | "agingStaleHours">>,
  ): Promise<void>;
  /** `moveTo`: another column's key, for the tickets in this one. */
  deleteColumn(id: string, moveTo?: string | null): Promise<void>;
  reorderColumns(ids: readonly string[]): Promise<void>;
  categories(): Promise<FeedbackCategoryWire[]>;
  createCategory(input: { key: string; label: string; description?: string | null }): Promise<FeedbackCategoryWire>;
  updateCategory(id: string, patch: Partial<Pick<FeedbackCategoryWire, "label" | "description" | "showToCustomer">>): Promise<void>;
  deleteCategory(id: string): Promise<void>;
  reorderCategories(ids: readonly string[]): Promise<void>;
  keys?(): Promise<FeedbackKeyWire[]>;
  issueKey?(label: string): Promise<FeedbackKeyWire & { secret: string }>;
  revokeKey?(id: string): Promise<void>;
}

/** A refused request, with the server's sentence. `status` 401 means signed out. */
export class FeedbackAdminError extends Error {
  readonly name = "FeedbackAdminError";
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
  }
}

export interface FeedbackAdminClientOptions {
  /** A fetch to use instead of the global one (tests, a server-side caller). */
  readonly fetch?: typeof fetch;
}

export class FeedbackAdminClient implements FeedbackSettingsTransport {
  private readonly base: string;
  private readonly fetcher: typeof fetch;

  constructor(baseUrl: string, options: FeedbackAdminClientOptions = {}) {
    this.base = baseUrl.replace(/\/+$/, "");
    this.fetcher = options.fetch ?? ((input, init) => fetch(input, init));
  }

  private async call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await this.fetcher(`${this.base}/v1/admin/${path}`, {
        method,
        credentials: "same-origin",
        cache: "no-store",
        headers: method === "POST" ? { "content-type": "application/json" } : {},
        ...(method === "POST" ? { body: JSON.stringify(body ?? {}) } : {}),
      });
    } catch {
      throw new FeedbackAdminError("Couldn't reach the server. Check your connection and try again.", 0, "offline");
    }
    const text = await res.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    if (!res.ok) {
      const error = (parsed as { error?: { code?: string; message?: string } | string } | null)?.error;
      const message =
        typeof error === "string"
          ? error
          : error?.message ?? (res.status === 401 ? "You've been signed out. Sign in again to keep working." : "Something went wrong. Please try again.");
      const code = typeof error === "object" && error?.code ? error.code : res.status === 401 ? "signed_out" : "error";
      throw new FeedbackAdminError(message, res.status, code);
    }
    return parsed as T;
  }

  /** The board, filtered on the server (0.11.0). `archived` is kept for 0.10 callers. */
  board(options: { archived?: boolean; filters?: Partial<BoardFilters> } = {}): Promise<FeedbackBoardWire> {
    const filters: BoardFilters = { ...EMPTY_FILTERS, ...(options.filters ?? {}) };
    if (options.archived) filters.archived = true;
    const query = filtersToSearchParams(filters).toString();
    return this.call("GET", `board${query ? `?${query}` : ""}`);
  }
  /** File a ticket from the board (0.11.0). */
  async createTicket(input: NewTicketInput): Promise<{ id: string; ticketNumber: string; title: string; status: string }> {
    return (await this.call<{ ticket: { id: string; ticketNumber: string; title: string; status: string } }>("POST", "tickets", input)).ticket;
  }
  /** Change a ticket's title, priority, category or assignee (0.11.0). */
  async updateTicket(id: string, patch: TicketPatch): Promise<void> {
    await this.call("POST", `tickets/${encodeURIComponent(id)}`, patch);
  }
  async events(id: string): Promise<FeedbackEventWire[]> {
    return (await this.call<{ events: FeedbackEventWire[] }>("GET", `tickets/${encodeURIComponent(id)}/events`)).events;
  }
  /** Who tickets can be assigned to, and which of them is the viewer (`me`). */
  people(): Promise<{ people: FeedbackPersonWire[]; me: string | null }> {
    return this.call("GET", "people");
  }
  async ticket(id: string): Promise<FeedbackTicketDetailWire> {
    return (await this.call<{ ticket: FeedbackTicketDetailWire }>("GET", `tickets/${encodeURIComponent(id)}`)).ticket;
  }
  async messages(id: string): Promise<FeedbackMessageWire[]> {
    return (await this.call<{ messages: FeedbackMessageWire[] }>("GET", `tickets/${encodeURIComponent(id)}/messages`)).messages;
  }
  async reply(id: string, body: string): Promise<FeedbackMessageWire> {
    return (await this.call<{ message: FeedbackMessageWire }>("POST", `tickets/${encodeURIComponent(id)}/messages`, { body })).message;
  }
  async assign(id: string, assignee: string | null): Promise<void> {
    await this.call("POST", `tickets/${encodeURIComponent(id)}/assign`, { assignee });
  }
  async move(id: string, status: string): Promise<void> {
    await this.call("POST", `tickets/${encodeURIComponent(id)}/move`, { status });
  }
  /** `failed`: the asked-for tickets that didn't land (not on this board any more). */
  async moveMany(ticketIds: readonly string[], status: string): Promise<{ moved: number; failed: string[] }> {
    const result = await this.call<{ moved: number; landed: string[] }>("POST", "tickets/move", { ticketIds, status });
    const landed = new Set(result.landed);
    return { moved: result.moved, failed: ticketIds.filter((id) => !landed.has(id)) };
  }
  async archive(id: string): Promise<void> {
    await this.call("POST", `tickets/${encodeURIComponent(id)}/archive`, {});
  }
  async unarchive(id: string): Promise<void> {
    await this.call("POST", `tickets/${encodeURIComponent(id)}/unarchive`, {});
  }
  archiveDone(): Promise<{ archived: number }> {
    return this.call("POST", "archive-done", {});
  }
  async markRead(id: string): Promise<void> {
    await this.call("POST", `tickets/${encodeURIComponent(id)}/read`, {});
  }

  async columns(): Promise<FeedbackColumnWire[]> {
    return (await this.call<{ columns: FeedbackColumnWire[] }>("GET", "columns")).columns;
  }
  async createColumn(input: {
    key: string;
    label: string;
    color?: string | null;
    isTerminal?: boolean;
  }): Promise<FeedbackColumnWire> {
    return (await this.call<{ column: FeedbackColumnWire }>("POST", "columns", input)).column;
  }
  async updateColumn(
    id: string,
    patch: Partial<Pick<FeedbackColumnWire, "label" | "color" | "isTerminal" | "isWaiting" | "wipLimit" | "agingWarnHours" | "agingStaleHours">>,
  ): Promise<void> {
    await this.call("POST", `columns/${encodeURIComponent(id)}`, patch);
  }
  async deleteColumn(id: string, moveTo?: string | null): Promise<void> {
    await this.call("POST", `columns/${encodeURIComponent(id)}/delete`, moveTo ? { moveTo } : {});
  }
  async reorderColumns(ids: readonly string[]): Promise<void> {
    await this.call("POST", "columns-order", { ids });
  }

  async categories(): Promise<FeedbackCategoryWire[]> {
    return (await this.call<{ categories: FeedbackCategoryWire[] }>("GET", "categories")).categories;
  }
  async createCategory(input: { key: string; label: string; description?: string | null }): Promise<FeedbackCategoryWire> {
    return (await this.call<{ category: FeedbackCategoryWire }>("POST", "categories", input)).category;
  }
  async updateCategory(id: string, patch: Partial<Pick<FeedbackCategoryWire, "label" | "description" | "showToCustomer">>): Promise<void> {
    await this.call("POST", `categories/${encodeURIComponent(id)}`, patch);
  }
  async deleteCategory(id: string): Promise<void> {
    await this.call("POST", `categories/${encodeURIComponent(id)}/delete`, {});
  }
  async reorderCategories(ids: readonly string[]): Promise<void> {
    await this.call("POST", "categories-order", { ids });
  }

  // --- Epics (0.12.0) -------------------------------------------------------

  async epics(): Promise<FeedbackEpicWire[]> {
    return (await this.call<{ epics: FeedbackEpicWire[] }>("GET", "epics")).epics;
  }
  async epic(id: string): Promise<FeedbackEpicDetailWire> {
    return (await this.call<{ epic: FeedbackEpicDetailWire }>("GET", `epics/${encodeURIComponent(id)}`)).epic;
  }
  async createEpic(input: EpicInput & { name: string }): Promise<FeedbackEpicWire> {
    return (await this.call<{ epic: FeedbackEpicWire }>("POST", "epics", input)).epic;
  }
  async updateEpic(id: string, patch: EpicInput): Promise<void> {
    await this.call("POST", `epics/${encodeURIComponent(id)}`, patch);
  }
  /** Only the moves EPIC_TRANSITIONS allows; anything else is refused with a sentence. */
  async setEpicStatus(id: string, status: EpicStatus): Promise<void> {
    await this.call("POST", `epics/${encodeURIComponent(id)}/status`, { status });
  }
  /** Put tickets in and take others out, in one change. */
  setEpicTickets(id: string, change: { add?: readonly string[]; remove?: readonly string[] }): Promise<{ added: number; movedFromOther: number; removed: number }> {
    return this.call("POST", `epics/${encodeURIComponent(id)}/tickets`, { add: change.add ?? [], remove: change.remove ?? [] });
  }
  /** Its tickets stay on the board and leave the epic. */
  deleteEpic(id: string): Promise<{ deleted: true; detached: number }> {
    return this.call("POST", `epics/${encodeURIComponent(id)}/delete`, {});
  }

  async keys(): Promise<FeedbackKeyWire[]> {
    return (await this.call<{ keys: FeedbackKeyWire[] }>("GET", "keys")).keys;
  }
  /** The new key, with its secret — shown once, never again. */
  async issueKey(label: string): Promise<FeedbackKeyWire & { secret: string }> {
    return (await this.call<{ key: FeedbackKeyWire & { secret: string } }>("POST", "keys", { label })).key;
  }
  async revokeKey(id: string): Promise<void> {
    await this.call("POST", `keys/${encodeURIComponent(id)}/revoke`, {});
  }
}
