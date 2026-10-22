/**
 * The digest screens' own styles, prefixed `aidg-`: the app's Tailwind never
 * scans node_modules, so a package screen that leaned on utility classes
 * would arrive unstyled.
 *
 * COLOURS COME FROM THE APP'S THEME. Every colour is a `--aidg-*` token that
 * reads the app's own token first (`--color-surface`, `--color-ink`, … — the
 * names create-app's globals.css defines, light and dark) and falls back to
 * a light or dark value of its own, so a host with no tokens still gets both
 * themes. A surface always sets its background AND its text colour.
 */
export const digestCss = `
.aidg {
  --aidg-surface: var(--color-surface, #ffffff);
  --aidg-ink: var(--color-ink, #171717);
  --aidg-muted: var(--color-ink-muted, #525252);
  --aidg-line: var(--color-line, #e5e5e5);
  --aidg-accent: var(--color-accent, #0f766e);
  --aidg-on-accent: var(--color-surface, #ffffff);
  --aidg-ok: var(--color-ok, #14532d);
  --aidg-danger: var(--color-danger, #991b1b);
  font: inherit; color: var(--aidg-ink); line-height: 1.5;
}
@media (prefers-color-scheme: dark) {
  .aidg {
    --aidg-surface: var(--color-surface, #12181d);
    --aidg-ink: var(--color-ink, #e8edf1);
    --aidg-muted: var(--color-ink-muted, #93a2ae);
    --aidg-line: var(--color-line, #232d35);
    --aidg-accent: var(--color-accent, #45c4ad);
    --aidg-on-accent: var(--color-surface, #12181d);
    --aidg-ok: var(--color-ok, #56c586);
    --aidg-danger: var(--color-danger, #e08272);
  }
}
.aidg *{box-sizing:border-box}
.aidg-stack{display:flex;flex-direction:column;gap:1.25rem}
.aidg-card{border:1px solid var(--aidg-line);border-radius:var(--radius-card,.75rem);padding:1rem 1.25rem;background:var(--aidg-surface);color:var(--aidg-ink)}
.aidg-h2{font-size:1rem;font-weight:600;margin:0 0 .25rem;color:var(--aidg-ink)}
.aidg-muted{color:var(--aidg-muted);font-size:.875rem;margin:0}
.aidg-choice{display:flex;gap:.75rem;align-items:flex-start;padding:.75rem 0;border-top:1px solid var(--aidg-line)}
.aidg-choice:first-of-type{border-top:0}
.aidg-choice input{margin-top:.25rem;width:1.125rem;height:1.125rem;accent-color:var(--aidg-accent);flex:none}
.aidg-choice strong{display:block;font-weight:600}
.aidg-row{display:flex;flex-wrap:wrap;gap:.75rem;align-items:center}
.aidg-field{display:flex;flex-direction:column;gap:.25rem;min-width:12rem}
.aidg-field label{font-size:.875rem;font-weight:500}
.aidg-select{min-height:44px;border:1px solid var(--aidg-line);border-radius:var(--radius-control,.5rem);padding:.5rem .75rem;background:var(--aidg-surface);color:var(--aidg-ink);font:inherit}
.aidg-btn{appearance:none;display:inline-flex;align-items:center;justify-content:center;min-height:44px;border:1px solid var(--aidg-accent);background:var(--aidg-accent);color:var(--aidg-on-accent);border-radius:var(--radius-control,.5rem);padding:.5rem 1rem;font:inherit;font-size:.875rem;font-weight:500;cursor:pointer}
.aidg-btn[disabled]{opacity:.6;cursor:progress}
.aidg-link{appearance:none;background:none;border:0;padding:0;color:var(--aidg-accent);text-decoration:underline;text-underline-offset:2px;font:inherit;font-size:.875rem;cursor:pointer}
.aidg-ok{color:var(--aidg-ok);font-size:.875rem;margin:0}
.aidg-error{color:var(--aidg-danger);font-size:.875rem;margin:0}
.aidg-optin{display:flex;gap:.625rem;align-items:flex-start;max-width:24rem;margin:1rem auto 0;font-size:.875rem;color:var(--aidg-ink)}
.aidg-optin input{margin-top:.2rem;width:1rem;height:1rem;accent-color:var(--aidg-accent);flex:none}
`;
