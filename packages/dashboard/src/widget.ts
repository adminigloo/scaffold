import type { Glance } from "./glance.js";
import type { CardSize, DashboardLayout, LayoutCatalogEntry } from "./layout.js";

/**
 * The pictures a card's title bar can carry. Names only here (this file is
 * safe on the server); the drawings are in the UI. A small fixed set on
 * purpose: one look across every feature, and no icon library to install.
 */
export const ICON_NAMES = [
  "board",
  "chart",
  "phone",
  "alert",
  "building",
  "people",
  "shield",
  "search",
  "sparkle",
  "chat",
  "cart",
  "card",
  "receipt",
  "calendar",
  "file",
  "bell",
  "mail",
  "tag",
  "list",
  "link",
] as const;

export type IconName = (typeof ICON_NAMES)[number];

/** What a card's glance is told about who's looking, and when. */
export interface GlanceContext {
  readonly userId: string;
  readonly now: Date;
  /** Whether the viewer holds a staff key: a card may show more to some. */
  readonly can: (permission: string) => boolean;
}

/**
 * One card on offer. The app lists these (one per feature page it has), and
 * the catalog offers each to whoever holds `permission`: exactly the people
 * the sidebar would show its page to, so the dashboard can't become a way
 * around a permission.
 */
export interface DashboardWidget extends LayoutCatalogEntry {
  /** Stable forever once people have saved it: "feedback.board". */
  readonly key: string;
  readonly title: string;
  /** The sidebar heading it sits under: "Feedback". */
  readonly section: string;
  /** One line in the catalog: what the card tells you. */
  readonly description: string;
  readonly icon: IconName;
  /** The full page. */
  readonly href: string;
  /** The staff key that opens the full page. */
  readonly permission: string;
  readonly defaultOn?: boolean;
  readonly defaultSize?: CardSize;
  readonly defaultMain?: boolean;
  /** How often the card reloads itself while the page is open. 0: only when asked. */
  readonly refreshSeconds?: number;
  readonly glance: (ctx: GlanceContext) => Promise<Glance>;
}

/** A card as the browser sees it: everything but the code that fills it. */
export interface CatalogCard {
  readonly key: string;
  readonly title: string;
  readonly section: string;
  readonly description: string;
  readonly icon: IconName;
  readonly href: string;
  readonly defaultOn: boolean;
  readonly defaultSize: CardSize;
  readonly defaultMain: boolean;
  readonly refreshSeconds: number;
}

/** GET …/v1/board */
export interface BoardResponse {
  readonly catalog: readonly CatalogCard[];
  readonly layout: DashboardLayout;
  /** True when this person has arranged their dashboard (a row exists). */
  readonly saved: boolean;
  /** "unavailable": the table isn't there yet, so changes can't be saved. */
  readonly storage: "ok" | "unavailable";
}

/** One card's contents, or why there are none. */
export interface GlanceResult {
  readonly key: string;
  readonly glance?: Glance;
  readonly error?: string;
  /** When it was read, ISO. */
  readonly at: string;
}

/** GET …/v1/glances?keys=a,b */
export interface GlancesResponse {
  readonly results: readonly GlanceResult[];
}

/** Default card refresh, in seconds. */
export const DEFAULT_REFRESH_SECONDS = 120;

/**
 * Check an app's list once, when its handlers are built, so a mistake is a
 * thrown error at start-up instead of a card that silently never appears.
 */
export function checkWidgets(widgets: readonly DashboardWidget[]): void {
  const keys = new Set<string>();
  for (const widget of widgets) {
    if (!/^[a-z][a-z0-9-]*(\.[a-z0-9-]+)*$/.test(widget.key)) {
      throw new Error(`Dashboard card key "${widget.key}" must be lower case words joined by dots.`);
    }
    if (keys.has(widget.key)) throw new Error(`Dashboard card key "${widget.key}" is listed twice.`);
    keys.add(widget.key);
    if (!widget.href.startsWith("/")) throw new Error(`Dashboard card "${widget.key}": href must be a path on this site.`);
    if (!widget.permission) throw new Error(`Dashboard card "${widget.key}" needs the permission that opens its page.`);
    if (!(ICON_NAMES as readonly string[]).includes(widget.icon)) {
      throw new Error(`Dashboard card "${widget.key}": unknown icon "${widget.icon}".`);
    }
  }
}

export function toCatalogCard(widget: DashboardWidget): CatalogCard {
  return {
    key: widget.key,
    title: widget.title,
    section: widget.section,
    description: widget.description,
    icon: widget.icon,
    href: widget.href,
    defaultOn: widget.defaultOn ?? false,
    defaultSize: widget.defaultSize ?? "s",
    defaultMain: widget.defaultMain ?? false,
    refreshSeconds: widget.refreshSeconds ?? DEFAULT_REFRESH_SECONDS,
  };
}
