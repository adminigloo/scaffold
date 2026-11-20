import { and, count, eq, gte, ne } from "drizzle-orm";
import { listChangeLog, type ChangeLogRow } from "@adminigloo/assistant";
import { assistantConversations, assistantDrafts } from "@adminigloo/assistant/schema";
import { ago, plural, type Glance } from "../glance.js";
import type { DashboardDb } from "../handlers.js";

/**
 * The glance over @adminigloo/assistant: the site's own AI assistant.
 *
 * NO SPEND TILE. The package has no table for it: `AssistantUsage` (monthly
 * messages and cents used) is computed by the HOST APP's own `allowance`
 * callback from whatever it meters spend with (on the reference site,
 * @adminigloo/ai — a different package), never written into
 * @adminigloo/assistant's own schema. A spend number here would have to be
 * invented or imported from a package this glance has no business reading,
 * so it is left out rather than guessed.
 *
 * NO CUSTOMER QUESTION TEXT, ANYWHERE. Only row counts and the change log's
 * own metadata (what changed, who changed it, when) are read — never
 * `assistant_messages.blocks` or a conversation's content.
 */
export interface AssistantGlanceInput {
  readonly db: DashboardDb;
  readonly now: Date;
  /** This assistant's own tenant id. The site passes its own ("*", `ASSISTANT_PLATFORM`). */
  readonly tenantId: string;
  /** The full page. */
  readonly href?: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const CONVERSATION_WINDOW_DAYS = 7;

/** entityType -> what a business owner calls it (brain.ts's own vocabulary). */
const ENTITY_LABELS: Record<string, string> = {
  section: "Section",
  tenant_rule: "House rule",
  glossary: "Glossary term",
  faq: "Question",
};

export async function assistantGlance(input: AssistantGlanceInput): Promise<Glance> {
  const { db, now, tenantId } = input;
  const href = input.href ?? "/admin/assistant";
  const changesHref = "/admin/assistant/changes";
  const since = new Date(now.getTime() - CONVERSATION_WINDOW_DAYS * DAY_MS);

  const [conversationRows, draftRows, changeLog] = await Promise.all([
    db
      .select({ n: count() })
      .from(assistantConversations)
      .where(and(eq(assistantConversations.tenantId, tenantId), gte(assistantConversations.createdAt, since))),
    // A draft is "waiting for approval" until it is published (or discarded
    // back to nothing); `assistant_drafts.status` walks draft -> testing ->
    // applied, so anything short of "applied" still needs a person.
    db
      .select({ n: count() })
      .from(assistantDrafts)
      .where(and(eq(assistantDrafts.tenantId, tenantId), ne(assistantDrafts.status, "applied"))),
    // The package's own reader (brain.ts): one cheap, indexed query, newest
    // first, already scoped to this company.
    listChangeLog(db, tenantId, 6),
  ]);

  const conversations = conversationRows[0]?.n ?? 0;
  const changesWaiting = draftRows[0]?.n ?? 0;

  return {
    status:
      changesWaiting > 0
        ? { text: `${plural(changesWaiting, "change")} waiting to be published.`, tone: "warn" }
        : { text: `${plural(conversations, "conversation")} in the last ${CONVERSATION_WINDOW_DAYS} days.`, tone: "neutral" },
    attention: changesWaiting,
    tiles: [
      {
        label: "Conversations",
        value: conversations,
        href,
        hint: `Started in the last ${CONVERSATION_WINDOW_DAYS} days.`,
      },
      {
        label: "Changes waiting",
        value: changesWaiting,
        href,
        tone: changesWaiting > 0 ? "warn" : undefined,
        hint: "Drafted, not yet published.",
      },
    ],
    list: {
      title: "Latest changes",
      empty: "No changes yet.",
      rows: changeLog.map((row) => ({
        title: titleFor(row),
        badge: ENTITY_LABELS[row.entityType] ?? row.entityType,
        meta: ago(row.createdAt, now),
        tone: row.action === "deactivated" ? "warn" : row.action === "created" ? "good" : "neutral",
        href: changesHref,
      })),
    },
    link: { href, label: "Open the assistant" },
  };
}

/** Prefers the change's own summary ("rolled back to v3", a rule's label) over the bare action word. */
function titleFor(row: ChangeLogRow): string {
  const summary = row.changeSummary?.trim();
  if (summary && summary.length > 0 && summary.toLowerCase() !== row.action.toLowerCase()) {
    return summary.charAt(0).toUpperCase() + summary.slice(1);
  }
  return row.action.length === 0 ? row.action : row.action.charAt(0).toUpperCase() + row.action.slice(1).replace(/_/g, " ");
}
