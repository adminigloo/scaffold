import { useEffect, version as reactVersion, type ReactElement } from "react";
import { DARK_PALETTE, LIGHT_PALETTE, paletteDeclarations } from "./board-tokens";
import { EXTRA_CSS } from "./board-styles-extra";

/**
 * The board's stylesheet and the two ways it reaches the page (moved out of
 * board.tsx in 0.11.0 so the toolbar, the dialogs and the ./admin screens
 * share it). Every surface's outer element is in TOKEN_SCOPE.
 */

const STYLE_ID = "aib-styles";

/** React 19 can render a deduplicated, hoisted <style> during SSR; React 18 injects after mount. */
const HOISTED_STYLES = Number.parseInt(reactVersion, 10) >= 19;

/** Every theme-able declaration sits under `:where()` — zero specificity, so a
 *  host's own `.aib-root { --aib-accent: … }` wins in any order, either theme.
 *  Declared ONLY on the outermost element of each surface (the board's root,
 *  the panel's layer around scrim + dialog): a token set on an inner element
 *  would re-declare the defaults beneath a host's override. */
const TOKEN_SCOPE = ":where(.aib-root, .aib-panel-layer, .aib-toolbar, .aib-dialog-layer, .aib-admin)";

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
const BASE_CSS = `
${TOKEN_SCOPE} { ${paletteDeclarations(LIGHT_PALETTE)} color-scheme: light;
  --aib-z-bar: 40; --aib-bar-bottom: 16px; --aib-bar-left: 50%; --aib-z-panel: 2147483003; }
@media (prefers-color-scheme: dark) {
  ${TOKEN_SCOPE}:where(:not([data-aib-theme="light"])) { ${paletteDeclarations(DARK_PALETTE)} color-scheme: dark; }
}
${TOKEN_SCOPE}:where([data-aib-theme="dark"]) { ${paletteDeclarations(DARK_PALETTE)} color-scheme: dark; }

/* Host-overridable without a specificity fight, like the tokens. */
:where(.aib-root, .aib-panel-layer, .aib-toolbar, .aib-dialog-layer, .aib-admin) { color: var(--aib-ink);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
.aib-root:focus { outline: none; }
/* Containing blocks for the screen-reader-only text (.aib-sr is absolutely
   positioned). Without a positioned ancestor INSIDE the board's horizontal
   scroller, the column counts and aging words escaped it and widened the
   whole page — 0.9.0 made a 412px phone page 999px wide. */
.aib-root, .aib-col, .aib-card { position: relative; }
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

/* The connected workspace's toolbar (0.10.0): a sibling of the board, so it
   carries the token scope itself rather than nesting the board inside it. */
.aib-toolbar { display: flex; flex-direction: column; gap: 10px; margin-bottom: 12px; }
.aib-toolbar-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.aib-toolbar-note { font-size: 13px; color: var(--aib-ink-muted); }
.aib-tool-btn { border: 1px solid var(--aib-ink-faint); border-radius: 8px; background: var(--aib-surface); color: var(--aib-ink);
  font: inherit; font-size: 13px; padding: 7px 12px; cursor: pointer; min-height: 44px; text-decoration: none;
  display: inline-flex; align-items: center; box-sizing: border-box; }
.aib-tool-btn:hover { background: var(--aib-surface-2); }
.aib-tool-btn:disabled { color: var(--aib-ink-faint); cursor: default; }
.aib-tool-btn:focus-visible { outline: 2px solid var(--aib-accent); outline-offset: 2px; }
.aib-tool-primary { border-color: transparent; background: var(--aib-accent); color: var(--aib-on-accent); font-weight: 600; }
.aib-tool-primary:hover { background: var(--aib-accent-strong); }
/* After :disabled on .aib-tool-btn, which outranks .aib-tool-primary and left
   faint text on the accent (0.11.0 review): the disabled Apply/Send pair. */
.aib-tool-primary:disabled { background: var(--aib-ink-faint); color: var(--aib-on-accent); }
.aib-notice { border: 1px solid var(--aib-warn); border-radius: 10px; padding: 10px 12px; font-size: 13px;
  background: var(--aib-surface); color: var(--aib-ink); display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
`;

/** The whole stylesheet: the board's own, then the 0.11.0 surfaces'. */
export const CSS_TEXT = BASE_CSS + EXTRA_CSS;

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
export function BoardStyles(): ReactElement | null {
  if (!HOISTED_STYLES) return null;
  return (
    <style href={STYLE_ID} precedence="medium">
      {CSS_TEXT}
    </style>
  );
}

export function useBoardStyles(): void {
  useEffect(() => {
    if (!HOISTED_STYLES) injectStyles();
  }, []);
}
