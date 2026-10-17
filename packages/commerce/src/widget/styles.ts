/**
 * The store screens' own styles, prefixed `aics-`: the app's Tailwind never
 * scans node_modules, so a package screen that leaned on utility classes
 * would arrive unstyled.
 *
 * COLOURS COME FROM THE APP'S THEME. Every colour is a `--aics-*` token that
 * reads the app's own token first (`--color-surface`, `--color-ink`, … — the
 * names create-app's globals.css defines, light and dark) and falls back to
 * a light or dark value of its own under `prefers-color-scheme`, so a host
 * with no tokens still gets both themes. A surface always sets its
 * background AND its text colour together — never a fixed background over an
 * inherited text colour, which is how white-on-white happens in dark mode.
 */
export const storeCss = `
.aics {
  --aics-surface: var(--color-surface, #ffffff);
  --aics-raised: var(--color-surface-raised, #ffffff);
  --aics-ink: var(--color-ink, #171717);
  --aics-muted: var(--color-ink-muted, #525252);
  --aics-line: var(--color-line, #e5e5e5);
  --aics-line-strong: var(--color-line-strong, #d4d4d4);
  --aics-accent: var(--color-accent, #171717);
  --aics-on-accent: var(--color-surface, #ffffff);
  --aics-ok: var(--color-ok, #14532d);
  --aics-ok-soft: var(--color-ok-soft, #f0fdf4);
  --aics-danger: var(--color-danger, #991b1b);
  --aics-danger-soft: var(--color-danger-soft, #fef2f2);
  --aics-warn: var(--color-warn, #78350f);
  --aics-warn-soft: var(--color-warn-soft, #fffbeb);
  --aics-soft: var(--color-canvas, #f5f5f5);
  font: inherit; color: var(--aics-ink); line-height: 1.5;
}
@media (prefers-color-scheme: dark) {
  .aics {
    --aics-surface: var(--color-surface, #12181d);
    --aics-raised: var(--color-surface-raised, #1a222a);
    --aics-ink: var(--color-ink, #e8edf1);
    --aics-muted: var(--color-ink-muted, #93a2ae);
    --aics-line: var(--color-line, #232d35);
    --aics-line-strong: var(--color-line-strong, #38454f);
    --aics-accent: var(--color-accent, #45c4ad);
    --aics-on-accent: var(--color-surface, #12181d);
    --aics-ok: var(--color-ok, #56c586);
    --aics-ok-soft: var(--color-ok-soft, #10301d);
    --aics-danger: var(--color-danger, #e08272);
    --aics-danger-soft: var(--color-danger-soft, #3a1712);
    --aics-warn: var(--color-warn, #e2b85a);
    --aics-warn-soft: var(--color-warn-soft, #33270c);
    --aics-soft: var(--color-canvas, #0b0f13);
  }
}
.aics *{box-sizing:border-box}
.aics-h1{font-size:1.5rem;font-weight:600;margin:0;color:var(--aics-ink)}
.aics-h2{font-size:1.125rem;font-weight:600;margin:0 0 .5rem;color:var(--aics-ink)}
.aics-muted{color:var(--aics-muted);font-size:.875rem}
.aics-row{display:flex;flex-wrap:wrap;gap:.75rem;align-items:center}
.aics-stack{display:flex;flex-direction:column;gap:1rem}
.aics-card{border:1px solid var(--aics-line);border-radius:.5rem;padding:1rem;background:var(--aics-surface);color:var(--aics-ink)}
.aics-grid{display:grid;gap:1rem;grid-template-columns:repeat(auto-fill,minmax(14rem,1fr))}
.aics-photo{width:100%;aspect-ratio:4/3;object-fit:cover;border-radius:.375rem;background:var(--aics-soft);display:block}
.aics-thumb{width:3.5rem;height:3.5rem;object-fit:cover;border-radius:.375rem;background:var(--aics-soft);flex:none}
.aics-btn{appearance:none;border:1px solid var(--aics-accent);background:var(--aics-accent);color:var(--aics-on-accent);border-radius:.375rem;padding:.5rem .9rem;font:inherit;font-size:.875rem;font-weight:500;cursor:pointer}
.aics-btn:disabled{opacity:.5;cursor:default}
.aics-btn-quiet{background:var(--aics-surface);color:var(--aics-ink);border-color:var(--aics-line-strong)}
.aics-input,.aics-select,.aics-textarea{font:inherit;font-size:.875rem;border:1px solid var(--aics-line-strong);border-radius:.375rem;padding:.45rem .6rem;background:var(--aics-raised);color:var(--aics-ink)}
.aics-textarea{width:100%;min-height:4.5rem}
.aics-label{display:flex;flex-direction:column;gap:.25rem;font-size:.875rem;font-weight:500;color:var(--aics-ink)}
.aics-tabs{display:flex;flex-wrap:wrap;gap:.25rem;border-bottom:1px solid var(--aics-line)}
.aics-tab{appearance:none;border:0;background:transparent;font:inherit;font-size:.9rem;padding:.5rem .75rem;cursor:pointer;border-bottom:2px solid transparent;color:var(--aics-muted)}
.aics-tab[aria-selected="true"]{border-bottom-color:var(--aics-ink);color:var(--aics-ink);font-weight:600}
.aics-error{background:var(--aics-danger-soft);color:var(--aics-danger);border-radius:.375rem;padding:.6rem .75rem;font-size:.875rem}
.aics-note{background:var(--aics-warn-soft);color:var(--aics-warn);border-radius:.375rem;padding:.6rem .75rem;font-size:.875rem}
.aics-ok{background:var(--aics-ok-soft);color:var(--aics-ok);border-radius:.375rem;padding:.6rem .75rem;font-size:.875rem}
.aics-tag{display:inline-block;border-radius:999px;padding:.05rem .5rem;font-size:.75rem;font-weight:600;background:var(--aics-soft);color:var(--aics-ink)}
.aics-tag-warn{background:var(--aics-warn-soft);color:var(--aics-warn)}
.aics-tag-bad{background:var(--aics-danger-soft);color:var(--aics-danger)}
.aics-tag-good{background:var(--aics-ok-soft);color:var(--aics-ok)}
.aics-scroll{overflow-x:auto;-webkit-overflow-scrolling:touch;max-width:100%}
.aics-table{width:100%;min-width:40rem;border-collapse:collapse;font-size:.875rem;color:var(--aics-ink)}
.aics-table td,.aics-table th{text-align:left;padding:.5rem .4rem;border-bottom:1px solid var(--aics-line);vertical-align:top}
.aics-price{font-weight:600}
.aics-qty{width:4.5rem}
.aics a{color:var(--aics-accent)}
`;
