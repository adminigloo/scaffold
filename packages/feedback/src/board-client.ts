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
 */

export interface FeedbackColumnWire {
  id: string;
  key: string;
  label: string;
  color: string | null;
  sortOrder: number;
  isTerminal: boolean;
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

export interface FeedbackBoardWire {
  statuses: FeedbackColumnWire[];
  tickets: FeedbackTicketWire[];
  archivableCount: number;
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

export class FeedbackAdminClient {
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

  board(options: { archived?: boolean } = {}): Promise<FeedbackBoardWire> {
    return this.call("GET", `board${options.archived ? "?archived=1" : ""}`);
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
    patch: Partial<Pick<FeedbackColumnWire, "label" | "color" | "isTerminal" | "wipLimit" | "agingWarnHours" | "agingStaleHours">>,
  ): Promise<void> {
    await this.call("POST", `columns/${encodeURIComponent(id)}`, patch);
  }
  async deleteColumn(id: string): Promise<void> {
    await this.call("POST", `columns/${encodeURIComponent(id)}/delete`, {});
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
