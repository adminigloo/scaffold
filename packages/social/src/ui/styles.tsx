/**
 * THE QUEUE'S LOOK (social 0.2). Plain class names prefixed `social-`, every
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
 *
 * MOBILE FIRST (social 0.2, from Almanac: the founder works the queue on a
 * phone): one column, every button and tab at least 44 px tall, inputs at
 * 16 px so iOS doesn't zoom on focus, and only the tabs and the image strips
 * scroll sideways, inside their card; the page itself never does.
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
  --_pad: 14px;
  min-width: 0;
  color: var(--_ink);
  font-size: 14px;
  line-height: 1.5;
  /* A long link (a tagged first comment) breaks rather than pushing a phone's page sideways. */
  overflow-wrap: anywhere;
  color-scheme: light;
}
@media (prefers-color-scheme: dark) {
  .social {
    color-scheme: dark;
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

.social-queue {
  display: flex;
  flex-direction: column;
  gap: 16px;
  max-width: 860px;
}

/* ---- One post ---------------------------------------------------------- */

.social-post {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
  padding: var(--_pad);
  border: 1px solid var(--_line);
  border-radius: var(--_radius);
  background: var(--_surface);
}

.social-post-head {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}

.social-post-meta,
.social-post-title {
  margin: 0;
  color: var(--_muted);
  font-size: 13px;
  overflow-wrap: anywhere;
}

.social-post-kind {
  color: var(--_ink);
  font-weight: 600;
}

.social-post-hook {
  margin: 0;
  font-size: 17px;
  font-weight: 600;
  line-height: 1.35;
  overflow-wrap: anywhere;
}

.social-summary {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin: 2px 0 0;
  padding: 0;
  list-style: none;
}

.social-post-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

/* Each different set of images once: the square card, the carousels. */
.social-sets {
  display: flex;
  gap: 10px;
  margin: 0 calc(var(--_pad) * -1);
  padding: 0 var(--_pad) 4px;
  overflow-x: auto;
  list-style: none;
  overscroll-behavior-x: contain;
  scroll-snap-type: x proximity;
}

.social-set {
  display: flex;
  flex: 0 0 auto;
  flex-direction: column;
  gap: 4px;
  width: 148px;
  color: var(--_muted);
  font-size: 12px;
  line-height: 1.35;
  scroll-snap-align: start;
}

.social-set img,
.social-image img {
  display: block;
  width: 100%;
  height: auto;
  border: 1px solid var(--_line);
  border-radius: calc(var(--_radius) - 2px);
}

/* ---- Platform tabs ----------------------------------------------------- */

.social-tabs {
  display: flex;
  gap: 6px;
  margin: 0 calc(var(--_pad) * -1);
  padding: 2px var(--_pad) 4px;
  overflow-x: auto;
  overscroll-behavior-x: contain;
  scroll-snap-type: x proximity;
  scrollbar-width: thin;
}

.social-tab {
  position: relative;
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 7px;
  min-height: 44px;
  padding: 0 14px;
  border: 1px solid var(--_line);
  border-radius: 999px;
  background: var(--_surface);
  color: var(--_ink);
  font: inherit;
  font-weight: 500;
  white-space: nowrap;
  cursor: pointer;
  scroll-snap-align: start;
}

.social-tab[aria-selected="true"] {
  border-color: var(--_accent);
  box-shadow: inset 0 0 0 1px var(--_accent);
  font-weight: 600;
}

.social-tab-mark {
  flex: 0 0 auto;
  width: 9px;
  height: 9px;
  border: 1.5px solid var(--_muted);
  border-radius: 50%;
}

.social-tab[data-status="approved"] .social-tab-mark {
  border-color: var(--_ok);
  background: var(--_ok);
}

.social-tab[data-status="posted"] .social-tab-mark {
  border-color: var(--_accent);
  background: var(--_accent);
}

.social-tab[data-status="skipped"] .social-tab-mark,
.social-tab[data-status="expired"] .social-tab-mark {
  border-style: dashed;
}

.social-tab[data-status="skipped"],
.social-tab[data-status="expired"] {
  color: var(--_muted);
}

.social-panel {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
  padding-top: 12px;
  border-top: 1px solid var(--_line);
}

.social-panel-head {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

/* Read by a screen reader, not shown. */
.social-sr {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}

/* ---- Chips --------------------------------------------------------------- */

.social-chip {
  display: inline-flex;
  align-items: center;
  padding: 1px 9px;
  border: 1px solid var(--_line);
  border-radius: 999px;
  color: var(--_muted);
  font-size: 12px;
}

.social-chip[data-status="approved"] {
  border-color: transparent;
  background: var(--_ok-soft);
  color: var(--_ok);
}

.social-chip[data-status="posted"] {
  border-color: transparent;
  background: var(--_accent);
  color: var(--_accent-ink);
}

.social-chip[data-status="expired"],
.social-chip[data-writer="template"] {
  border-color: transparent;
  background: var(--_warn-soft);
  color: var(--_warn);
}

.social-chip[data-status="skipped"] {
  border-style: dashed;
}

/* ---- A platform's draft --------------------------------------------------- */

.social-text {
  box-sizing: border-box;
  width: 100%;
  margin: 0;
  padding: 10px 12px;
  border: 1px solid var(--_line);
  border-radius: calc(var(--_radius) - 2px);
  background: var(--_canvas);
  color: var(--_ink);
  /* 16px: iOS zooms the page into any field set smaller. */
  font: 16px/1.5 var(--_mono);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  resize: vertical;
}

.social-text-done {
  font-size: 14px;
}

.social-count,
.social-note,
.social-link,
.social-posted,
.social-empty {
  margin: 0;
  color: var(--_muted);
  font-size: 12px;
  overflow-wrap: anywhere;
}

.social-empty {
  font-size: 14px;
}

.social-count {
  font-variant-numeric: tabular-nums;
}

.social-count[data-over] {
  color: var(--_danger);
  font-weight: 600;
}

.social-post a,
.social-compose a {
  color: var(--_accent);
}

/* A platform's images in posting order: small, a strip that scrolls sideways for a carousel. */
.social-images {
  display: flex;
  gap: 8px;
  margin: 0;
  padding: 0 0 4px;
  overflow-x: auto;
  list-style: none;
  overscroll-behavior-x: contain;
  scroll-snap-type: x proximity;
}

.social-image {
  display: flex;
  flex: 0 0 auto;
  flex-direction: column;
  gap: 4px;
  width: 96px;
  color: var(--_muted);
  font-size: 12px;
  scroll-snap-align: start;
}

.social-hook {
  color: var(--_ink);
  font-size: 14px;
  font-weight: 600;
}

.social-comment,
.social-posted-form {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: 8px;
}

.social-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
  color: var(--_muted);
  font-size: 12px;
}

/* Beside a button (the first comment, the posted link) a field takes the row's room, and wraps under it on a phone. */
.social-comment .social-field,
.social-posted-form .social-field {
  flex: 1 1 220px;
}

.social-field input,
.social-hook-input {
  box-sizing: border-box;
  width: 100%;
  min-height: 44px;
  padding: 8px 12px;
  border: 1px solid var(--_line);
  border-radius: calc(var(--_radius) - 2px);
  background: var(--_surface);
  color: var(--_ink);
  font: inherit;
  font-size: 16px;
}

.social-hook-input {
  resize: none;
  line-height: 1.35;
}

.social-field input[aria-invalid],
.social-hook-input[aria-invalid] {
  border-color: var(--_danger);
}

.social-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

/* ---- Buttons --------------------------------------------------------------- */

.social-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  box-sizing: border-box;
  min-height: 44px;
  padding: 0 16px;
  border: 1px solid var(--_line);
  border-radius: calc(var(--_radius) - 2px);
  background: var(--_surface);
  color: var(--_ink);
  font: inherit;
  font-weight: 500;
  text-decoration: none;
  cursor: pointer;
  touch-action: manipulation;
}

.social-button:hover {
  border-color: var(--_muted);
}

.social-button:disabled {
  cursor: default;
  opacity: 0.55;
}

.social-button-primary {
  border-color: var(--_accent);
  background: var(--_accent);
  color: var(--_accent-ink);
}

.social-button-primary:hover {
  border-color: var(--_accent);
  filter: brightness(1.1);
}

.social-button-quiet {
  border-color: transparent;
  background: transparent;
  color: var(--_muted);
}

.social-tab:focus-visible,
.social-button:focus-visible,
.social-field input:focus-visible,
.social-hook-input:focus-visible,
.social-text:focus-visible {
  outline: 2px solid var(--_accent);
  outline-offset: 2px;
}

/* On a phone the post's main button takes the row. */
@media (max-width: 479px) {
  .social-post-actions .social-button-primary {
    flex: 1 1 100%;
  }
}

/* ---- Writing a post from your own facts -------------------------------------- */

.social-group-title {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
}

.social-compose {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: var(--_pad);
  border: 1px solid var(--_line);
  border-radius: var(--_radius);
  background: var(--_surface);
}

.social-error {
  margin: 0;
  color: var(--_danger);
  font-size: 13px;
}


/* The package page (PostsAdmin) and the card formats (CardFormats). */
/* The whole page paints its own ground, so its titles never sit on a host's background of the other theme. */
.social-admin { display: flex; flex-direction: column; gap: 32px; padding: 16px; border-radius: var(--_radius); background: var(--_canvas); color: var(--_ink); }
/* A made video: its preview, then what to do with it. */
.social-video-made { display: flex; flex-direction: column; gap: 10px; width: 100%; }
/* The clip's own shape (social 0.5: 9:16, 4:5 or 1:1), from its width and height attributes. */
.social-video { display: block; width: 220px; max-width: 100%; height: auto; border-radius: var(--_radius); background: #000; }
/* A plain link (the posting session's) in the theme's accent, not the browser's blue. */
.social a { color: var(--_accent); }
.social-section { display: flex; flex-direction: column; gap: 12px; }
.social-section-head { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 6px 12px; }
.social-section-title { margin: 0; font-size: 16px; font-weight: 600; color: var(--_ink); }
.social-section-hint { margin: 0; max-width: 72ch; color: var(--_muted); font-size: 13px; }
.social-formats { display: flex; flex-direction: column; gap: 24px; }
.social-formats > summary { cursor: pointer; font-weight: 600; color: var(--_accent); }
.social-format-set { display: flex; flex-direction: column; gap: 6px; }
.social-format-images { display: flex; flex-wrap: wrap; align-items: flex-start; gap: 16px; margin: 0; padding: 0; list-style: none; }
.social-format-images li { display: flex; flex-direction: column; gap: 6px; font-size: 12px; color: var(--_muted); font-variant-numeric: tabular-nums; }
.social-format-images img { display: block; height: auto; border: 1px solid var(--_line); border-radius: calc(var(--_radius) - 2px); }
.social-sample-chip { margin-left: 6px; padding: 1px 8px; border: 1px solid var(--_line); border-radius: 999px; color: var(--_muted); font-size: 12px; font-weight: 500; }

/* The image viewer (./viewer.tsx, social 0.5): a native modal dialog, the panel in it. */
.social-viewer {
  box-sizing: border-box;
  width: 100%;
  max-width: 100%;
  height: 100%;
  max-height: 100%;
  margin: 0;
  padding: 16px;
  border: 0;
  background: transparent;
  color: var(--_ink);
}

.social-viewer[open] {
  display: flex;
  align-items: center;
  justify-content: center;
}

.social-viewer::backdrop {
  background: rgba(10, 12, 16, 0.72);
}

.social-viewer-panel {
  display: flex;
  flex-direction: column;
  gap: 12px;
  box-sizing: border-box;
  width: min(1200px, 100%);
  max-height: 100%;
  padding: 12px 14px 14px;
  border-radius: var(--_radius);
  background: var(--_surface);
  box-shadow: 0 24px 64px rgba(0, 0, 0, 0.35);
}

.social-viewer-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.social-viewer-title {
  display: flex;
  flex: 1 1 auto;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 4px 10px;
  margin: 0;
  font-size: 16px;
  font-weight: 600;
}

.social-viewer-label {
  color: var(--_muted);
  font-size: 14px;
  font-weight: 500;
}

.social-viewer-modes {
  display: inline-flex;
  gap: 6px;
}

.social-viewer-modes .social-button[aria-pressed="true"] {
  border-color: var(--_accent);
  box-shadow: inset 0 0 0 1px var(--_accent);
}

.social-viewer-close,
.social-viewer-step {
  width: 44px;
  padding: 0;
  font-size: 22px;
  line-height: 1;
}

.social-viewer-stage {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  place-items: center;
  gap: 10px;
  min-height: 0;
}

.social-viewer-stage[data-steps] {
  grid-template-columns: auto minmax(0, 1fr) auto;
}

.social-viewer-stage img {
  display: block;
  width: auto;
  height: auto;
  max-width: 100%;
  max-height: calc(100dvh - 160px);
  border-radius: 8px;
  background: var(--_canvas);
}

.social-viewer-strip {
  display: flex;
  gap: 12px;
  margin: 0;
  padding: 0 0 8px;
  overflow-x: auto;
  list-style: none;
  overscroll-behavior-x: contain;
  scroll-snap-type: x proximity;
}

.social-viewer-strip li {
  display: flex;
  flex: none;
  flex-direction: column;
  gap: 6px;
  color: var(--_muted);
  font-size: 13px;
  scroll-snap-align: start;
}

.social-viewer-pick {
  display: block;
  padding: 0;
  border: 0;
  border-radius: 8px;
  background: none;
  cursor: zoom-in;
}

.social-viewer-pick:focus-visible {
  outline: 2px solid var(--_accent);
  outline-offset: 2px;
}

.social-viewer-strip img {
  display: block;
  width: auto;
  height: min(calc(100dvh - 190px), 720px);
  border-radius: 8px;
  background: var(--_canvas);
}

@media (max-width: 640px) {
  .social-viewer {
    padding: 8px;
  }

  .social-viewer-stage img {
    max-height: calc(100dvh - 200px);
  }

  .social-viewer-strip img {
    height: min(52dvh, 420px);
  }
}
`;

/** The queue's styles, once per page (each screen renders it). */
export function SocialStyles() {
  return <style data-adminigloo-social="">{socialCss}</style>;
}
