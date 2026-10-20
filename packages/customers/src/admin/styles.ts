/**
 * The customer screens' own styles, prefixed `aicu-`: the app's Tailwind never
 * scans node_modules, so a package screen that leaned on utility classes
 * would arrive unstyled.
 *
 * COLOURS COME FROM THE APP'S THEME. Every colour is a `--aicu-*` token that
 * reads the app's own token first (`--color-surface`, `--color-ink`, … — the
 * names create-app's globals.css defines, light and dark) and falls back to
 * a light or dark value of its own under `prefers-color-scheme`, so a host
 * with no tokens still gets both themes. A surface always sets its
 * background AND its text colour together — never a fixed background over an
 * inherited text colour, which is how white-on-white happens in dark mode.
 */
export const customersCss = `
.aicu {
  --aicu-surface: var(--color-surface, #ffffff);
  --aicu-raised: var(--color-surface-raised, #ffffff);
  --aicu-ink: var(--color-ink, #171717);
  --aicu-muted: var(--color-ink-muted, #525252);
  --aicu-line: var(--color-line, #e5e5e5);
  --aicu-line-strong: var(--color-line-strong, #d4d4d4);
  --aicu-accent: var(--color-accent, #171717);
  --aicu-on-accent: var(--color-surface, #ffffff);
  --aicu-ok: var(--color-ok, #14532d);
  --aicu-ok-soft: var(--color-ok-soft, #f0fdf4);
  --aicu-danger: var(--color-danger, #991b1b);
  --aicu-danger-soft: var(--color-danger-soft, #fef2f2);
  --aicu-warn: var(--color-warn, #78350f);
  --aicu-warn-soft: var(--color-warn-soft, #fffbeb);
  --aicu-soft: var(--color-canvas, #f5f5f5);
  font: inherit; color: var(--aicu-ink); line-height: 1.5;
}
@media (prefers-color-scheme: dark) {
  .aicu {
    --aicu-surface: var(--color-surface, #12181d);
    --aicu-raised: var(--color-surface-raised, #1a222a);
    --aicu-ink: var(--color-ink, #e8edf1);
    --aicu-muted: var(--color-ink-muted, #93a2ae);
    --aicu-line: var(--color-line, #232d35);
    --aicu-line-strong: var(--color-line-strong, #38454f);
    --aicu-accent: var(--color-accent, #45c4ad);
    --aicu-on-accent: var(--color-surface, #12181d);
    --aicu-ok: var(--color-ok, #56c586);
    --aicu-ok-soft: var(--color-ok-soft, #10301d);
    --aicu-danger: var(--color-danger, #e08272);
    --aicu-danger-soft: var(--color-danger-soft, #3a1712);
    --aicu-warn: var(--color-warn, #e2b85a);
    --aicu-warn-soft: var(--color-warn-soft, #33270c);
    --aicu-soft: var(--color-canvas, #0b0f13);
  }
}
.aicu *{box-sizing:border-box}
.aicu-h1{font-size:1.5rem;font-weight:600;margin:0;color:var(--aicu-ink)}
.aicu-h2{font-size:1.125rem;font-weight:600;margin:0 0 .5rem;color:var(--aicu-ink)}
.aicu-muted{color:var(--aicu-muted);font-size:.875rem}
.aicu-row{display:flex;flex-wrap:wrap;gap:.75rem;align-items:center}
.aicu-stack{display:flex;flex-direction:column;gap:1rem}
.aicu-card{border:1px solid var(--aicu-line);border-radius:var(--radius-card,.75rem);padding:1rem;background:var(--aicu-surface);color:var(--aicu-ink);box-shadow:var(--shadow-card,none)}
.aicu-grid{display:grid;gap:1rem;grid-template-columns:repeat(auto-fill,minmax(14rem,1fr))}
.aicu-btn{appearance:none;display:inline-flex;align-items:center;justify-content:center;min-height:44px;border:1px solid var(--aicu-accent);background:var(--aicu-accent);color:var(--aicu-on-accent);border-radius:var(--radius-control,.5rem);padding:.5rem 1rem;font:inherit;font-size:.875rem;font-weight:500;cursor:pointer;text-decoration:none}
.aicu-btn:disabled{opacity:.5;cursor:default}
.aicu-btn-quiet{background:var(--aicu-surface);color:var(--aicu-ink);border-color:var(--aicu-line-strong)}
.aicu-input,.aicu-select,.aicu-textarea{font:inherit;font-size:.875rem;min-height:44px;border:1px solid var(--aicu-line-strong);border-radius:var(--radius-control,.5rem);padding:.5rem .7rem;background:var(--aicu-raised);color:var(--aicu-ink)}
.aicu-textarea{width:100%;min-height:4.5rem}
.aicu-label{display:flex;flex-direction:column;gap:.25rem;font-size:.875rem;font-weight:500;color:var(--aicu-ink)}
.aicu-tabs{display:flex;flex-wrap:wrap;gap:.25rem;border-bottom:1px solid var(--aicu-line)}
.aicu-tab{appearance:none;border:0;background:transparent;font:inherit;font-size:.9rem;min-height:44px;padding:.5rem .75rem;cursor:pointer;border-bottom:2px solid transparent;color:var(--aicu-muted)}
.aicu-tab[aria-selected="true"]{border-bottom-color:var(--aicu-ink);color:var(--aicu-ink);font-weight:600}
.aicu-error{background:var(--aicu-danger-soft);color:var(--aicu-danger);border-radius:.375rem;padding:.6rem .75rem;font-size:.875rem}
.aicu-note{background:var(--aicu-warn-soft);color:var(--aicu-warn);border-radius:.375rem;padding:.6rem .75rem;font-size:.875rem}
.aicu-ok{background:var(--aicu-ok-soft);color:var(--aicu-ok);border-radius:.375rem;padding:.6rem .75rem;font-size:.875rem}
.aicu-tag{display:inline-block;border-radius:999px;padding:.05rem .5rem;font-size:.75rem;font-weight:600;background:var(--aicu-soft);color:var(--aicu-ink)}
.aicu-tag-warn{background:var(--aicu-warn-soft);color:var(--aicu-warn)}
.aicu-tag-bad{background:var(--aicu-danger-soft);color:var(--aicu-danger)}
.aicu-tag-good{background:var(--aicu-ok-soft);color:var(--aicu-ok)}
.aicu-scroll{overflow-x:auto;-webkit-overflow-scrolling:touch;max-width:100%}
.aicu-table{width:100%;min-width:40rem;border-collapse:collapse;font-size:.875rem;color:var(--aicu-ink)}
.aicu-table td,.aicu-table th{text-align:left;padding:.5rem .4rem;border-bottom:1px solid var(--aicu-line);vertical-align:top}
.aicu a{color:var(--aicu-accent)}
.aicu-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:.5rem}
.aicu-when{color:var(--aicu-muted);font-size:.8rem;white-space:nowrap}
.aicu-kind{min-width:5.5rem}
.aicu-cards{display:none}
@media (max-width: 640px){.aicu-cards{display:flex}.aicu-wide{display:none}}
.aicu-empty{display:flex;flex-direction:column;align-items:center;gap:.6rem;text-align:center;padding:2rem 1.25rem}
.aicu-empty .aicu-muted{max-width:58ch;margin:0}
.aicu-empty-title{margin:0;font-weight:600;font-size:1rem;color:var(--aicu-ink)}
.aicu-notice{border-left:3px solid var(--aicu-warn);background:var(--aicu-warn-soft);color:var(--aicu-ink);border-radius:.375rem;padding:.6rem .75rem;font-size:.875rem}
`;
