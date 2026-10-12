import { injectStyleTag, type InjectStylesOptions } from "../styles.js";

/**
 * The staff screens' stylesheet, on top of the widget's. An admin root carries
 * BOTH `aiew-root` and `aiew-admin`: it inherits the widget's tokens (light,
 * dark, the business's colour, any buyer override on `.aiew-root`), resets,
 * buttons, inputs, chips, notices and dialogs — and this sheet adds what staff
 * need: tabs, the queue, cards, the editor's two columns, tables, toasts and
 * switches. Every class is `aiew-`-prefixed.
 */

const STYLE_ID = "aiew-admin-styles";

const CSS_TEXT = `
.aiew-root.aiew-admin { width: 100%; background: var(--aiew-ground); font-size: 14.5px; border-radius: var(--aiew-radius); }
.aiew-admin-inner { padding: 16px; display: grid; grid-template-columns: minmax(0, 1fr); gap: 16px; }
@media (max-width: 480px) { .aiew-admin-inner { padding: 12px; gap: 12px; } }
.aiew-admin-head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px 16px; }
.aiew-admin-title { font-size: 21px; font-weight: 700; letter-spacing: -0.01em; line-height: 1.25; color: var(--aiew-ink); }
.aiew-grow { flex: 1 1 auto; min-width: 0; }
.aiew-muted { color: var(--aiew-muted); }
.aiew-ok-text { color: var(--aiew-ok); font-weight: 600; font-size: 14px; }
.aiew-danger-text { color: var(--aiew-danger); font-weight: 600; font-size: 14px; }
.aiew-dirty { color: var(--aiew-warn); font-weight: 600; font-size: 13.5px; }
.aiew-icon-btn { min-width: 44px; padding: 8px; }
.aiew-count {
  display: inline-flex; align-items: center; justify-content: center; min-width: 22px; height: 22px; padding: 0 6px;
  border-radius: 999px; background: var(--aiew-ground); color: var(--aiew-ink); border: 1px solid var(--aiew-line); font-size: 12.5px; font-weight: 700;
}

/* Tabs */
.aiew-tabs { display: flex; flex-wrap: wrap; gap: 4px; border-bottom: 1px solid var(--aiew-line-strong); }
.aiew-tab {
  min-height: 44px; padding: 10px 16px; cursor: pointer; border: 0; border-bottom: 3px solid transparent; margin-bottom: -1px;
  background: transparent; color: var(--aiew-muted); font-weight: 700; font-size: 15px;
}
.aiew-tab:hover { color: var(--aiew-ink); }
.aiew-tab[aria-selected="true"] { color: var(--aiew-accent-ink); border-bottom-color: var(--aiew-accent); }

/* Filter chips (toggle buttons) */
.aiew-filter {
  display: inline-flex; align-items: center; gap: 8px; min-height: 44px; padding: 6px 14px; cursor: pointer;
  border: 1px solid var(--aiew-line-strong); border-radius: 999px; background: var(--aiew-surface); color: var(--aiew-ink); font-weight: 600; font-size: 14px;
}
.aiew-filter[aria-pressed="true"] { background: var(--aiew-accent-soft); border-color: var(--aiew-accent); color: var(--aiew-accent-ink); }

/* Cards */
.aiew-panel { background: var(--aiew-surface); border: 1px solid var(--aiew-line); border-radius: var(--aiew-radius); box-shadow: var(--aiew-shadow); min-width: 0; }
.aiew-panel-head { padding: 16px 18px 0; display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 4px 12px; }
.aiew-panel-title { font-size: 16.5px; font-weight: 700; color: var(--aiew-ink); }
.aiew-panel-hint { flex-basis: 100%; font-size: 13.5px; color: var(--aiew-muted); }
.aiew-panel-body { padding: 14px 18px 18px; display: grid; grid-template-columns: minmax(0, 1fr); gap: 14px; }
@media (max-width: 480px) { .aiew-panel-head { padding: 14px 14px 0; } .aiew-panel-body { padding: 12px 14px 16px; } }
.aiew-grid2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 220px), 1fr)); gap: 14px; }
.aiew-grid3 { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 150px), 1fr)); gap: 12px; }
.aiew-number { max-width: 10em; }
.aiew-inline { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.aiew-inline > .aiew-input { width: auto; flex: 0 1 8em; }
.aiew-sub-box { display: grid; gap: 12px; padding: 12px 14px; border: 1px solid var(--aiew-line); border-radius: var(--aiew-radius-sm); background: var(--aiew-ground); min-width: 0; }

/* The queue */
.aiew-search { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.aiew-search .aiew-input { flex: 1 1 220px; }
.aiew-search select.aiew-input { flex: 0 1 220px; }
.aiew-rows { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
.aiew-qrow {
  display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 4px 12px; align-items: center; width: 100%; min-height: 44px; padding: 12px 14px;
  text-align: left; cursor: pointer; text-decoration: none; color: var(--aiew-ink);
  background: var(--aiew-surface); border: 1px solid var(--aiew-line); border-radius: var(--aiew-radius-sm);
}
.aiew-root a.aiew-qrow { color: var(--aiew-ink); font-weight: 400; }
.aiew-qrow:hover { border-color: var(--aiew-accent); }
.aiew-qrow-main { display: grid; gap: 2px; min-width: 0; }
.aiew-qrow-who { font-weight: 700; overflow-wrap: anywhere; }
.aiew-qrow-meta { display: flex; flex-wrap: wrap; gap: 4px 10px; font-size: 13.5px; color: var(--aiew-muted); align-items: center; }
.aiew-qrow-side { display: grid; gap: 4px; justify-items: end; text-align: right; }
.aiew-qrow-amount { font-weight: 700; font-variant-numeric: tabular-nums; }
@media (max-width: 480px) { .aiew-qrow { grid-template-columns: minmax(0, 1fr); } .aiew-qrow-side { justify-items: start; text-align: left; } }

/* Tables */
.aiew-table-wrap { overflow-x: auto; }
.aiew-table { width: 100%; border-collapse: collapse; font-size: 14px; }
.aiew-table th { text-align: left; font-size: 12px; font-weight: 700; letter-spacing: .05em; text-transform: uppercase; color: var(--aiew-muted); padding: 6px 8px; border-bottom: 1px solid var(--aiew-line-strong); white-space: nowrap; }
.aiew-table td { padding: 8px; border-bottom: 1px solid var(--aiew-line); vertical-align: top; overflow-wrap: anywhere; }
.aiew-table .aiew-num { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
.aiew-table tfoot td { font-weight: 700; border-bottom: 0; }
/* The supplies library on a phone: each row a card. Name and cost on one line,
   unit, supplier and what uses it under them, Edit and Retire in reach; no
   sideways scroll and no word broken mid-letter (review EST-R08). */
@media (max-width: 600px) {
  .aiew-supply-wrap { overflow-x: visible; }
  .aiew-supply-table thead { display: none; }
  .aiew-supply-table, .aiew-supply-table tbody { display: block; width: 100%; }
  .aiew-supply-table tr { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 4px 12px; padding: 12px 0; border-bottom: 1px solid var(--aiew-line); }
  .aiew-supply-table td { display: block; padding: 0; border: 0; overflow-wrap: break-word; }
  .aiew-supply-table td[data-cell="name"] { grid-column: 1; grid-row: 1; }
  .aiew-supply-table td[data-cell="cost"] { grid-column: 2; grid-row: 1; font-weight: 700; }
  .aiew-supply-table td[data-cell="unit"], .aiew-supply-table td[data-cell="supplier"], .aiew-supply-table td[data-cell="used"] { grid-column: 1 / -1; font-size: 13.5px; color: var(--aiew-muted); }
  .aiew-supply-table td[data-cell="unit"]::before, .aiew-supply-table td[data-cell="supplier"]:not(:empty)::before, .aiew-supply-table td[data-cell="used"]::before { content: attr(data-label) ": "; font-weight: 600; }
  .aiew-supply-table td[data-cell="supplier"]:empty { display: none; }
  .aiew-supply-table td[data-cell="actions"], .aiew-supply-table td[data-cell="form"] { grid-column: 1 / -1; padding-top: 6px; }
}

/* The product list and editor */
.aiew-plist { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
.aiew-pitem { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; padding: 10px 12px; border: 1px solid var(--aiew-line); border-radius: var(--aiew-radius-sm); background: var(--aiew-surface); }
.aiew-pitem-main { flex: 1 1 220px; display: grid; gap: 4px; min-width: 0; }
.aiew-pitem-name { font-weight: 700; }
.aiew-tags { display: flex; flex-wrap: wrap; gap: 6px; }
.aiew-editor { display: grid; grid-template-columns: minmax(0, 1fr); gap: 16px; align-items: start; }
@media (min-width: 1000px) { .aiew-editor { grid-template-columns: minmax(0, 1fr) minmax(320px, 400px); } .aiew-editor-side { position: sticky; top: 12px; } }
.aiew-editor-main, .aiew-editor-side { display: grid; grid-template-columns: minmax(0, 1fr); gap: 16px; min-width: 0; }
.aiew-supply-row { display: grid; grid-template-columns: minmax(0, 2fr) minmax(90px, 1fr) minmax(0, 1.6fr) auto auto; gap: 8px; align-items: end; padding: 10px 0; border-bottom: 1px solid var(--aiew-line); }
.aiew-supply-row:last-child { border-bottom: 0; }
@media (max-width: 720px) { .aiew-supply-row { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); } }
/* The editor's price bar: on a phone the editor is one long column with "Test
   a quote" at the bottom, so the price and margin stay in sight at the bottom
   of the screen while the owner edits (review EST-R08). */
.aiew-sticky-price {
  position: sticky; bottom: 0; z-index: 2; display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; padding: 10px 14px;
  background: var(--aiew-surface); border: 1px solid var(--aiew-line-strong); border-radius: var(--aiew-radius-sm); box-shadow: var(--aiew-shadow);
  font-weight: 700; font-variant-numeric: tabular-nums;
}
@media (min-width: 1000px) { .aiew-sticky-price { display: none; } }
.aiew-supply-amount { font-variant-numeric: tabular-nums; font-weight: 600; min-height: 44px; display: flex; align-items: center; }
.aiew-option { display: grid; gap: 10px; padding: 12px; border: 1px solid var(--aiew-line); border-radius: var(--aiew-radius-sm); background: var(--aiew-ground); }
.aiew-value-row { display: grid; grid-template-columns: auto minmax(0, 2fr) minmax(90px, 1fr) auto auto auto; gap: 8px; align-items: center; }
@media (max-width: 720px) { .aiew-value-row { grid-template-columns: auto minmax(0, 1fr) minmax(0, 1fr); } }
.aiew-radio { display: inline-flex; align-items: center; justify-content: center; min-width: 44px; min-height: 44px; cursor: pointer; }
.aiew-radio input { width: 20px; height: 20px; margin: 0; accent-color: var(--aiew-accent); }
.aiew-swatches { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 200px), 1fr)); gap: 10px; }
.aiew-swatch { display: grid; gap: 8px; padding: 12px; border-radius: var(--aiew-radius-sm); background: var(--aiew-surface); border: 1px solid var(--aiew-line); color: var(--aiew-ink); }
.aiew-color-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.aiew-color-row input[type="color"] { width: 54px; height: 44px; padding: 2px; border: 1px solid var(--aiew-line-strong); border-radius: var(--aiew-radius-sm); background: var(--aiew-surface); cursor: pointer; }

/* The estimate editor */
.aiew-photo-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); gap: 8px; list-style: none; margin: 0; padding: 0; }
.aiew-photo-tile { display: grid; gap: 6px; }
.aiew-photo-open { padding: 0; border: 1px solid var(--aiew-line); border-radius: var(--aiew-radius-sm); background: var(--aiew-surface); cursor: zoom-in; overflow: hidden; min-height: 44px; }
.aiew-photo-open img { display: block; width: 100%; height: 110px; object-fit: cover; }
.aiew-lightbox-img { display: block; max-width: 100%; max-height: 70vh; margin: 0 auto; border-radius: var(--aiew-radius-sm); }
.aiew-line { display: grid; gap: 12px; padding: 14px; border: 1px solid var(--aiew-line); border-radius: var(--aiew-radius-sm); background: var(--aiew-surface); }
.aiew-line-head { display: flex; flex-wrap: wrap; align-items: flex-start; justify-content: space-between; gap: 8px 12px; }
.aiew-line-total { font-weight: 800; font-size: 17px; font-variant-numeric: tabular-nums; }
.aiew-reading-box { display: grid; grid-template-columns: 96px minmax(0, 1fr); gap: 10px; padding: 10px; border-radius: var(--aiew-radius-sm); background: var(--aiew-ground); border: 1px solid var(--aiew-line); }
.aiew-reading-box img { width: 96px; height: 72px; object-fit: cover; border-radius: 6px; }
@media (max-width: 480px) { .aiew-reading-box { grid-template-columns: minmax(0, 1fr); } }
.aiew-actionbar { display: flex; flex-wrap: wrap; gap: 8px; }
.aiew-timeline { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; font-size: 14px; }
.aiew-timeline li { display: flex; flex-wrap: wrap; gap: 4px 12px; }
.aiew-timeline time { color: var(--aiew-muted); min-width: 11em; }
.aiew-kv { display: grid; grid-template-columns: 120px minmax(0, 1fr); gap: 6px 12px; }
.aiew-kv dt { font-size: 12.5px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; color: var(--aiew-muted); padding-top: 2px; }
.aiew-kv dd { overflow-wrap: anywhere; min-width: 0; }
@media (max-width: 480px) { .aiew-kv { grid-template-columns: minmax(0, 1fr); } }

/* Keys */
.aiew-key { display: grid; gap: 8px; padding: 12px 14px; border: 1px solid var(--aiew-line); border-radius: var(--aiew-radius-sm); background: var(--aiew-surface); }
.aiew-key[data-revoked] { background: var(--aiew-ground); color: var(--aiew-muted); }

/* Switches and checks */
.aiew-check { display: flex; align-items: flex-start; gap: 10px; min-height: 44px; padding: 10px 0; cursor: pointer; }
.aiew-check input { flex: none; width: 20px; height: 20px; margin: 1px 0 0; accent-color: var(--aiew-accent); }
.aiew-switch { display: flex; align-items: flex-start; gap: 12px; min-height: 44px; padding: 8px 0; cursor: pointer; }
.aiew-switch input { flex: none; appearance: none; -webkit-appearance: none; width: 44px; height: 26px; margin: 0; border-radius: 999px; position: relative; cursor: pointer;
  background: var(--aiew-line-strong); border: 0; transition: background .12s ease; }
.aiew-switch input::after { content: ""; position: absolute; top: 3px; left: 3px; width: 20px; height: 20px; border-radius: 50%; background: var(--aiew-surface); transition: transform .12s ease; }
.aiew-switch input:checked { background: var(--aiew-accent); }
.aiew-switch input:checked::after { transform: translateX(18px); }
.aiew-switch input:disabled { opacity: .55; cursor: not-allowed; }
.aiew-switch-text { display: grid; gap: 2px; }
.aiew-switch-text strong { font-weight: 600; }

/* Toasts */
.aiew-toasts { position: fixed; z-index: 2147483001; left: 50%; bottom: 16px; transform: translateX(-50%); width: min(480px, calc(100vw - 32px)); display: grid; gap: 8px; pointer-events: none; }
.aiew-toast { pointer-events: auto; display: flex; align-items: flex-start; gap: 10px; padding: 10px 10px 10px 14px; border-radius: var(--aiew-radius-sm); box-shadow: var(--aiew-shadow); border: 1px solid var(--aiew-line); font-size: 14px; }
.aiew-toast-text { flex: 1 1 auto; padding-top: 10px; overflow-wrap: anywhere; }
.aiew-toast-ok { background: var(--aiew-ok-soft); color: var(--aiew-ok); }
.aiew-toast-warn { background: var(--aiew-warn-soft); color: var(--aiew-warn); }
.aiew-toast-error { background: var(--aiew-danger-soft); color: var(--aiew-danger); }
.aiew-toast .aiew-dialog-close { background: transparent; border-color: transparent; color: inherit; }
`;

/** Add `<style id="aiew-admin-styles">` once (the widget's sheet is injected too, by every admin component). */
export function injectEstimatorAdminStyles(options: InjectStylesOptions = {}): void {
  injectStyleTag(STYLE_ID, CSS_TEXT, options.nonce);
}

/** The admin stylesheet text (render `estimatorWidgetCss()` first), for SSR or a shadow root. */
export function estimatorAdminCss(): string {
  return CSS_TEXT;
}
