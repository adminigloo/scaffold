/**
 * A GLANCE: one feature's small version, as plain data.
 *
 * Every card on the dashboard is one of these. The feature decides WHAT is
 * worth a look (its own counts, its own short list, where each one is dealt
 * with); the dashboard decides how it LOOKS. That split is the whole design:
 * twenty features drawing their own cards would be twenty dashboards, and a
 * card that is data can be checked by a test, sent to the browser as JSON and
 * drawn the same way in every app that installs the package.
 *
 * Plain JSON, no functions and no React: it crosses the network from the
 * route that computed it (with the viewer's permissions) to the card that
 * draws it. Every number in it was counted by the database; the code that
 * builds a glance formats, it never estimates.
 */

/** How a number or a row should read. `bad` is for something broken or late. */
export type Tone = "neutral" | "good" | "warn" | "bad";

export const TONES: readonly Tone[] = ["neutral", "good", "warn", "bad"];

/** One number, and where it is dealt with. */
export interface GlanceTile {
  /** Two or three words: "Waiting on you". */
  readonly label: string;
  /** A count, or a figure the feature has already formatted ("$1,240.00"). */
  readonly value: number | string;
  /** The page, filtered to exactly what this number counts, if there is one. */
  readonly href?: string;
  readonly tone?: Tone;
  /** One short line under the number. */
  readonly hint?: string;
}

/** One line of the short list. */
export interface GlanceRow {
  readonly title: string;
  /** Right-hand detail: a time, an amount, a count. */
  readonly meta?: string;
  /** A small chip before the title: "Bug", "Waiting", "Overdue". */
  readonly badge?: string;
  readonly href?: string;
  readonly tone?: Tone;
}

/** A small bar chart of one series over recent days, oldest first. */
export interface GlanceSpark {
  readonly label: string;
  readonly points: readonly number[];
  /** What the last point is, in words: "Today". */
  readonly lastLabel?: string;
}

export interface Glance {
  /**
   * The state in one sentence, in plain words: "2 tickets are waiting on a
   * reply." Says what a person should do, or that nothing needs them.
   */
  readonly status?: { readonly text: string; readonly tone: Tone };
  /**
   * How many things need a person now. Drawn as a badge on the card's title
   * bar, so a closed-up dashboard still shows where the work is. Zero or
   * absent is "nothing".
   */
  readonly attention?: number;
  /** Up to four numbers. */
  readonly tiles?: readonly GlanceTile[];
  readonly spark?: GlanceSpark;
  /** Up to six rows. `empty` is what to say when there are none. */
  readonly list?: {
    readonly title?: string;
    readonly rows: readonly GlanceRow[];
    readonly empty?: string;
  };
  /** Small print under everything else. */
  readonly note?: string;
  /** The way out to the full page. Defaults to the widget's own page. */
  readonly link?: { readonly href: string; readonly label: string };
  /**
   * A feature with nothing set up yet says so and names the next step,
   * instead of a card of zeros that looks like a page that failed to load.
   */
  readonly setup?: { readonly text: string; readonly href?: string; readonly label?: string };
}

/** The most of each part a card shows. A glance that sends more is trimmed. */
export const GLANCE_LIMITS = { tiles: 4, rows: 6, sparkPoints: 31, text: 200 } as const;

/**
 * Trim a glance to what a card can show, so one feature sending a hundred rows
 * can't make one card the height of the page. Also drops anything that isn't
 * one of the shapes above, because a glance is built by whichever feature
 * registered it and drawn by this package: the boundary is checked here, once,
 * rather than trusted.
 */
export function clampGlance(glance: Glance): Glance {
  const text = (value: unknown): string | undefined =>
    typeof value === "string" && value.length > 0 ? value.slice(0, GLANCE_LIMITS.text) : undefined;
  const tone = (value: unknown): Tone | undefined =>
    TONES.includes(value as Tone) ? (value as Tone) : undefined;
  const href = (value: unknown): string | undefined => {
    const s = text(value);
    // Same-site paths only. A glance links to the page that deals with it;
    // an absolute URL in one is a mistake, or a way out of the app.
    return s && s.startsWith("/") && !s.startsWith("//") ? s : undefined;
  };
  const value = (v: unknown): number | string =>
    typeof v === "number" && Number.isFinite(v) ? v : (text(v) ?? "—");

  const out: {
    -readonly [K in keyof Glance]: Glance[K];
  } = {};

  if (glance.status) {
    const t = text(glance.status.text);
    if (t) out.status = { text: t, tone: tone(glance.status.tone) ?? "neutral" };
  }
  if (typeof glance.attention === "number" && Number.isFinite(glance.attention) && glance.attention > 0) {
    out.attention = Math.floor(glance.attention);
  }
  if (Array.isArray(glance.tiles)) {
    out.tiles = glance.tiles.slice(0, GLANCE_LIMITS.tiles).flatMap((tile) => {
      const label = text(tile?.label);
      if (!label) return [];
      return [{ label, value: value(tile.value), href: href(tile.href), tone: tone(tile.tone), hint: text(tile.hint) }];
    });
  }
  if (glance.spark && Array.isArray(glance.spark.points)) {
    const points = glance.spark.points
      .slice(-GLANCE_LIMITS.sparkPoints)
      .map((p) => (typeof p === "number" && Number.isFinite(p) && p > 0 ? p : 0));
    const label = text(glance.spark.label);
    if (label && points.length > 1) out.spark = { label, points, lastLabel: text(glance.spark.lastLabel) };
  }
  if (glance.list && Array.isArray(glance.list.rows)) {
    out.list = {
      title: text(glance.list.title),
      empty: text(glance.list.empty),
      rows: glance.list.rows.slice(0, GLANCE_LIMITS.rows).flatMap((row) => {
        const title = text(row?.title);
        if (!title) return [];
        return [{ title, meta: text(row.meta), badge: text(row.badge), href: href(row.href), tone: tone(row.tone) }];
      }),
    };
  }
  const note = text(glance.note);
  if (note) out.note = note;
  if (glance.link) {
    const h = href(glance.link.href);
    const label = text(glance.link.label);
    if (h && label) out.link = { href: h, label };
  }
  if (glance.setup) {
    const t = text(glance.setup.text);
    if (t) out.setup = { text: t, href: href(glance.setup.href), label: text(glance.setup.label) };
  }
  return out;
}

/** "1 ticket" / "3 tickets". Small, but every glance needs it. */
export function plural(count: number, one: string, many: string = one + "s"): string {
  return `${count.toLocaleString("en-US")} ${count === 1 ? one : many}`;
}

/**
 * "just now", "5 min ago", "3 h ago", "2 days ago", then the date. For a row's
 * `meta`. `now` is passed in, never read from the clock here, so a test can
 * pin it.
 */
export function ago(when: Date | string | null | undefined, now: Date): string {
  if (!when) return "";
  const at = typeof when === "string" ? new Date(when) : when;
  const seconds = Math.round((now.getTime() - at.getTime()) / 1000);
  if (!Number.isFinite(seconds)) return "";
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  if (days < 14) return `${days} ${days === 1 ? "day" : "days"} ago`;
  return at.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/**
 * Counts per day for the last `days` days, oldest first, from rows that each
 * carry a day key ("2026-11-19"). The database groups and counts; this only
 * lays the answer out on a calendar, filling the days nothing happened with 0.
 */
export function daySeries(
  counted: readonly { readonly day: string; readonly n: number }[],
  days: number,
  now: Date,
  timeZone = "UTC",
): number[] {
  const byDay = new Map(counted.map((row) => [row.day, Number(row.n) || 0]));
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  const out: number[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const day = fmt.format(new Date(now.getTime() - i * 24 * 60 * 60 * 1000));
    out.push(byDay.get(day) ?? 0);
  }
  return out;
}
