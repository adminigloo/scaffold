/**
 * THE QUEUE'S LOOK (social 0.1). Plain class names prefixed `social-`, every
 * colour and radius from a `--social-*` variable: the app's Tailwind never
 * scans node_modules, so a package screen that leaned on utility classes
 * would arrive unstyled.
 *
 * COLOURS COME FROM THE APP'S THEME. Each `--social-*` token reads the app's
 * own token first (`--color-surface`, `--color-ink`, … — the names
 * create-app's globals.css defines, light and dark) and falls back to a light
 * or dark value of its own under `prefers-color-scheme`, so a host with no
 * tokens still gets both themes. An app with other names sets the
 * `--social-*` variables on a wrapper. A surface always sets its background
 * AND its text colour together — never a fixed background over an inherited
 * text colour, which is how white-on-white happens in dark mode.
 *
 * Every screen renders <SocialStyles /> itself (once is enough; twice is
 * harmless), so an app imports nothing to get it.
 */
export const socialCss = `
.social {
  --_ink: var(--social-ink, var(--color-ink, #14181f));
  --_muted: var(--social-muted, var(--color-ink-muted, #5b6472));
  --_surface: var(--social-surface, var(--color-surface, #ffffff));
  --_canvas: var(--social-canvas, var(--color-canvas, #f5f6f8));
  --_line: var(--social-line, var(--color-line, #dfe3e8));
  --_accent: var(--social-accent, var(--color-accent, #1e3a5f));
  --_accent-ink: var(--social-accent-ink, var(--color-surface, #ffffff));
  --_ok: var(--social-ok, var(--color-ok, #1c6b3a));
  --_ok-soft: var(--social-ok-soft, var(--color-ok-soft, #dff1e5));
  --_warn: var(--social-warn, var(--color-warn, #8a5a00));
  --_warn-soft: var(--social-warn-soft, var(--color-warn-soft, #f9efd6));
  --_danger: var(--social-danger, var(--color-danger, #a3302a));
  --_radius: var(--social-radius, var(--radius-card, 10px));
  --_mono: var(--social-mono, var(--font-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace));
  color: var(--_ink);
  font-size: 14px;
  line-height: 1.5;
}
@media (prefers-color-scheme: dark) {
  .social {
    --_ink: var(--social-ink, var(--color-ink, #e8edf1));
    --_muted: var(--social-muted, var(--color-ink-muted, #93a2ae));
    --_surface: var(--social-surface, var(--color-surface, #12181d));
    --_canvas: var(--social-canvas, var(--color-canvas, #0b0f13));
    --_line: var(--social-line, var(--color-line, #232d35));
    --_accent: var(--social-accent, var(--color-accent, #45c4ad));
    --_accent-ink: var(--social-accent-ink, var(--color-surface, #12181d));
    --_ok: var(--social-ok, var(--color-ok, #56c586));
    --_ok-soft: var(--social-ok-soft, var(--color-ok-soft, #10301d));
    --_warn: var(--social-warn, var(--color-warn, #cfa14e));
    --_warn-soft: var(--social-warn-soft, var(--color-warn-soft, #32270f));
    --_danger: var(--social-danger, var(--color-danger, #e08272));
  }
}
.social-admin { display: flex; flex-direction: column; gap: 32px; }
.social-section { display: flex; flex-direction: column; gap: 12px; }
.social-section-head { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 6px 12px; }
.social-section-title { margin: 0; font-size: 16px; font-weight: 600; color: var(--_ink); }
.social-section-hint { margin: 0; max-width: 72ch; color: var(--_muted); font-size: 13px; }
.social-queue { display: flex; flex-direction: column; gap: 20px; }
.social-toolbar { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px; }
.social-filter { display: flex; flex-wrap: wrap; gap: 6px; }
.social-group { display: flex; flex-direction: column; gap: 10px; }
.social-group-title { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 10px; margin: 0; font-size: 15px; font-weight: 600; color: var(--_ink); }
.social-group-meta { color: var(--_muted); font-size: 12px; font-weight: 400; }
.social-cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 340px), 1fr)); gap: 12px; }
.social-card { display: flex; flex-direction: column; gap: 8px; min-width: 0; padding: 12px; border: 1px solid var(--_line); border-radius: var(--_radius); background: var(--_surface); color: var(--_ink); }
.social-card[data-status="skipped"] { opacity: 0.7; }
.social-card-head { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.social-platform { margin-right: auto; font-weight: 600; }
.social-chip { padding: 1px 8px; border: 1px solid var(--_line); border-radius: 999px; color: var(--_muted); font-size: 12px; }
.social-chip[data-status="approved"] { border-color: transparent; background: var(--_ok-soft); color: var(--_ok); }
.social-chip[data-status="posted"] { border-color: transparent; background: var(--_accent); color: var(--_accent-ink); }
.social-chip[data-writer="template"] { border-color: transparent; background: var(--_warn-soft); color: var(--_warn); }
.social-text { box-sizing: border-box; width: 100%; margin: 0; padding: 8px 10px; border: 1px solid var(--_line); border-radius: calc(var(--_radius) - 2px); background: var(--_canvas); color: var(--_ink); font: 13px/1.5 var(--_mono); white-space: pre-wrap; overflow-wrap: anywhere; resize: vertical; }
.social-count, .social-note, .social-link, .social-posted, .social-empty { margin: 0; color: var(--_muted); font-size: 12px; overflow-wrap: anywhere; }
.social-count { font-variant-numeric: tabular-nums; }
.social-count[data-over] { color: var(--_danger); font-weight: 600; }
.social-card a, .social-compose a, .social-section a { color: var(--_accent); }
.social-images { display: flex; gap: 8px; margin: 0; padding: 0 0 4px; overflow-x: auto; list-style: none; scroll-snap-type: x proximity; }
.social-image { display: flex; flex: 0 0 auto; flex-direction: column; gap: 4px; width: min(100%, 220px); font-size: 12px; color: var(--_muted); scroll-snap-align: start; }
.social-images .social-image:only-child { width: 100%; }
.social-image img { display: block; width: 100%; height: auto; border: 1px solid var(--_line); border-radius: calc(var(--_radius) - 2px); }
.social-hook { color: var(--_ink); font-size: 14px; font-weight: 600; }
.social-comment { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 6px; }
.social-field input[aria-invalid] { border-color: var(--_danger); }
.social-actions { display: flex; flex-wrap: wrap; gap: 6px; }
.social-button { display: inline-flex; align-items: center; justify-content: center; min-height: 36px; padding: 6px 12px; border: 1px solid var(--_line); border-radius: calc(var(--_radius) - 2px); background: var(--_surface); color: var(--_ink); font: inherit; font-weight: 500; text-decoration: none; cursor: pointer; }
.social-button:hover { border-color: var(--_muted); }
.social-button:disabled { cursor: default; opacity: 0.55; }
.social-button[aria-pressed="true"] { border-color: var(--_accent); color: var(--_accent); }
.social-button-primary { border-color: var(--_accent); background: var(--_accent); color: var(--_accent-ink); }
.social-button-primary:hover { border-color: var(--_accent); filter: brightness(1.1); }
.social-button-quiet { border-color: transparent; background: transparent; color: var(--_muted); }
.social-posted-form { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 6px; }
.social-field { display: flex; flex: 1 1 220px; flex-direction: column; gap: 4px; color: var(--_muted); font-size: 12px; }
.social-field input { box-sizing: border-box; width: 100%; min-height: 36px; padding: 6px 10px; border: 1px solid var(--_line); border-radius: calc(var(--_radius) - 2px); background: var(--_surface); color: var(--_ink); font: inherit; }
.social-compose { display: flex; flex-direction: column; gap: 10px; max-width: 720px; padding: 14px; border: 1px solid var(--_line); border-radius: var(--_radius); background: var(--_surface); color: var(--_ink); }
.social-error { margin: 0; color: var(--_danger); font-size: 13px; }
.social-formats { display: flex; flex-direction: column; gap: 24px; }
.social-formats > summary { cursor: pointer; font-weight: 600; color: var(--_accent); }
.social-format-set { display: flex; flex-direction: column; gap: 6px; }
.social-format-images { display: flex; flex-wrap: wrap; align-items: flex-start; gap: 16px; margin: 0; padding: 0; list-style: none; }
.social-format-images li { display: flex; flex-direction: column; gap: 6px; font-size: 12px; color: var(--_muted); font-variant-numeric: tabular-nums; }
.social-format-images img { display: block; height: auto; border: 1px solid var(--_line); border-radius: calc(var(--_radius) - 2px); }
.social-sample-chip { margin-left: 6px; padding: 1px 8px; border: 1px solid var(--_line); border-radius: 999px; color: var(--_muted); font-size: 12px; font-weight: 500; }
`;

/** The queue's styles, once per page (each screen renders it). */
export function SocialStyles() {
  return <style data-adminigloo-social="">{socialCss}</style>;
}
