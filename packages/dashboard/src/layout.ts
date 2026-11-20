/**
 * ONE PERSON'S DASHBOARD: which cards are on it, in what order, how wide, and
 * which one is starred to lead the page.
 *
 * Saved on the server, whole, for each person: it follows them to another
 * computer, and two people sharing one never see each other's. Pure functions
 * only, so the browser and the server apply the same rules: the browser to
 * answer a click at once, the server to refuse anything the person may not
 * have.
 */

/** Card widths: one column, two columns, the whole row. */
export type CardSize = "s" | "m" | "l";

export const CARD_SIZES: readonly CardSize[] = ["s", "m", "l"];

export interface LayoutItem {
  readonly key: string;
  readonly size: CardSize;
}

export interface DashboardLayout {
  readonly v: 1;
  /** The starred card, drawn first and larger. Null: no card is starred. */
  readonly main: string | null;
  /** The cards that are on, in order. */
  readonly items: readonly LayoutItem[];
  /**
   * Every card this person could choose from when they last saved. A card
   * that's on by default and isn't in here is new since then (a feature
   * installed, or a permission granted), so it joins their dashboard instead
   * of waiting, unseen, in the catalog. One they turned off is in here, so it
   * stays off.
   */
  readonly known: readonly string[];
}

/** What the layout rules need to know about each card on offer. */
export interface LayoutCatalogEntry {
  readonly key: string;
  readonly defaultOn?: boolean;
  readonly defaultSize?: CardSize;
  /** Starred on a dashboard nobody has arranged yet. The first one wins. */
  readonly defaultMain?: boolean;
}

/** The most cards one dashboard holds. */
export const MAX_CARDS = 40;

export function isCardSize(value: unknown): value is CardSize {
  return CARD_SIZES.includes(value as CardSize);
}

/** The dashboard of someone who has never arranged theirs. */
export function defaultLayout(catalog: readonly LayoutCatalogEntry[]): DashboardLayout {
  const items = catalog
    .filter((entry) => entry.defaultOn)
    .slice(0, MAX_CARDS)
    .map((entry) => ({ key: entry.key, size: entry.defaultSize ?? "s" }));
  const main = catalog.find((entry) => entry.defaultOn && entry.defaultMain)?.key ?? items[0]?.key ?? null;
  return { v: 1, main, items, known: catalog.map((entry) => entry.key) };
}

/**
 * Whatever was saved (or sent), made safe against what this person may have
 * NOW: cards they can't open are dropped, duplicates and unknown sizes fixed,
 * a star on a card that isn't on cleared, and new default cards added.
 *
 * Anything that isn't a layout at all (a row from an older shape, a hand-
 * edited value, garbage from a client) is the default dashboard, never an
 * error page: the worst a bad row can do is reset one person's arrangement.
 */
export function normalizeLayout(raw: unknown, catalog: readonly LayoutCatalogEntry[]): DashboardLayout {
  if (!raw || typeof raw !== "object") return defaultLayout(catalog);
  const value = raw as { v?: unknown; main?: unknown; items?: unknown; known?: unknown };
  if (value.v !== 1 || !Array.isArray(value.items)) return defaultLayout(catalog);

  const offered = new Map(catalog.map((entry) => [entry.key, entry]));
  const seen = new Set<string>();
  const items: LayoutItem[] = [];
  for (const item of value.items as unknown[]) {
    if (!item || typeof item !== "object") continue;
    const { key, size } = item as { key?: unknown; size?: unknown };
    if (typeof key !== "string" || !offered.has(key) || seen.has(key)) continue;
    seen.add(key);
    items.push({ key, size: isCardSize(size) ? size : (offered.get(key)?.defaultSize ?? "s") });
  }

  const known = new Set(
    Array.isArray(value.known) ? (value.known as unknown[]).filter((k): k is string => typeof k === "string") : [],
  );
  for (const entry of catalog) {
    if (entry.defaultOn && !known.has(entry.key) && !seen.has(entry.key)) {
      seen.add(entry.key);
      items.push({ key: entry.key, size: entry.defaultSize ?? "s" });
    }
  }

  const main = typeof value.main === "string" && seen.has(value.main) ? value.main : null;
  return {
    v: 1,
    main,
    items: items.slice(0, MAX_CARDS),
    known: catalog.map((entry) => entry.key),
  };
}

/** Turn a card on (at the end) or off. Turning off the starred card clears the star. */
export function toggleCard(
  layout: DashboardLayout,
  key: string,
  on: boolean,
  catalog: readonly LayoutCatalogEntry[],
): DashboardLayout {
  const has = layout.items.some((item) => item.key === key);
  if (on) {
    if (has || layout.items.length >= MAX_CARDS) return layout;
    const entry = catalog.find((e) => e.key === key);
    if (!entry) return layout;
    return { ...layout, items: [...layout.items, { key, size: entry.defaultSize ?? "s" }] };
  }
  if (!has) return layout;
  return {
    ...layout,
    main: layout.main === key ? null : layout.main,
    items: layout.items.filter((item) => item.key !== key),
  };
}

/** Star a card (turning it on first if it's off), or clear the star with null. */
export function starCard(
  layout: DashboardLayout,
  key: string | null,
  catalog: readonly LayoutCatalogEntry[],
): DashboardLayout {
  if (key === null) return { ...layout, main: null };
  const on = toggleCard(layout, key, true, catalog);
  if (!on.items.some((item) => item.key === key)) return layout;
  return { ...on, main: key };
}

export function resizeCard(layout: DashboardLayout, key: string, size: CardSize): DashboardLayout {
  if (!isCardSize(size)) return layout;
  return { ...layout, items: layout.items.map((item) => (item.key === key ? { ...item, size } : item)) };
}

/** Move a card to a new place in the order (an index into `items`). */
export function moveCard(layout: DashboardLayout, key: string, toIndex: number): DashboardLayout {
  const from = layout.items.findIndex((item) => item.key === key);
  if (from < 0) return layout;
  const items = [...layout.items];
  const [moving] = items.splice(from, 1);
  const to = Math.max(0, Math.min(items.length, Math.floor(toIndex)));
  items.splice(to, 0, moving!);
  return { ...layout, items };
}

/**
 * The cards in the order they're drawn: the starred one first, then the rest
 * as arranged. The starred card is at least two columns wide.
 */
export function drawOrder(layout: DashboardLayout): LayoutItem[] {
  const main = layout.items.find((item) => item.key === layout.main);
  const rest = layout.items.filter((item) => item.key !== layout.main);
  return main ? [{ key: main.key, size: main.size === "s" ? "m" : main.size }, ...rest] : [...rest];
}
