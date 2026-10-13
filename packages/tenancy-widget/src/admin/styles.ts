import { injectStyleTag, type InjectStylesOptions } from "../styles.js";

/**
 * The operator console's stylesheet, on top of the widget's. An admin root
 * carries BOTH `aitw-root` and `aitw-admin`: it inherits the widget's tokens
 * (light, dark, and any buyer override on `.aitw-root`), resets, buttons,
 * inputs, notices, tables and dialogs, and this sheet adds what staff need:
 * the filter bar, the wider table breakpoint, the pager and the fact list.
 * Every class is `aitw-`-prefixed.
 */

const STYLE_ID = "aitw-admin-styles";

const CSS_TEXT = `
.aitw-root.aitw-admin { font-size: 14.5px; }
.aitw-toolbar { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 10px 14px; }
.aitw-toolbar > .aitw-field { flex: 1 1 180px; }
.aitw-toolbar > .aitw-field[data-grow] { flex: 3 1 280px; }
.aitw-toolbar > .aitw-check { flex: 0 0 auto; }
.aitw-pager { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px 14px; }
.aitw-pager-text { color: var(--aitw-muted); font-variant-numeric: tabular-nums; }
.aitw-empty { padding: 20px 8px; text-align: center; color: var(--aitw-muted); }
/* A text link with a thumb-sized target (44px tall) that still reads as a link. */
.aitw-tap-link { display: inline-flex; align-items: center; min-height: 44px; }
.aitw-back { justify-self: start; padding-left: 0; }
.aitw-detail-head { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; }
.aitw-kv { display: grid; grid-template-columns: minmax(120px, 30%) minmax(0, 1fr); gap: 8px 14px; }
.aitw-kv dt { font-size: 12.5px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; color: var(--aitw-muted); padding-top: 2px; }
.aitw-kv dd { overflow-wrap: anywhere; min-width: 0; }
@media (max-width: 480px) { .aitw-kv { grid-template-columns: minmax(0, 1fr); gap: 2px; } .aitw-kv dd { margin-bottom: 8px; } }
.aitw-activity { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
.aitw-activity li { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 10px; padding: 8px 0; border-bottom: 1px solid var(--aitw-line); }
.aitw-activity time { color: var(--aitw-muted); font-variant-numeric: tabular-nums; }
.aitw-row-note { display: block; margin-top: 4px; font-size: 13px; color: var(--aitw-muted); }
.aitw-row-error { display: block; margin-top: 4px; font-size: 13px; color: var(--aitw-danger); font-weight: 600; }
@media (max-width: 767.98px) {
  .aitw-table[data-stack="768"] thead { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); clip-path: inset(50%); }
  .aitw-table[data-stack="768"], .aitw-table[data-stack="768"] tbody { display: grid; gap: 10px; }
  .aitw-table[data-stack="768"] tr { display: grid; gap: 8px; padding: 12px 14px; border: 1px solid var(--aitw-line); border-radius: var(--aitw-radius-sm); background: var(--aitw-surface); }
  .aitw-table[data-stack="768"] td { display: grid; grid-template-columns: minmax(84px, 30%) minmax(0, 1fr); gap: 8px; align-items: center; padding: 0; border: 0; }
  .aitw-table[data-stack="768"] td::before { content: attr(data-label); font-size: 12.5px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; color: var(--aitw-muted); }
}
`;

/** Add `<style id="aitw-admin-styles">` once (the widget's sheet is injected too, by every admin component). */
export function injectTenancyAdminStyles(options: InjectStylesOptions = {}): void {
  injectStyleTag(STYLE_ID, CSS_TEXT, options.nonce);
}

/** The admin stylesheet text (render `tenancyWidgetCss()` first), for SSR or a shadow root. */
export function tenancyAdminCss(): string {
  return CSS_TEXT;
}
