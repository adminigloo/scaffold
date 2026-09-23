/**
 * The widget's entire appearance, injected once as a <style> tag. Every rule
 * is prefixed `aif-` and scoped under the widget's own roots, so the host
 * app's CSS cannot break the widget and the widget cannot break the host.
 * This is what "React is the only peer" costs: no Tailwind, no CSS import
 * step for the buyer, no assumptions.
 *
 * ITS OWN TOKEN SET, as `--aif-*` custom properties on the widget roots.
 * The widget ships into apps whose themes it cannot know, so it carries a
 * complete palette of its own — including a dark theme, because half the
 * apps that embed it are dark and a glowing white dialog in one reads as a
 * foreign object. `prefers-color-scheme` decides; every colour below resolves
 * through a token, for the same reason the scaffold locks its palette: one
 * bare hex is a rule nobody re-tests in the other theme.
 */

const STYLE_ID = "aif-styles";

export function injectStyles(): void {
  if (typeof document === "undefined" || document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = CSS_TEXT;
  document.head.appendChild(style);
}

const CSS_TEXT = `
.aif-root {
  --aif-surface: #ffffff;
  --aif-surface-2: #f5f7f9;
  --aif-ink: #0e161c;
  --aif-ink-muted: #55636f;
  --aif-ink-faint: #8494a1;
  --aif-line: #e1e7ec;
  --aif-line-strong: #c3ced7;
  --aif-accent: #0f766e;
  --aif-accent-strong: #0c5f59;
  --aif-accent-soft: #d9efec;
  --aif-danger: #a02e21;
  --aif-danger-soft: #fbe9e6;
  --aif-on-accent: #ffffff;
  --aif-shadow-raised: 0 4px 14px rgba(14,22,28,.14), 0 1px 3px rgba(14,22,28,.08);
  --aif-shadow-overlay: 0 24px 64px rgba(14,22,28,.30), 0 4px 16px rgba(14,22,28,.14);
  --aif-scrim: rgba(10, 14, 17, .55);
}
@media (prefers-color-scheme: dark) {
  .aif-root {
    --aif-surface: #161d23;
    --aif-surface-2: #0f1418;
    --aif-ink: #e8edf1;
    --aif-ink-muted: #93a2ae;
    --aif-ink-faint: #61707c;
    --aif-line: #29343d;
    --aif-line-strong: #3c4a55;
    --aif-accent: #45c4ad;
    --aif-accent-strong: #6cd6c3;
    --aif-accent-soft: #113029;
    --aif-danger: #e08272;
    --aif-danger-soft: #391712;
    --aif-on-accent: #0e161c;
    --aif-shadow-raised: 0 4px 14px rgba(0,0,0,.5), 0 1px 3px rgba(0,0,0,.4);
    --aif-shadow-overlay: 0 24px 64px rgba(0,0,0,.65), 0 4px 16px rgba(0,0,0,.5);
    --aif-scrim: rgba(0, 0, 0, .6);
  }
}

.aif-root, .aif-root * { box-sizing: border-box; margin: 0; padding: 0; }
.aif-root {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  font-size: 14px; line-height: 1.5; color: var(--aif-ink);
}

/* Floating trigger — the one piece of the brand a buyer's customers see all
   day, so it wears the accent rather than hiding in a grey pill. */
/* pointer-events: auto on the trigger and the modal: a host's open modal (Radix,
   i.e. every shadcn Dialog) sets pointer-events: none on <body>, and both would
   inherit it — unclickable at the one moment someone needs to report a modal.
   The z-index stays BELOW the feedback board's ticket panel (2147483002/3):
   raised to the maximum, the trigger sat exactly on the panel's reply "Send"
   button (both anchor bottom-right) and a click meant to send a reply started a
   screenshot instead. Over that panel, Ctrl+Shift+B reports it. */
.aif-fab {
  position: fixed; right: 20px; bottom: 20px; z-index: 2147483000;
  pointer-events: auto;
  display: inline-flex; align-items: center; gap: 8px;
  padding: 10px 16px; border: 0; border-radius: 999px; cursor: pointer;
  background: var(--aif-accent); color: var(--aif-on-accent);
  font-weight: 600; font-size: 13px;
  box-shadow: var(--aif-shadow-raised);
  transition: transform .12s ease, background .12s ease, box-shadow .12s ease;
}
.aif-fab:hover { transform: translateY(-1px); background: var(--aif-accent-strong); }
.aif-fab svg { width: 15px; height: 15px; }

.aif-fab[aria-busy] { cursor: progress; opacity: .85; }

/* Overlay + modal shell. The overlay is a native <dialog> in the top layer
   (FeedbackModal.tsx), so the user-agent dialog box model is reset: no
   fit-content sizing, no max-size inset, no border, and its ::backdrop stays
   clear because the overlay paints the scrim itself. The class is doubled
   (0,2,0) so a host rule for its OWN dialogs — dialog:modal { max-width: … },
   dialog[open] { padding: … } at (0,1,1) — cannot reshape this one. */
.aif-overlay.aif-overlay {
  position: fixed; inset: 0; z-index: 2147483001;
  width: auto; height: auto; max-width: none; max-height: none;
  margin: 0; border: 0; outline: none; animation: none;
  pointer-events: auto;
  background: var(--aif-scrim); color: var(--aif-ink);
  display: flex; align-items: center; justify-content: center; padding: 24px;
}
.aif-overlay.aif-overlay:not([open]) { display: none; }
.aif-overlay.aif-overlay::backdrop { background: transparent; }
.aif-modal {
  background: var(--aif-surface); border-radius: 14px; width: 100%; max-width: 860px;
  max-height: calc(100vh - 48px); display: flex; flex-direction: column;
  box-shadow: var(--aif-shadow-overlay); overflow: hidden;
  border: 1px solid var(--aif-line);
}
.aif-modal-header {
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
  padding: 14px 18px; border-bottom: 1px solid var(--aif-line);
}
.aif-modal-title { font-size: 15px; font-weight: 700; letter-spacing: -.01em; }
.aif-modal-sub { font-size: 12px; color: var(--aif-ink-muted); margin-top: 2px; }
.aif-modal-body { padding: 18px; overflow: auto; flex: 1; }
.aif-modal-footer {
  display: flex; justify-content: space-between; align-items: center; gap: 12px;
  padding: 14px 18px; border-top: 1px solid var(--aif-line);
}
.aif-header-actions { display: flex; align-items: center; gap: 8px; }

/* Buttons */
.aif-btn {
  display: inline-flex; align-items: center; gap: 7px; cursor: pointer;
  border-radius: 8px; padding: 9px 15px; font-size: 13px; font-weight: 600;
  border: 1px solid transparent; transition: background .12s ease, border-color .12s ease;
}
.aif-btn svg { width: 14px; height: 14px; }
.aif-btn-primary { background: var(--aif-accent); color: var(--aif-on-accent); }
.aif-btn-primary:hover { background: var(--aif-accent-strong); }
.aif-btn-primary:disabled { background: var(--aif-ink-faint); cursor: default; }
.aif-btn-ghost { background: transparent; color: var(--aif-ink-muted); border-color: var(--aif-line); }
.aif-btn-ghost:hover { background: var(--aif-surface-2); color: var(--aif-ink); border-color: var(--aif-line-strong); }
.aif-icon-btn {
  display: inline-flex; align-items: center; justify-content: center;
  width: 32px; height: 32px; border-radius: 8px; border: 1px solid transparent;
  background: transparent; color: var(--aif-ink-muted); cursor: pointer;
}
.aif-icon-btn:hover { background: var(--aif-surface-2); color: var(--aif-ink); }
.aif-icon-btn.aif-active { background: var(--aif-accent); color: var(--aif-on-accent); }
.aif-icon-btn:disabled { color: var(--aif-ink-faint); cursor: default; background: transparent; }
.aif-icon-btn svg { width: 15px; height: 15px; }

/* Capture step */
.aif-capture { display: flex; flex-direction: column; align-items: center; gap: 14px; padding: 40px 0; color: var(--aif-ink-muted); }
.aif-spinner {
  width: 28px; height: 28px; border-radius: 50%;
  border: 3px solid var(--aif-line); border-top-color: var(--aif-accent);
  animation: aif-spin .8s linear infinite;
}
@keyframes aif-spin { to { transform: rotate(360deg); } }

/* Annotation workspace */
.aif-toolbar {
  display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
  padding: 8px 10px; border: 1px solid var(--aif-line); border-radius: 10px;
  margin-bottom: 12px; background: var(--aif-surface-2);
}
.aif-toolbar-group { display: flex; align-items: center; gap: 4px; }
.aif-toolbar-sep { width: 1px; height: 22px; background: var(--aif-line); }
.aif-swatch {
  width: 20px; height: 20px; border-radius: 50%; cursor: pointer;
  border: 2px solid var(--aif-line-strong); padding: 0;
}
.aif-swatch.aif-active { outline: 2px solid var(--aif-accent); outline-offset: 2px; }
.aif-width-select { border: 1px solid var(--aif-line); border-radius: 8px; padding: 5px 7px; font-size: 12px; background: var(--aif-surface); color: var(--aif-ink); }
.aif-stage-wrap { overflow: auto; border: 1px solid var(--aif-line); border-radius: 10px; background: var(--aif-surface-2); max-height: 55vh; }
.aif-stage { position: relative; margin: 0 auto; line-height: 0; }
.aif-stage img { width: 100%; height: auto; display: block; user-select: none; -webkit-user-drag: none; }
.aif-stage canvas { position: absolute; inset: 0; width: 100%; height: 100%; }
.aif-stage canvas.aif-draw-layer { cursor: crosshair; touch-action: none; }
.aif-text-input {
  position: absolute; z-index: 5; font-size: 14px; padding: 3px 6px;
  border: 1px dashed var(--aif-accent); border-radius: 4px;
  background: var(--aif-surface); color: var(--aif-ink); opacity: .96;
}
.aif-hint { font-size: 12px; color: var(--aif-ink-muted); margin-top: 8px; }

/* Describe step */
.aif-form { display: flex; flex-direction: column; gap: 14px; }
.aif-field { display: flex; flex-direction: column; gap: 6px; }
.aif-label { font-size: 12px; font-weight: 700; color: var(--aif-ink-muted); text-transform: uppercase; letter-spacing: .04em; }
.aif-textarea {
  min-height: 110px; resize: vertical; border: 1px solid var(--aif-line); border-radius: 8px;
  padding: 10px 12px; font: inherit; color: var(--aif-ink); background: var(--aif-surface);
}
.aif-textarea::placeholder { color: var(--aif-ink-faint); }
.aif-textarea:focus, .aif-select:focus, .aif-text-input:focus, .aif-width-select:focus {
  outline: 2px solid var(--aif-accent); outline-offset: 1px; border-color: transparent;
}
.aif-select { border: 1px solid var(--aif-line); border-radius: 8px; padding: 9px 12px; font: inherit; background: var(--aif-surface); color: var(--aif-ink); }
.aif-row { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
@media (max-width: 560px) { .aif-row { grid-template-columns: 1fr; } }
.aif-thumb { border: 1px solid var(--aif-line); border-radius: 10px; overflow: hidden; max-height: 180px; }
.aif-thumb img { width: 100%; height: 100%; object-fit: cover; object-position: top; display: block; }
.aif-error {
  background: var(--aif-danger-soft); border: 1px solid var(--aif-danger); color: var(--aif-danger);
  border-radius: 8px; padding: 10px 12px; font-size: 13px;
}
.aif-context-note { font-size: 12px; color: var(--aif-ink-muted); }

/* My reports list */
.aif-reports { display: flex; flex-direction: column; gap: 8px; }
.aif-report-row {
  display: flex; align-items: baseline; gap: 10px; width: 100%; text-align: left;
  border: 1px solid var(--aif-line); border-radius: 10px; padding: 11px 13px;
  background: var(--aif-surface); cursor: pointer; font: inherit; color: var(--aif-ink);
  transition: background .12s ease, border-color .12s ease;
}
.aif-report-row:hover { background: var(--aif-surface-2); border-color: var(--aif-line-strong); }
.aif-report-number { font-weight: 700; font-size: 12px; white-space: nowrap; color: var(--aif-accent); }
.aif-report-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.aif-report-age { font-size: 12px; color: var(--aif-ink-faint); white-space: nowrap; }

/* Thread view */
.aif-thread { display: flex; flex-direction: column; gap: 12px; }
.aif-thread-head { display: flex; align-items: center; gap: 10px; }
.aif-status-chip {
  display: inline-flex; align-items: center; border-radius: 999px;
  padding: 3px 10px; font-size: 11px; font-weight: 700;
  text-transform: uppercase; letter-spacing: .04em;
  background: var(--aif-accent-soft); color: var(--aif-accent);
}
.aif-thread-msgs { display: flex; flex-direction: column; gap: 8px; }
.aif-msg { border: 1px solid var(--aif-line); border-radius: 10px; padding: 9px 12px; font-size: 13px; }
.aif-msg-team { background: var(--aif-accent-soft); border-color: transparent; }
.aif-msg-mine { background: var(--aif-surface); }
.aif-msg-meta { display: flex; gap: 8px; font-size: 11px; color: var(--aif-ink-muted); margin-bottom: 3px; }
.aif-msg-body { white-space: pre-wrap; }
.aif-reply-row { display: flex; gap: 10px; align-items: flex-end; }
.aif-reply-input { flex: 1; min-height: 64px; }

/* Success step */
.aif-success { display: flex; flex-direction: column; align-items: center; gap: 10px; padding: 42px 0; text-align: center; }
.aif-success-badge {
  width: 44px; height: 44px; border-radius: 50%;
  background: var(--aif-accent-soft); color: var(--aif-accent);
  display: flex; align-items: center; justify-content: center;
}
.aif-success-badge svg { width: 22px; height: 22px; }
.aif-ticket-number { font-weight: 700; font-size: 15px; }
.aif-success-actions { display: flex; gap: 10px; margin-top: 4px; }
`;
