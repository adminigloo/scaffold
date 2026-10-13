/**
 * The setup checklist's types (contract 5.4). The three items Tenancy 1
 * ships live in `./server` (`tenancyChecklistItems`), because their "done"
 * predicates read counts from the database.
 *
 * WHY A REGISTRY OF ITEMS. "Finish setting up" is a list every package wants
 * to add to (scheduling's "Set your hours", the estimator's "Add your price
 * list"). Each item says what it is, where to do it, who sees it and how to
 * tell it's done; the project composes them once, and the owner sees one list.
 */

export interface ChecklistContext {
  /** The server's database handle (typed in ./server). */
  readonly db: unknown;
  readonly tenantId: string;
  readonly company: {
    readonly name: string;
    readonly slug: string;
    readonly logoUrl: string | null;
    readonly brandColor: string | null;
  };
  /** Parsed registry values. */
  readonly settings: Readonly<Record<string, unknown>>;
  readonly counts: { readonly activeMembers: number; readonly invitationsEverSent: number };
}

export interface SetupChecklistItem {
  /** "company.details"; /^[a-z][a-z0-9.-]{1,63}$/. Permanent: dismissals are stored by key. */
  readonly key: string;
  readonly title: string;
  readonly description: string;
  /** The link's words: "Add details". */
  readonly actionLabel: string;
  /** Where to do it, a host path. */
  readonly href: string;
  readonly order: number;
  /** Only people holding it see the item; default "tenant.edit". */
  readonly permission?: string;
  isDone(ctx: ChecklistContext): boolean | Promise<boolean>;
}

export interface SetupChecklist {
  /** Sorted by order, then key. */
  readonly items: readonly SetupChecklistItem[];
}

export class DuplicateChecklistItemError extends Error {
  readonly name = "DuplicateChecklistItemError";
}

export class InvalidChecklistItemError extends Error {
  readonly name = "InvalidChecklistItemError";
}

const ITEM_KEY = /^[a-z][a-z0-9.-]{1,63}$/;

/** Compose the project's checklist. Throws on a repeated or malformed key. */
export function defineSetupChecklist(items: readonly SetupChecklistItem[]): SetupChecklist {
  const seen = new Set<string>();
  for (const item of items) {
    if (!ITEM_KEY.test(item.key)) {
      throw new InvalidChecklistItemError(
        `Checklist item key "${item.key}" must be 2-64 characters of lowercase letters, digits, dots and dashes, starting with a letter.`,
      );
    }
    if (seen.has(item.key)) {
      throw new DuplicateChecklistItemError(
        `Two checklist items use the key "${item.key}". Dismissals are stored by key, so one item would hide the other. Rename one.`,
      );
    }
    seen.add(item.key);
  }
  return { items: [...items].sort((a, b) => a.order - b.order || a.key.localeCompare(b.key)) };
}
