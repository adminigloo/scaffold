import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  version as reactVersion,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactElement,
} from "react";
import { DARK_PALETTE, LIGHT_PALETTE, paletteDeclarations } from "./board-tokens";

/**
 * The Kanban board — the `./board` entry, and the only client code in this
 * package. Controlled on purpose: it renders what it is given and reports
 * moves through `onMove`, so it works under tRPC, server actions, or plain
 * fetch — whatever the consuming app already uses. Styling is injected and
 * `aib-`-prefixed like the widget's, because a package class name means
 * nothing to the consumer's Tailwind build.
 */

export interface BoardStatusView {
  key: string;
  label: string;
  color?: string | null;
  sortOrder?: number;
  /** All optional so a consumer on a pre-0.7 server still typechecks. */
  isTerminal?: boolean | null;
  wipLimit?: number | null;
  agingWarnHours?: number | null;
  agingStaleHours?: number | null;
}

export interface BoardTicketView {
  id: string;
  ticketNumber: string;
  title: string;
  priority: string;
  category?: string | null;
  status: string;
  assignee?: string | null;
  reporterName?: string | null;
  reporterEmail?: string | null;
  /** Optional so a consumer on a pre-0.5 server half still typechecks. */
  hasUnreadReporterReply?: boolean | null;
  pagePathname?: string | null;
  screenshotUrl?: string | null;
  annotatedScreenshotUrl?: string | null;
  /** Date or ISO string — serialization boundaries turn Dates into strings. */
  createdAt: Date | string;
  /** When the ticket last changed column (0.7.0). Aging falls back to createdAt. */
  statusChangedAt?: Date | string | null;
  /** Set = archived. The card renders with a dashed edge and a badge; it never renders at all unless the consumer asked the server for archived rows. */
  archivedAt?: Date | string | null;
}

export interface TicketMessageView {
  id: string;
  senderType: "staff" | "reporter" | "system";
  senderName: string;
  body: string;
  createdAt: Date | string;
}

/** The client context a report arrived with — the widget's clientMetadata. */
export interface TicketContextView {
  browser?: string | null;
  os?: string | null;
  viewport?: { width?: number | null; height?: number | null } | null;
  url?: string | null;
  pathname?: string | null;
  clickTrail?: Array<{
    type?: string | null;
    target?: string | null;
    value?: string | null;
    timestamp?: number | null;
  }> | null;
}

/** A browser error captured with the report — the widget's recentErrors. */
export interface TicketErrorView {
  type?: string | null;
  message?: string | null;
  url?: string | null;
  lineNumber?: number | null;
  columnNumber?: number | null;
}

/**
 * The heavy half of a ticket — the report body and the captured context — kept
 * OUT of the board payload (which caps at hundreds of cards) and fetched by the
 * consumer only when a panel opens. Hand it to `TicketPanel.detail`; absent,
 * the panel still shows the report's screenshot, which rides on the card.
 */
export interface TicketDetailView {
  description?: string | null;
  context?: TicketContextView | null;
  errors?: TicketErrorView[] | null;
}

/**
 * `auto` (the default) follows the viewer's OS setting; `light` / `dark` pin
 * it — pass `light` inside an admin that has no dark mode, or a dark-OS viewer
 * gets a dark board on a white page (0.9.0).
 */
export type BoardTheme = "auto" | "light" | "dark";

/**
 * What `onMoveMany` may resolve with (0.9.0) when SOME of a batch was refused:
 * only those cards go back, the rest stay moved. Resolving nothing means all
 * landed; throwing means none did.
 */
export interface BulkMoveResult {
  failed?: string[];
}

export interface FeedbackBoardProps {
  statuses: BoardStatusView[];
  tickets: BoardTicketView[];
  /**
   * Called on drop (and on Alt+← / Alt+→ from a focused card). Reject (throw)
   * to put the card back where it was: a promise that RESOLVES counts as a
   * landed move, so an API that reports failure as a value — a Next server
   * action's `{ ok: false }` — must be turned into a throw here.
   */
  onMove: (ticketId: string, statusKey: string) => void | Promise<void>;
  /**
   * Card click. Wire this to open the TicketPanel, or to navigate. With
   * `ticketHref` too, a plain click on the title calls this and a
   * modified click (new tab) follows the link.
   */
  onOpen?: (ticket: BoardTicketView) => void;
  /**
   * A real URL for each ticket (0.9.0). The card title becomes a link, so it
   * can be middle-clicked, copied, and reached from the keyboard as a link.
   */
  ticketHref?: (ticket: BoardTicketView) => string | undefined;
  /**
   * Bulk move (0.7.0). Providing this is what turns selection ON: cards grow
   * checkboxes, column headers a tri-state select-all, a bar appears when
   * anything is selected, and dragging a selected card carries the whole
   * selection. Absent, the board is exactly the single-drag board it was.
   * Same contract as `onMove` — throw to roll the whole batch back — or
   * resolve `{ failed: [ids] }` to roll back only those.
   */
  onMoveMany?: (ticketIds: string[], statusKey: string) => void | Promise<void | BulkMoveResult>;
  /**
   * A move was refused — `onMove`/`onMoveMany` threw (0.9.0). The cards are
   * already back where they were; this is where the consumer tells the person
   * why (a toast). Without it the rollback is silent.
   */
  onMoveError?: (error: unknown, ticketIds: string[], statusKey: string) => void;
  /** See `BoardTheme`. Default `auto`. */
  theme?: BoardTheme;
}

const STYLE_ID = "aib-styles";

/** React 19 can render a deduplicated, hoisted <style> during SSR; React 18 injects after mount. */
const HOISTED_STYLES = Number.parseInt(reactVersion, 10) >= 19;

/** Every theme-able declaration sits under `:where()` — zero specificity, so a
 *  host's own `.aib-root { --aib-accent: … }` wins in any order, either theme.
 *  Declared ONLY on the outermost element of each surface (the board's root,
 *  the panel's layer around scrim + dialog): a token set on an inner element
 *  would re-declare the defaults beneath a host's override. */
const TOKEN_SCOPE = ":where(.aib-root, .aib-panel-layer)";

/*
 * The board's own token set, `--aib-*`, built from `board-tokens.ts`. Dark is
 * decided by prefers-color-scheme unless the `theme` prop pins it — this
 * renders inside a consuming app whose theme it cannot know, and a hardcoded
 * white board in a dark admin reads as a foreign object. Every colour resolves
 * through a token; one bare hex is a rule nobody re-tests in the other theme.
 *
 * 0.9.0: the tokens are declared on `.aib-root` — the board's OUTER element —
 * not `.aib-board`, because the bulk bar renders beside `.aib-board`, where
 * 0.8.0's tokens resolved to nothing and the bar painted transparent.
 */
const CSS_TEXT = `
${TOKEN_SCOPE} { ${paletteDeclarations(LIGHT_PALETTE)} color-scheme: light;
  --aib-z-bar: 40; --aib-bar-bottom: 16px; --aib-bar-left: 50%; --aib-z-panel: 2147483003; }
@media (prefers-color-scheme: dark) {
  ${TOKEN_SCOPE}:where(:not([data-aib-theme="light"])) { ${paletteDeclarations(DARK_PALETTE)} color-scheme: dark; }
}
${TOKEN_SCOPE}:where([data-aib-theme="dark"]) { ${paletteDeclarations(DARK_PALETTE)} color-scheme: dark; }

/* Host-overridable without a specificity fight, like the tokens. */
:where(.aib-root, .aib-panel-layer) { color: var(--aib-ink);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
.aib-root:focus { outline: none; }
.aib-root.aib-selecting { padding-bottom: 96px; }
/* While the fixed bulk bar is up, a card focused near the bottom of the window
   scrolls clear of it instead of landing underneath (WCAG 2.4.11). */
.aib-root.aib-selecting :is(.aib-card-open, .aib-check) { scroll-margin-bottom: 112px; }
.aib-sr { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden;
  clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
.aib-board { display: flex; gap: 12px; align-items: flex-start; overflow-x: auto; padding-bottom: 8px; }
.aib-col { flex: 1 0 240px; max-width: 360px; background: var(--aib-surface-2); border: 1px solid var(--aib-line);
  border-radius: 12px; }
.aib-col-orphan { border-style: dashed; }
.aib-col-head { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-bottom: 1px solid var(--aib-line);
  isolation: isolate;
  min-height: 44px; box-sizing: border-box; }
.aib-col-dot { width: 9px; height: 9px; border-radius: 50%; flex: none; }
.aib-col-title { font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; color: var(--aib-ink-muted); }
.aib-col-count { margin-left: auto; font-size: 11px; color: var(--aib-ink-faint); font-variant-numeric: tabular-nums; }
.aib-col-body { padding: 10px; min-height: 60px; }
.aib-col-list { display: flex; flex-direction: column; gap: 8px; margin: 0; padding: 0; list-style: none; }
.aib-col.aib-over { outline: 2px dashed var(--aib-accent); outline-offset: -4px; }
.aib-card { background: var(--aib-surface); border: 1px solid var(--aib-line); border-radius: 10px; padding: 10px 11px;
  cursor: grab; box-shadow: var(--aib-shadow-card); transition: border-color .12s ease; isolation: isolate; }
.aib-card:hover { border-color: var(--aib-line-strong); }
.aib-card:active { cursor: grabbing; }
.aib-card.aib-dragging { opacity: .45; }
/* Busy (a move in flight): a dashed edge, not 0.8.0's opacity — focus is put
   back on a moved card while it is busy, and faded text and a faded focus ring
   both fell below contrast minimums. */
.aib-card.aib-busy { pointer-events: none; border-color: var(--aib-accent); border-style: dashed; cursor: progress; }
.aib-card-top { display: flex; align-items: center; gap: 6px; margin-bottom: 5px; }
/* The 44px checkbox overhangs its row by 12px; keep the title clear of it. */
.aib-card-top.aib-has-check { margin-bottom: 12px; }
.aib-num { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11px; color: var(--aib-ink-faint); }
.aib-chip { font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: .05em;
  border: 1px solid; border-radius: 999px; padding: 1px 6px; margin-left: auto; }
.aib-chip-critical { color: var(--aib-danger); border-color: var(--aib-danger); }
.aib-chip-high { color: var(--aib-warn); border-color: var(--aib-warn); }
.aib-chip-medium, .aib-chip-low { color: var(--aib-ink-faint); border-color: var(--aib-line-strong); }
.aib-card-title { font-size: 13px; line-height: 1.4; color: var(--aib-ink); overflow-wrap: anywhere; }
/* The title is the card's keyboard handle (0.9.0): a button (onOpen) or a link
   (ticketHref) that LOOKS like the title — reachable by Tab, opened by Enter,
   and Alt+←/→ moves the card a column. */
.aib-card-open { all: unset; display: block; cursor: pointer; color: inherit; font: inherit;
  overflow-wrap: anywhere; border-radius: 4px; }
.aib-card-open:hover { text-decoration: underline; }
.aib-card-open:is(:link, :visited, :hover, :active) { color: inherit; }
.aib-card-open:focus-visible { outline: 2px solid var(--aib-accent); outline-offset: 3px; }
.aib-card-meta { margin-top: 6px; display: flex; align-items: center; gap: 8px; font-size: 11px; color: var(--aib-ink-muted); flex-wrap: wrap; }
.aib-card-meta a { color: var(--aib-accent); text-decoration: none; }
.aib-card-meta a:hover { text-decoration: underline; }
.aib-empty { font-size: 12px; color: var(--aib-ink-faint); text-align: center; padding: 14px 0; }
.aib-assignee { display: inline-flex; align-items: center; gap: 4px; font-size: 11px; color: var(--aib-accent);
  background: var(--aib-accent-soft); border-radius: 999px; padding: 1px 8px; }
.aib-unread { display: inline-flex; align-items: center; gap: 4px; font-size: 9px; font-weight: 700;
  text-transform: uppercase; letter-spacing: .05em; color: var(--aib-on-accent);
  background: var(--aib-accent); border-radius: 999px; padding: 1px 7px; }

/* WIP limits (0.7.0): the count turns into count/limit and the header speaks
   up — amber at the limit, loud past it. A limit, not a lock. */
.aib-col-head.aib-wip-full { box-shadow: inset 0 -2px 0 var(--aib-warn); }
.aib-col-head.aib-wip-over { box-shadow: inset 0 -2px 0 var(--aib-danger); }
.aib-col-count.aib-wip-full { color: var(--aib-warn); font-weight: 700; }
.aib-col-count.aib-wip-over { color: var(--aib-danger); font-weight: 700; }

/* Card aging (0.7.0): a mark that escalates as the card sits in its column.
   0.9.0: shape as well as colour (a ring when aging, a filled dot when stale)
   and words for screen readers — 0.8.0 told the two apart by hue alone. */
.aib-age { width: 8px; height: 8px; border-radius: 50%; flex: none; box-sizing: border-box; }
.aib-age-warn { border: 2px solid var(--aib-warn); }
.aib-age-stale { background: var(--aib-danger); }

/* Archived cards (visible only when the consumer asked for them). 0.9.0: a
   dashed edge on the column's tint instead of 0.8.0's opacity, which took the
   card's text below AA. */
.aib-card.aib-archived { background: var(--aib-surface-2); border-style: dashed; box-shadow: none; }
.aib-archived-chip { font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: .05em;
  color: var(--aib-ink-faint); border: 1px dashed var(--aib-line-strong); border-radius: 999px; padding: 1px 6px; }

/* Bulk selection (0.7.0). The checkbox only exists when onMoveMany does.
   0.9.0: a 44px target (touch) drawn from tokens — the input itself is the hit
   area, overhanging its neighbours by a negative margin so the card keeps a
   20px box; ::before draws the box, ::after the tick or dash. */
.aib-check { appearance: none; -webkit-appearance: none; display: inline-grid; place-content: center; flex: none;
  width: 44px; height: 44px; margin: -12px; background: transparent; border: 0; cursor: pointer;
  position: relative; z-index: 1; }
.aib-check::before, .aib-check::after { content: ""; grid-area: 1 / 1; }
.aib-check::before { box-sizing: border-box; width: 18px; height: 18px; border: 2px solid var(--aib-ink-muted);
  border-radius: 4px; background: var(--aib-surface); }
.aib-check:checked::before, .aib-check:indeterminate::before { border-color: var(--aib-accent); background: var(--aib-accent); }
.aib-check::after { width: 11px; height: 11px; background: var(--aib-on-accent);
  clip-path: polygon(14% 44%, 0 65%, 50% 100%, 100% 16%, 80% 0%, 43% 62%); transform: scale(0); }
.aib-check:checked::after { transform: scale(1); }
.aib-check:indeterminate::after { transform: scale(1); clip-path: inset(40% 0); }
.aib-check:focus-visible { outline: none; }
.aib-check:focus-visible::before { outline: 2px solid var(--aib-accent); outline-offset: 2px; }
.aib-col-check { margin-right: -6px; }

/* Windows High Contrast / forced colours: backgrounds are forced to Canvas,
   which would erase the drawn box, tick and dots — use system colours. */
@media (forced-colors: active) {
  .aib-check::before, .aib-check::after, .aib-age, .aib-col-dot { forced-color-adjust: none; }
  .aib-check::before { border-color: CanvasText; background: Canvas; }
  .aib-check:checked::before, .aib-check:indeterminate::before { border-color: Highlight; background: Highlight; }
  .aib-check::after { background: HighlightText; }
  .aib-age-warn { border-color: CanvasText; }
  .aib-age-stale { background: CanvasText; }
  .aib-col-dot { border: 1px solid CanvasText; }
  .aib-check:focus-visible::before { outline-color: Highlight; }
}

/* 0.9.0: fixed to the viewport, not sticky — sticky only floats when the
   nearest overflow ancestor is the one actually scrolling, and in common admin
   shells (an overflow-y-auto <main> the document scrolls past) 0.8.0's bar sat
   under the tallest column, below the fold. Position it with --aib-bar-bottom,
   --aib-bar-left and --aib-z-bar on .aib-root. */
.aib-bulkbar { position: fixed; left: var(--aib-bar-left); bottom: var(--aib-bar-bottom); transform: translateX(-50%);
  z-index: var(--aib-z-bar); display: flex; flex-wrap: wrap; align-items: center; gap: 10px;
  max-width: calc(100vw - 32px); box-sizing: border-box; padding: 10px 14px; border: 1px solid var(--aib-line-strong);
  border-radius: 12px; background: var(--aib-surface); color: var(--aib-ink); box-shadow: var(--aib-shadow-panel); }
.aib-bulkbar-count { font-size: 13px; font-weight: 600; }
.aib-bulkbar .aib-select { width: auto; }
.aib-bulk-clear { border: 0; background: transparent; color: var(--aib-ink-muted); font-size: 13px;
  cursor: pointer; padding: 4px 10px; border-radius: 8px; min-height: 44px; min-width: 44px; }
.aib-bulk-clear:hover { background: var(--aib-surface-2); color: var(--aib-ink); }
.aib-bulk-apply { border: 0; border-radius: 8px; background: var(--aib-accent); color: var(--aib-on-accent);
  font-size: 13px; font-weight: 600; padding: 7px 14px; cursor: pointer; min-height: 44px; min-width: 44px; }
.aib-bulk-apply:hover { background: var(--aib-accent-strong); }
.aib-bulk-apply:disabled { background: var(--aib-ink-faint); cursor: default; }
.aib-archive-btn { align-self: flex-end; flex: none; border: 1px solid var(--aib-line-strong); border-radius: 8px;
  background: var(--aib-surface); color: var(--aib-ink-muted); font-size: 12px; padding: 7px 10px; cursor: pointer;
  min-height: 44px; }
.aib-archive-btn:hover { color: var(--aib-ink); border-color: var(--aib-ink-faint); }

/* Ticket panel. 0.9.0: a real modal dialog (focus moves in, Tab stays in,
   Escape closes, focus returns), stacked by --aib-z-panel — still 2147483003
   by default, above the feedback widget's launcher (2147483000), which would
   otherwise sit on the Send button. Set --aib-z-panel on .aib-panel-layer to
   let a host's toasts show above the scrim. */
.aib-panel-backdrop { position: fixed; inset: 0; z-index: calc(var(--aib-z-panel) - 1); background: var(--aib-scrim); }
.aib-panel { position: fixed; top: 0; right: 0; bottom: 0; z-index: var(--aib-z-panel); width: min(480px, 96vw);
  background: var(--aib-surface); border-left: 1px solid var(--aib-line); box-shadow: var(--aib-shadow-panel);
  display: flex; flex-direction: column; }
.aib-panel:focus { outline: none; }
.aib-panel-head { display: flex; align-items: flex-start; gap: 10px; padding: 14px 16px;
  border-bottom: 1px solid var(--aib-line); }
.aib-panel-title { font-size: 15px; font-weight: 700; line-height: 1.35; letter-spacing: -.01em; overflow-wrap: anywhere; margin: 0; }
.aib-panel-sub { margin-top: 3px; font-size: 12px; color: var(--aib-ink-muted); display: flex; gap: 8px; flex-wrap: wrap; }
.aib-panel-sub a { color: var(--aib-accent); }
.aib-panel-close { margin-left: auto; flex: none; border: 0; background: transparent; cursor: pointer;
  font-size: 20px; line-height: 1; color: var(--aib-ink-muted); width: 44px; height: 44px; margin: -8px -8px -8px auto;
  border-radius: 8px; }
.aib-panel-close:hover { background: var(--aib-surface-2); color: var(--aib-ink); }
.aib-panel-close:focus-visible, .aib-send:focus-visible, .aib-archive-btn:focus-visible,
.aib-bulk-apply:focus-visible, .aib-bulk-clear:focus-visible { outline: 2px solid var(--aib-accent); outline-offset: 2px; }
.aib-panel-controls { display: flex; gap: 8px; padding: 10px 16px; border-bottom: 1px solid var(--aib-line); }
.aib-panel-controls label { display: flex; flex-direction: column; gap: 3px; flex: 1; font-size: 10px;
  font-weight: 700; text-transform: uppercase; letter-spacing: .05em; color: var(--aib-ink-muted); }
/* Control edges use ink-faint (≥3:1, WCAG 1.4.11); line-strong is 1.6:1 and
   left 0.8.0's inputs without a visible boundary. */
.aib-select, .aib-input { border: 1px solid var(--aib-ink-faint); border-radius: 8px; padding: 6px 8px; font: inherit;
  font-size: 13px; background: var(--aib-surface); color: var(--aib-ink); width: 100%; box-sizing: border-box; min-height: 44px; }
.aib-select:focus-visible, .aib-input:focus-visible { outline: 2px solid var(--aib-accent); outline-offset: 1px; }
.aib-thread { flex: 1; overflow-y: auto; padding: 14px 16px; display: flex; flex-direction: column; gap: 10px; }
.aib-msg { border: 1px solid var(--aib-line); border-radius: 10px; padding: 8px 11px; font-size: 13px; }
.aib-msg-staff { background: var(--aib-accent-soft); border-color: transparent; }
.aib-msg-reporter { background: var(--aib-surface); }
.aib-msg-system { background: transparent; border-style: dashed; color: var(--aib-ink-muted); font-size: 12px; }
.aib-msg-meta { display: flex; gap: 8px; font-size: 11px; color: var(--aib-ink-muted); margin-bottom: 3px; }
.aib-msg-meta b { color: var(--aib-ink); }
.aib-msg-body { white-space: pre-wrap; overflow-wrap: anywhere; }
.aib-thread-empty { font-size: 12px; color: var(--aib-ink-faint); text-align: center; padding: 18px 0; }
.aib-compose { display: flex; gap: 8px; padding: 12px 16px; border-top: 1px solid var(--aib-line); }
.aib-input::placeholder, .aib-compose textarea::placeholder { color: var(--aib-ink-faint); opacity: 1; }
.aib-compose textarea { flex: 1; min-height: 58px; resize: vertical; border: 1px solid var(--aib-ink-faint);
  border-radius: 8px; padding: 8px 10px; font: inherit; font-size: 13px;
  background: var(--aib-surface); color: var(--aib-ink); }
.aib-compose textarea:focus-visible { outline: 2px solid var(--aib-accent); outline-offset: 1px; }
.aib-send { align-self: flex-end; border: 0; border-radius: 8px; background: var(--aib-accent); color: var(--aib-on-accent);
  font-size: 13px; font-weight: 600; padding: 9px 14px; cursor: pointer; transition: background .12s ease; min-height: 44px; }
.aib-send:hover { background: var(--aib-accent-strong); }
.aib-send:disabled { background: var(--aib-ink-faint); cursor: default; }

/* Ticket detail (0.7.1): the report, its annotated screenshot inline, and the
   captured context — everything in the one panel, no new tabs. */
.aib-detail { display: flex; flex-direction: column; gap: 12px; padding-bottom: 12px;
  border-bottom: 1px solid var(--aib-line); margin-bottom: 2px; }
.aib-report { white-space: pre-wrap; overflow-wrap: anywhere; font-size: 13px; line-height: 1.5; color: var(--aib-ink); }
.aib-shot-wrap { display: block; }
.aib-shot { display: block; width: 100%; border: 1px solid var(--aib-line); border-radius: 10px; }
.aib-shot-label { display: block; margin-top: 5px; font-size: 11px; color: var(--aib-ink-faint); }
.aib-detail-h { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .05em;
  color: var(--aib-ink-muted); margin: 2px 0 4px; }
.aib-kv { display: grid; grid-template-columns: 1fr 1fr; gap: 4px 12px; font-size: 12px; color: var(--aib-ink);
  overflow-wrap: anywhere; }
.aib-kv b { color: var(--aib-ink-muted); font-weight: 600; margin-right: 5px; }
.aib-trail { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 2px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11px;
  color: var(--aib-ink-muted); overflow-wrap: anywhere; }
.aib-errs { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 4px; }
.aib-err { font-size: 12px; color: var(--aib-danger); overflow-wrap: anywhere; }
.aib-err b { color: var(--aib-ink); }
`;

function injectStyles(): void {
  if (typeof document === "undefined" || document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = CSS_TEXT;
  document.head.appendChild(style);
}

/**
 * The stylesheet, server-rendered where React can (0.9.0). React 19 hoists a
 * `<style href precedence>` into <head> during SSR and dedupes it, so the
 * board's first paint is styled — 0.8.0 injected after hydration, and the
 * server HTML painted as a stack of unstyled divs first. On React 18 this
 * renders nothing and `useBoardStyles` injects on mount, as before.
 */
function BoardStyles(): ReactElement | null {
  if (!HOISTED_STYLES) return null;
  return (
    <style href={STYLE_ID} precedence="medium">
      {CSS_TEXT}
    </style>
  );
}

function useBoardStyles(): void {
  useEffect(() => {
    if (!HOISTED_STYLES) injectStyles();
  }, []);
}

function toDate(value: Date | string): Date | null {
  const date = typeof value === "string" ? new Date(value) : value;
  return Number.isNaN(date.getTime()) ? null : date;
}

/** The panel's default timestamp: the viewer's own locale and time zone. */
function defaultFormatTime(date: Date): string {
  return date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/** An unparseable date renders as written rather than crashing the panel (0.8.0 threw a RangeError). */
function timeOf(createdAt: Date | string, format: (date: Date) => string): string {
  const date = toDate(createdAt);
  return date ? format(date) : String(createdAt);
}

/** The card title with this ticket id, wherever its column now is. */
function findHandle(scope: ParentNode | null | undefined, ticketId: string): HTMLElement | null {
  if (!scope) return null;
  for (const el of scope.querySelectorAll<HTMLElement>("[data-aib-open]")) {
    if (el.dataset.aibOpen === ticketId) return el;
  }
  return null;
}

/** Keys that step a closed <select> to a neighbouring option. */
const STEP_KEYS: ReadonlySet<string> = new Set([
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
  "PageUp",
  "PageDown",
]);

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export type TicketPanelAction = "move" | "assign" | "archive" | "send";

export interface TicketPanelProps {
  ticket: BoardTicketView;
  messages: TicketMessageView[];
  statuses: BoardStatusView[];
  /**
   * The report body, captured context and browser errors, fetched on open.
   * Optional: without it the panel still shows the annotated screenshot (which
   * travels on the card) and the conversation — the detail simply fills in as
   * the consumer's fetch resolves.
   */
  detail?: TicketDetailView | null;
  /** Shown as the sender on messages this viewer writes. */
  currentUser: string;
  onClose: () => void;
  onSend: (body: string) => void | Promise<void>;
  onAssign: (assignee: string | null) => void | Promise<void>;
  onMove: (statusKey: string) => void | Promise<void>;
  /**
   * Archive / unarchive (0.7.0), rendered only when provided. Which of the
   * two the button means comes from the ticket's own archivedAt — the panel
   * reports the intent, the consumer flips the row.
   */
  onArchive?: () => void | Promise<void>;
  /**
   * One of the callbacks above threw or rejected (0.9.0). 0.8.0 let those
   * become unhandled promise rejections; now the panel catches them, keeps
   * the draft on a failed send, and hands the error here.
   */
  onError?: (error: unknown, action: TicketPanelAction) => void;
  /** How message times read (0.9.0). Default: the viewer's locale and time zone. */
  formatTime?: (date: Date) => string;
  /** See `BoardTheme`. Default `auto`. */
  theme?: BoardTheme;
}

/**
 * One ticket's working surface: the report, its conversation, and the two
 * controls triage actually uses (status, assignee). Controlled like the
 * board — it renders what it is given and reports intents; the consumer
 * owns fetching and refetching.
 *
 * 0.9.0: a modal dialog in fact as well as in look — focus moves into it on
 * open, Tab and Shift+Tab stay inside, Escape closes it, and focus returns to
 * whatever opened it.
 */
export function TicketPanel({
  ticket,
  messages,
  statuses,
  detail,
  currentUser,
  onClose,
  onSend,
  onAssign,
  onMove,
  onArchive,
  onError,
  formatTime = defaultFormatTime,
  theme = "auto",
}: TicketPanelProps): ReactElement {
  useBoardStyles();
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  /** A keyboard choice not yet applied (arrows on the closed select). */
  const [statusDraft, setStatusDraft] = useState<string | null>(null);
  /** An applied choice shown until the `ticket` prop catches up with it. */
  const [statusSent, setStatusSent] = useState<string | null>(null);
  /** The NEXT change of the select is an arrow/typeahead step on a closed control. */
  const nextChangeIsStep = useRef(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const composeRef = useRef<HTMLTextAreaElement>(null);
  const assigneeSent = useRef<string | null | undefined>(undefined);
  const titleId = useId();
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  if (statusSent !== null && ticket.status === statusSent) setStatusSent(null);
  // A panel switched to another ticket starts clean.
  const [shownId, setShownId] = useState(ticket.id);
  if (shownId !== ticket.id) {
    setShownId(ticket.id);
    setStatusDraft(null);
    setStatusSent(null);
    assigneeSent.current = undefined;
  }

  // Focus in on open; back out on close — to the opener, or, when the opener
  // is gone (the card changed column, or was clicked on its body rather than
  // its title), to this ticket's card title wherever it now is.
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const ticketId = ticket.id;
    const panel = panelRef.current;
    panel?.querySelector<HTMLElement>(".aib-panel-close")?.focus();

    // Focus can still fall to <body> (a control that disables itself, a
    // removed node). Keys aimed at <body> while the panel is open belong to
    // the panel: Escape closes it, Tab re-enters it. Keys aimed anywhere else
    // — a dialog stacked above — are left alone.
    const onBodyKeyDown = (event: KeyboardEvent) => {
      if (event.target !== document.body || event.defaultPrevented || !panel) return;
      if (event.key === "Escape" && !event.isComposing) {
        event.preventDefault();
        onCloseRef.current();
      } else if (event.key === "Tab") {
        const focusable = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)];
        const target = event.shiftKey ? focusable[focusable.length - 1] : focusable[0];
        if (target) {
          event.preventDefault();
          target.focus();
        }
      }
    };
    document.addEventListener("keydown", onBodyKeyDown);

    return () => {
      document.removeEventListener("keydown", onBodyKeyDown);
      // A container around the card is no place to land: <body>, or the board
      // root, which a click on the card's body focuses (it is tabIndex=-1).
      // Look in the opener's own board first, so another board on the page
      // with the same ticket can't take the focus.
      const scope = opener?.isConnected ? (opener.closest(".aib-root") ?? document) : document;
      const handle = findHandle(scope, ticketId) ?? findHandle(document, ticketId);
      const container =
        opener === document.body || (handle !== null && opener !== handle && opener?.contains(handle) === true);
      const back = opener?.isConnected && !container ? opener : handle;
      back?.focus();
    };
    // Mount/unmount only: the panel's identity is the ticket it opened on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * Escape and the Tab trap are handled ON the dialog, in the bubble phase,
   * and only for keys that reach it — a dialog stacked above this one (the
   * feedback widget's, say) keeps its own Tab and Escape. 0.8.x listened on
   * the whole document and stole both.
   */
  const onDialogKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      if (event.defaultPrevented || event.nativeEvent.isComposing) return;
      // Handled here, so nothing around the board (a drawer, a host page's
      // own Escape handler) closes as well.
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    const panel = panelRef.current;
    if (event.key !== "Tab" || !panel) return;
    const focusable = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)];
    if (focusable.length === 0) {
      event.preventDefault();
      return;
    }
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    const active = document.activeElement;
    if (event.shiftKey && (active === first || active === panel)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || active === panel)) {
      event.preventDefault();
      first.focus();
    }
  };

  const run = async (action: TicketPanelAction, fn: () => void | Promise<void>): Promise<boolean> => {
    try {
      await fn();
      return true;
    } catch (error) {
      onError?.(error, action);
      return false;
    }
  };

  const send = async () => {
    const body = draft.trim();
    if (!body || sending) return;
    setSending(true);
    try {
      if (await run("send", () => onSend(body))) {
        setDraft("");
        // Send disables itself once the draft is empty; keep focus in the
        // panel (on the box you'd type the next note in), not on <body>.
        composeRef.current?.focus();
      }
    } finally {
      setSending(false);
    }
  };

  const commitStatus = (next: string) => {
    setStatusDraft(null);
    if (next === ticket.status) return;
    setStatusSent(next);
    void run("move", () => onMove(next)).then((ok) => {
      if (!ok) setStatusSent(null);
    });
  };

  const commitAssignee = (raw: string) => {
    const next = raw.trim() || null;
    if (next === (ticket.assignee ?? null) || next === assigneeSent.current) return;
    assigneeSent.current = next;
    void run("assign", () => onAssign(next)).then((ok) => {
      if (!ok) assigneeSent.current = undefined;
    });
  };

  const knownStatus = statuses.some((status) => status.key === ticket.status);

  return (
    <div className="aib-panel-layer" data-aib-theme={theme}>
      <BoardStyles />
      <div className="aib-panel-backdrop" onClick={onClose} />
      <div
        ref={panelRef}
        className="aib-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={onDialogKeyDown}
      >
        <div className="aib-panel-head">
          <div>
            <h2 id={titleId} className="aib-panel-title">
              {ticket.ticketNumber} — {ticket.title}
            </h2>
            <div className="aib-panel-sub">
              <span>{ageOf(ticket.createdAt)}</span>
              {ticket.pagePathname ? <span>{ticket.pagePathname}</span> : null}
              {ticket.reporterName || ticket.reporterEmail ? (
                <span>from {ticket.reporterName ?? ticket.reporterEmail}</span>
              ) : null}
            </div>
          </div>
          <button type="button" className="aib-panel-close" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </div>

        <div className="aib-panel-controls">
          <label>
            Status
            {/* Arrow keys (and type-ahead) on a CLOSED select change its value —
                and fire change — on every press in Chrome and Firefox on
                Windows; 0.8.0 sent a move per keystroke. Those steps only
                stage a draft, applied on Enter or when focus leaves; Escape
                reverts it. Everything else — a mouse pick, a pick from the
                open list (Space / Enter / Alt+↓), assistive tech — applies at
                once. */}
            <select
              key={ticket.id}
              className="aib-select"
              value={statusDraft ?? statusSent ?? ticket.status}
              onKeyDown={(event) => {
                if (event.key === "Enter" && statusDraft !== null) {
                  event.preventDefault();
                  commitStatus(statusDraft);
                  return;
                }
                if (event.key === "Escape" && statusDraft !== null) {
                  // First Escape reverts the draft; the next closes the panel.
                  event.preventDefault();
                  event.stopPropagation();
                  setStatusDraft(null);
                  return;
                }
                const step =
                  !event.altKey &&
                  !event.ctrlKey &&
                  !event.metaKey &&
                  (STEP_KEYS.has(event.key) || (event.key.length === 1 && event.key !== " "));
                nextChangeIsStep.current = step;
              }}
              onPointerDown={() => {
                nextChangeIsStep.current = false;
              }}
              onChange={(event) => {
                const next = event.target.value;
                const step = nextChangeIsStep.current;
                nextChangeIsStep.current = false;
                if (step) setStatusDraft(next);
                else commitStatus(next);
              }}
              onBlur={() => {
                if (statusDraft !== null) commitStatus(statusDraft);
              }}
            >
              {/* A status no column knows still reads as itself (0.9.0) —
                  0.8.0's controlled select silently showed the first option. */}
              {knownStatus ? null : (
                <option value={ticket.status} disabled>
                  {ticket.status} (unrecognised)
                </option>
              )}
              {statuses.map((status) => (
                <option key={status.key} value={status.key}>
                  {status.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Assignee
            <input
              // Keyed so a panel switched to another ticket (or refreshed with a
              // new assignee) shows that value, not the last one typed.
              key={`${ticket.id}:${ticket.assignee ?? ""}`}
              className="aib-input"
              defaultValue={ticket.assignee ?? ""}
              placeholder="unassigned"
              onBlur={(event) => commitAssignee(event.target.value)}
              onKeyDown={(event) => {
                // Apply in place — 0.9.0's first cut blurred here, which left
                // focus on <body> and the panel deaf to Escape and Tab.
                if (event.key === "Enter") {
                  event.preventDefault();
                  commitAssignee((event.target as HTMLInputElement).value);
                }
              }}
            />
          </label>
          {onArchive ? (
            <button type="button" className="aib-archive-btn" onClick={() => void run("archive", onArchive)}>
              {ticket.archivedAt != null ? "Unarchive" : "Archive"}
            </button>
          ) : null}
        </div>

        <div className="aib-thread">
          <TicketReport ticket={ticket} detail={detail} />
          {messages.length === 0 ? (
            <div className="aib-thread-empty">No notes yet — the report above is the whole story so far.</div>
          ) : null}
          {messages.map((message) => (
            <div key={message.id} className={`aib-msg aib-msg-${message.senderType}`}>
              {message.senderType === "system" ? (
                <span>
                  {message.body} — {message.senderName}, {timeOf(message.createdAt, formatTime)}
                </span>
              ) : (
                <>
                  <div className="aib-msg-meta">
                    <b>{message.senderName}</b>
                    <span>{timeOf(message.createdAt, formatTime)}</span>
                  </div>
                  <div className="aib-msg-body">{message.body}</div>
                </>
              )}
            </div>
          ))}
        </div>

        <div className="aib-compose">
          <textarea
            ref={composeRef}
            value={draft}
            aria-label={`Note as ${currentUser}`}
            placeholder={`Note as ${currentUser}…`}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) void send();
            }}
          />
          <button
            type="button"
            className="aib-send"
            aria-busy={sending || undefined}
            disabled={!draft.trim() || sending}
            onClick={() => void send()}
          >
            {sending ? "Sending…" : "Send"}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Everything the report itself carries, rendered inline at the top of the
 * panel: the body, the annotated screenshot as an image (annotated preferred,
 * click to enlarge — the original is never shown, only the marked-up one),
 * and the captured context as readable rows rather than a JSON dump. The
 * screenshot comes off the ticket (always present); the rest fills in from
 * `detail` when the consumer's fetch resolves.
 */
function TicketReport({
  ticket,
  detail,
}: {
  ticket: BoardTicketView;
  detail?: TicketDetailView | null;
}): ReactElement | null {
  const shot = ticket.annotatedScreenshotUrl ?? ticket.screenshotUrl ?? null;
  const annotated = ticket.annotatedScreenshotUrl != null;
  const context = detail?.context ?? null;
  const errors = detail?.errors ?? [];
  const trail = Array.isArray(context?.clickTrail) ? context!.clickTrail! : [];
  const viewport = context?.viewport;

  if (!detail?.description && !shot && !context && errors.length === 0) return null;

  return (
    <div className="aib-detail">
      {detail?.description ? <div className="aib-report">{detail.description}</div> : null}

      {shot ? (
        <a className="aib-shot-wrap" href={shot} target="_blank" rel="noreferrer">
          <img
            className="aib-shot"
            src={shot}
            alt={`Screenshot for ${ticket.ticketNumber}`}
            loading="lazy"
          />
          <span className="aib-shot-label">
            {annotated ? "Annotated screenshot · click to enlarge" : "Screenshot · click to enlarge"}
          </span>
        </a>
      ) : null}

      {context ? (
        <div>
          <h3 className="aib-detail-h">Context</h3>
          <div className="aib-kv">
            {context.browser ? (
              <div>
                <b>
                  Browser
                  <span className="aib-sr">:</span>
                </b>
                {context.browser}
              </div>
            ) : null}
            {context.os ? (
              <div>
                <b>
                  OS
                  <span className="aib-sr">:</span>
                </b>
                {context.os}
              </div>
            ) : null}
            {viewport && (viewport.width || viewport.height) ? (
              <div>
                <b>
                  Viewport
                  <span className="aib-sr">:</span>
                </b>
                {viewport.width ?? "?"}×{viewport.height ?? "?"}
              </div>
            ) : null}
            {context.pathname || context.url ? (
              <div>
                <b>
                  Page
                  <span className="aib-sr">:</span>
                </b>
                {context.pathname ?? context.url}
              </div>
            ) : null}
          </div>

          {trail.length > 0 ? (
            <>
              <h3 className="aib-detail-h">Click trail</h3>
              <ul className="aib-trail">
                {trail.slice(-12).map((step, index) => (
                  <li key={index}>
                    [{step.type ?? "?"}] {step.target ?? ""}
                    {step.value ? ` "${step.value}"` : ""}
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </div>
      ) : null}

      {errors.length > 0 ? (
        <div>
          <h3 className="aib-detail-h">Browser errors</h3>
          <ul className="aib-errs">
            {errors.map((error, index) => (
              <li key={index} className="aib-err">
                <b>{error.type ?? "Error"}</b> {error.message ?? ""}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function ageOf(createdAt: Date | string): string {
  const then = toDate(createdAt);
  if (!then) return "";
  const days = Math.floor((Date.now() - then.getTime()) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "1d";
  return `${days}d`;
}

/** Hours a card has sat in its current column. Aging falls back to createdAt. */
function hoursInColumn(ticket: BoardTicketView): number {
  const then = toDate(ticket.statusChangedAt ?? ticket.createdAt);
  return then ? (Date.now() - then.getTime()) / 3_600_000 : 0;
}

/** "5 hours" under a day, "1 day", "6 days" — for the screen-reader text. */
function timeInColumnWords(ticket: BoardTicketView): string {
  const hours = Math.floor(hoursInColumn(ticket));
  if (hours < 24) return `${hours} ${hours === 1 ? "hour" : "hours"}`;
  const days = Math.floor(hours / 24);
  return `${days} ${days === 1 ? "day" : "days"}`;
}

function agingClass(ticket: BoardTicketView, status: BoardStatusView): string | null {
  const warn = status.agingWarnHours ?? null;
  const stale = status.agingStaleHours ?? null;
  if (warn === null && stale === null) return null;
  const hours = hoursInColumn(ticket);
  if (stale !== null && hours >= stale) return "aib-age-stale";
  if (warn !== null && hours >= warn) return "aib-age-warn";
  return null;
}

/**
 * An optimistic move: where the card was sent (`to`) and the server status it
 * was sent FROM (`base`). It shows only while the server still says `base` (or
 * an intermediate stop, `via`) — the moment the `tickets` prop says anything
 * else (the move landed, or someone else moved it), the server wins and the
 * entry is dropped. 0.8.0 kept
 * a bare status per card forever, so a card the board had touched ignored
 * every later change to the prop until the board remounted.
 */
interface PendingMove {
  to: string;
  base: string;
  /**
   * Earlier destinations of a card moved again before the server caught up
   * (0.9.0): while the server says `base` OR one of these, the latest move is
   * still on its way and the card keeps showing `to`.
   */
  via: string[];
  /** Which move this is — survives a rebase, so a rollback only ever undoes its own move. */
  seq: number;
}

/**
 * Should the card still show `move.to`? Not once the server says `to` (it
 * landed — the prop now agrees), nor once it says anything outside the
 * move's path (someone else moved it: the server wins).
 */
function stillPending(move: PendingMove | undefined, serverStatus: string | undefined): move is PendingMove {
  return (
    move !== undefined &&
    serverStatus !== undefined &&
    serverStatus !== move.to &&
    (serverStatus === move.base || move.via.includes(serverStatus))
  );
}

/** The server has reached an intermediate stop: start the path from there. */
function rebase(move: PendingMove, serverStatus: string): PendingMove {
  const at = move.via.indexOf(serverStatus);
  return at === -1 ? move : { ...move, base: serverStatus, via: move.via.slice(at + 1) };
}

let moveSeq = 0;

/** The trailing column for cards whose status no column has (0.9.0). */
const ORPHAN_KEY = "\u0000aib-orphan";

export function FeedbackBoard({
  statuses,
  tickets,
  onMove,
  onOpen,
  ticketHref,
  onMoveMany,
  onMoveError,
  theme = "auto",
}: FeedbackBoardProps): ReactElement {
  useBoardStyles();
  const boardId = useId();
  const hintId = `${boardId}-move-hint`;

  const [pending, setPending] = useState<Record<string, PendingMove>>({});
  const [seenTickets, setSeenTickets] = useState(tickets);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const [overColumn, setOverColumn] = useState<string | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [applying, setApplying] = useState(false);
  const [bulkTarget, setBulkTarget] = useState("");
  const [announcement, setAnnouncement] = useState({ text: "", n: 0 });
  const [focusId, setFocusId] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  // The latest server data, for work that finishes after an await.
  const ticketsRef = useRef(tickets);
  useEffect(() => {
    ticketsRef.current = tickets;
  }, [tickets]);

  // A live region only speaks when its text CHANGES; alternate an invisible
  // suffix so the same message twice ("2 tickets moved to Done.") is heard twice.
  const announce = useCallback((text: string) => setAnnouncement((prev) => ({ text, n: prev.n + 1 })), []);

  // New server data: drop every optimistic move the server has moved past,
  // and every ticked card that is no longer on the board. Done during render
  // ("storing information from previous renders"), so it is idempotent.
  if (seenTickets !== tickets) {
    setSeenTickets(tickets);
    const server = new Map(tickets.map((ticket) => [ticket.id, ticket.status]));
    let changed = false;
    const next: Record<string, PendingMove> = {};
    for (const [id, move] of Object.entries(pending)) {
      const status = server.get(id);
      if (!stillPending(move, status)) {
        changed = true;
        continue;
      }
      const moved = rebase(move, status!);
      if (moved !== move) changed = true;
      next[id] = moved;
    }
    if (changed) setPending(next);
    if ([...selected].some((id) => !server.has(id))) {
      setSelected(new Set([...selected].filter((id) => server.has(id))));
    }
  }

  const statusOf = useCallback(
    (ticket: BoardTicketView) => {
      const move = pending[ticket.id];
      return stillPending(move, ticket.status) ? move.to : ticket.status;
    },
    [pending],
  );

  const ordered = [...statuses].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));

  /**
   * Move a set of tickets optimistically. One code path for a single drag, a
   * drag that carries the selection, the bulk bar and the keyboard — the
   * rollback story must not differ between them. Resolves with the ids that
   * actually moved.
   */
  const moveSet = useCallback(
    async (ids: readonly string[], statusKey: string): Promise<string[]> => {
      const moving = ids.filter((id) => {
        const ticket = tickets.find((t) => t.id === id);
        return ticket !== undefined && !busy.has(id) && statusOf(ticket) !== statusKey;
      });
      if (moving.length === 0) return [];

      // A card moved again before the server caught up chains onto its
      // pending move instead of replacing it, so the earlier move's refresh
      // can't snap it back a column.
      const created = new Map<string, PendingMove>();
      const before = new Map<string, PendingMove | undefined>();
      for (const id of moving) {
        const server = tickets.find((t) => t.id === id)!.status;
        const prev = pending[id];
        before.set(id, prev);
        const seq = ++moveSeq;
        created.set(
          id,
          stillPending(prev, server)
            ? { to: statusKey, base: prev.base, via: [...prev.via, prev.to].filter((stop) => stop !== statusKey), seq }
            : { to: statusKey, base: server, via: [], seq },
        );
      }
      setPending((prev) => ({ ...prev, ...Object.fromEntries(created) }));
      setBusy((prev) => new Set([...prev, ...moving]));
      const label = statuses.find((status) => status.key === statusKey)?.label ?? statusKey;
      const numberOf = (id: string) => tickets.find((t) => t.id === id)?.ticketNumber ?? id;

      const rollBack = (failedIds: readonly string[]) => {
        // The rollback remounts a card's title in its old column; if that
        // title has focus (a keyboard move), keep it there, not on <body>.
        const active = document.activeElement;
        const focused = active instanceof HTMLElement ? active.dataset.aibOpen : undefined;
        if (focused !== undefined && failedIds.includes(focused)) setFocusId(focused);
        // Back to what the board showed before THIS move — never write a
        // status in, or the card would ignore the next refresh.
        setPending((prev) => {
          const next = { ...prev };
          for (const id of failedIds) {
            if (next[id]?.seq !== created.get(id)?.seq) continue;
            // Put back what showed before THIS move — unless the server has
            // since moved past it, in which case the server's word stands.
            const restore = before.get(id);
            const server = ticketsRef.current.find((t) => t.id === id)?.status;
            if (restore && stillPending(restore, server)) next[id] = rebase(restore, server!);
            else delete next[id];
          }
          return next;
        });
      };

      let failed: string[] = [];
      try {
        if (moving.length === 1) {
          await onMove(moving[0]!, statusKey);
        } else {
          // >1 ids only happens with onMoveMany: the selection UI does not
          // render without it.
          const result = await onMoveMany!(moving, statusKey);
          if (result && Array.isArray(result.failed)) {
            failed = result.failed.filter((id) => moving.includes(id));
          }
        }
      } catch (error) {
        rollBack(moving);
        announce(
          moving.length === 1
            ? `${numberOf(moving[0]!)} could not be moved.`
            : `${moving.length} tickets could not be moved.`,
        );
        onMoveError?.(error, [...moving], statusKey);
        return [];
      } finally {
        setBusy((prev) => {
          const next = new Set(prev);
          for (const id of moving) next.delete(id);
          return next;
        });
      }

      const landed = moving.filter((id) => !failed.includes(id));
      setSelected((prev) => {
        if (prev.size === 0) return prev;
        const next = new Set(prev);
        for (const id of landed) next.delete(id);
        return next.size === prev.size ? prev : next;
      });
      if (failed.length > 0) {
        rollBack(failed);
        announce(
          landed.length === 0
            ? failed.length === 1
              ? `${numberOf(failed[0]!)} could not be moved.`
              : `${failed.length} tickets could not be moved.`
            : `${landed.length} moved to ${label}; ${failed.length === 1 ? numberOf(failed[0]!) : `${failed.length} tickets`} could not be moved.`,
        );
        onMoveError?.(
          new Error(`${failed.length} of ${moving.length} tickets could not be moved`),
          failed,
          statusKey,
        );
      } else {
        announce(
          landed.length === 1 ? `${numberOf(landed[0]!)} moved to ${label}.` : `${landed.length} tickets moved to ${label}.`,
        );
      }
      return landed;
    },
    [tickets, busy, pending, statusOf, onMove, onMoveMany, onMoveError, statuses, announce],
  );

  const handleDrop = useCallback(
    async (statusKey: string) => {
      setOverColumn(null);
      const ticketId = draggingId;
      setDraggingId(null);
      if (!ticketId) return;
      // Dragging a selected card carries the whole selection; dragging an
      // unselected one moves just it, leaving the selection alone.
      const ids = onMoveMany && selected.has(ticketId) ? [...selected] : [ticketId];
      await moveSet(ids, statusKey);
    },
    [draggingId, selected, onMoveMany, moveSet],
  );

  const barHasFocus = () => barRef.current?.contains(document.activeElement) ?? false;

  const applyBulk = useCallback(async () => {
    if (!bulkTarget || selected.size === 0) return;
    const hadFocus = barHasFocus();
    setApplying(true);
    try {
      const before = selected.size;
      const landed = await moveSet([...selected], bulkTarget);
      setBulkTarget("");
      // The bar unmounts when the selection empties; don't let focus fall to
      // <body> with it — go to the first moved card (or the board). If some
      // cards are still ticked the bar stays, and so does focus (on its select).
      if (hadFocus) {
        if (landed.length < before) barRef.current?.querySelector<HTMLElement>(".aib-select")?.focus();
        else if (landed[0]) setFocusId(landed[0]);
        else rootRef.current?.focus();
      }
    } finally {
      setApplying(false);
    }
  }, [bulkTarget, selected, moveSet]);

  const clearSelection = () => {
    const hadFocus = barHasFocus();
    const first = [...selected][0];
    setSelected(new Set());
    // Cleared cards don't move: land on the first of them, or the board.
    if (hadFocus) {
      if (first && findHandle(rootRef.current, first)) setFocusId(first);
      else rootRef.current?.focus();
    }
  };

  const toggleTicket = useCallback((ticketId: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(ticketId)) next.delete(ticketId);
      else next.add(ticketId);
      return next;
    });
  }, []);

  /** Alt+← / Alt+→ on a card's title moves it one column — the keyboard's drag. */
  const onCardKeyDown = (event: ReactKeyboardEvent, ticket: BoardTicketView) => {
    if (!event.altKey || (event.key !== "ArrowLeft" && event.key !== "ArrowRight")) return;
    // Consumed even with no column that way: unhandled, Alt+← / Alt+→ is the
    // browser's Back / Forward on Windows and Linux, and one press past the
    // first column would navigate away from the board.
    event.preventDefault();
    if (busy.has(ticket.id)) {
      announce(`${ticket.ticketNumber} is still moving.`);
      return;
    }
    const at = ordered.findIndex((status) => status.key === statusOf(ticket));
    const target = ordered[at + (event.key === "ArrowRight" ? 1 : -1)];
    if (at === -1 || !target) {
      announce(
        at === -1
          ? `${ticket.ticketNumber}'s status has no column. Drag it to one, or open it and set its status.`
          : "No column that way.",
      );
      return;
    }
    setFocusId(ticket.id);
    void moveSet([ticket.id], target.key);
  };

  // The moved card re-renders in another column, which drops focus; put it
  // back on the card's title so a keyboard user can keep moving it.
  useEffect(() => {
    if (!focusId) return;
    const handle = findHandle(rootRef.current, focusId) ?? rootRef.current;
    if (handle && document.activeElement !== handle) handle.focus();
    setFocusId(null);
  }, [focusId, pending]);

  const openFromTitle = (event: ReactMouseEvent, ticket: BoardTicketView) => {
    event.stopPropagation();
    // A link with a modifier (new tab, new window) is the browser's job.
    if (ticketHref && (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0)) return;
    if (onOpen) {
      event.preventDefault();
      onOpen(ticket);
    }
  };

  const keys = new Set(ordered.map((status) => status.key));
  const orphans = tickets.filter((ticket) => !keys.has(statusOf(ticket)));
  const columns: BoardStatusView[] =
    orphans.length > 0
      ? [...ordered, { key: ORPHAN_KEY, label: "Unrecognised status", color: null }]
      : ordered;

  return (
    <div
      ref={rootRef}
      className={`aib-root${onMoveMany && selected.size > 0 ? " aib-selecting" : ""}`}
      data-aib-theme={theme}
      tabIndex={-1}
      role="region"
      aria-label="Ticket board"
    >
      <BoardStyles />
      {/* `hidden`: read only as each title's description, never as stray text. */}
      <span id={hintId} hidden>
        Alt plus left or right arrow moves this ticket one column left or right.
      </span>
      <div className="aib-board">
        {columns.map((status, index) => {
          const isOrphan = status.key === ORPHAN_KEY;
          const cards = isOrphan ? orphans : tickets.filter((ticket) => statusOf(ticket) === status.key);
          const limit = status.wipLimit ?? null;
          const wipState =
            limit === null ? null : cards.length > limit ? "over" : cards.length === limit ? "full" : null;
          const selectedHere = cards.filter((card) => selected.has(card.id)).length;
          // By position, not key: a status key may contain spaces or collide.
          const titleId = `${boardId}-col-${index}`;
          const countWords =
            `${cards.length} ${cards.length === 1 ? "ticket" : "tickets"}` +
            (limit === null
              ? ""
              : `, limit ${limit}${wipState === "over" ? ", over the limit" : wipState === "full" ? ", at the limit" : ""}`);
          return (
            <div
              key={status.key}
              role="group"
              aria-labelledby={titleId}
              className={`aib-col${overColumn === status.key ? " aib-over" : ""}${isOrphan ? " aib-col-orphan" : ""}`}
              onDragOver={(event) => {
                // An unknown status is somewhere to drag FROM, never to.
                if (isOrphan) return;
                event.preventDefault();
                setOverColumn(status.key);
              }}
              onDragLeave={() => setOverColumn((current) => (current === status.key ? null : current))}
              onDrop={(event) => {
                if (isOrphan) return;
                event.preventDefault();
                void handleDrop(status.key);
              }}
            >
              <div className={`aib-col-head${wipState ? ` aib-wip-${wipState}` : ""}`}>
                {onMoveMany && cards.length > 0 ? (
                  <input
                    type="checkbox"
                    className="aib-check aib-col-check"
                    aria-label={`Select all in ${status.label}`}
                    checked={selectedHere > 0 && selectedHere === cards.length}
                    ref={(el) => {
                      // The tri-state: some-but-not-all renders as indeterminate,
                      // which only exists as a DOM property.
                      if (el) el.indeterminate = selectedHere > 0 && selectedHere < cards.length;
                    }}
                    onChange={() =>
                      setSelected((prev) => {
                        const next = new Set(prev);
                        const all = selectedHere === cards.length;
                        for (const card of cards) {
                          if (all) next.delete(card.id);
                          else next.add(card.id);
                        }
                        return next;
                      })
                    }
                  />
                ) : null}
                <span
                  className="aib-col-dot"
                  aria-hidden="true"
                  style={{ background: status.color ?? "var(--aib-line-strong)" }}
                />
                <span id={titleId} className="aib-col-title">
                  {status.label}
                </span>
                <span
                  className={`aib-col-count${wipState ? ` aib-wip-${wipState}` : ""}`}
                  title={
                    wipState === "over"
                      ? "Over the WIP limit"
                      : wipState === "full"
                        ? "At the WIP limit"
                        : undefined
                  }
                >
                  <span aria-hidden="true">{limit === null ? cards.length : `${cards.length}/${limit}`}</span>
                  <span className="aib-sr">{countWords}</span>
                </span>
              </div>
              <div className="aib-col-body">
                {cards.length === 0 ? (
                  <div className="aib-empty">No tickets</div>
                ) : (
                  // role="list": Safari drops the list role from a list-style:none <ul>.
                  <ul role="list" className="aib-col-list">
                    {cards.map((ticket) => {
                      const age = isOrphan ? null : agingClass(ticket, status);
                      const archived = ticket.archivedAt != null;
                      const isBusy = busy.has(ticket.id);
                      const href = ticketHref?.(ticket);
                      const shot = ticket.annotatedScreenshotUrl ?? ticket.screenshotUrl;
                      const days = Math.floor(hoursInColumn(ticket) / 24);
                      return (
                        <li
                          key={ticket.id}
                          className={`aib-card${draggingId === ticket.id ? " aib-dragging" : ""}${isBusy ? " aib-busy" : ""}${archived ? " aib-archived" : ""}`}
                          aria-busy={isBusy || undefined}
                          draggable={!isBusy}
                          onDragStart={(event) => {
                            // Firefox needs data on the transfer to start a drag;
                            // it is also what lands if the card is dropped outside.
                            event.dataTransfer.setData("text/plain", ticket.ticketNumber);
                            event.dataTransfer.effectAllowed = "move";
                            setDraggingId(ticket.id);
                          }}
                          onDragEnd={() => setDraggingId(null)}
                          onClick={onOpen ? () => onOpen(ticket) : undefined}
                          style={onOpen ? { cursor: "pointer" } : undefined}
                        >
                          <div className={`aib-card-top${onMoveMany ? " aib-has-check" : ""}`}>
                            {onMoveMany ? (
                              <input
                                type="checkbox"
                                className="aib-check"
                                aria-label={`Select ${ticket.ticketNumber}`}
                                checked={selected.has(ticket.id)}
                                onChange={() => toggleTicket(ticket.id)}
                                onClick={(event) => event.stopPropagation()}
                              />
                            ) : null}
                            {/* The mark ages with time-in-column against this
                                column's own thresholds — a Done column with no
                                thresholds never nags about finished work. */}
                            {age ? (
                              <>
                                <span className={`aib-age ${age}`} aria-hidden="true" title={`${days}d in this column`} />
                                <span className="aib-sr">
                                  {`${age === "aib-age-stale" ? "Stale" : "Aging"}: ${timeInColumnWords(ticket)} in this column.`}
                                </span>
                              </>
                            ) : null}
                            <span className="aib-num">{ticket.ticketNumber}</span>
                            {archived ? <span className="aib-archived-chip">archived</span> : null}
                            {/* The reporter answered and nobody has opened the ticket
                                since. THE signal triage scans for — opening the panel
                                clears it via the consumer's markRead call. */}
                            {ticket.hasUnreadReporterReply ? <span className="aib-unread">reply</span> : null}
                            <span className={`aib-chip aib-chip-${ticket.priority}`}>{ticket.priority}</span>
                          </div>
                          <div className="aib-card-title">
                            {href ? (
                              <a
                                className="aib-card-open"
                                href={href}
                                data-aib-open={ticket.id}
                                draggable={false}
                                aria-keyshortcuts="Alt+ArrowLeft Alt+ArrowRight"
                                aria-describedby={isOrphan ? undefined : hintId}
                                onClick={(event) => openFromTitle(event, ticket)}
                                onKeyDown={(event) => onCardKeyDown(event, ticket)}
                              >
                                {ticket.title}
                              </a>
                            ) : onOpen ? (
                              <button
                                type="button"
                                className="aib-card-open"
                                data-aib-open={ticket.id}
                                aria-keyshortcuts="Alt+ArrowLeft Alt+ArrowRight"
                                aria-describedby={isOrphan ? undefined : hintId}
                                onClick={(event) => openFromTitle(event, ticket)}
                                onKeyDown={(event) => onCardKeyDown(event, ticket)}
                              >
                                {ticket.title}
                              </button>
                            ) : (
                              ticket.title
                            )}
                          </div>
                          <div className="aib-card-meta">
                            <span>{ageOf(ticket.createdAt)}</span>
                            {isOrphan ? <span>status “{ticket.status}”</span> : null}
                            {ticket.pagePathname ? <span>{ticket.pagePathname}</span> : null}
                            {ticket.assignee ? <span className="aib-assignee">{ticket.assignee}</span> : null}
                            {ticket.reporterName || ticket.reporterEmail ? (
                              <span>{ticket.reporterName ?? ticket.reporterEmail}</span>
                            ) : null}
                            {shot ? (
                              <a
                                href={shot}
                                target="_blank"
                                rel="noreferrer"
                                draggable={false}
                                aria-label={`Screenshot for ${ticket.ticketNumber} (opens in a new tab)`}
                                onClick={(event) => event.stopPropagation()}
                              >
                                screenshot ↗
                              </a>
                            ) : null}
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <div className="aib-sr" role="status">
        {announcement.text ? <span key={announcement.n}>{announcement.text}</span> : null}
      </div>

      {onMoveMany && selected.size > 0 ? (
        <div ref={barRef} className="aib-bulkbar" role="group" aria-label="Bulk actions">
          <span className="aib-bulkbar-count">{selected.size} selected</span>
          <select
            className="aib-select"
            aria-label="Move selection to"
            value={bulkTarget}
            onChange={(event) => setBulkTarget(event.target.value)}
          >
            <option value="">Move to…</option>
            {ordered.map((status) => (
              <option key={status.key} value={status.key}>
                {status.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="aib-bulk-apply"
            aria-busy={applying || undefined}
            disabled={!bulkTarget || applying}
            onClick={() => void applyBulk()}
          >
            {applying ? "Moving…" : "Apply"}
          </button>
          <button type="button" className="aib-bulk-clear" onClick={clearSelection}>
            Clear
          </button>
        </div>
      ) : null}
    </div>
  );
}
