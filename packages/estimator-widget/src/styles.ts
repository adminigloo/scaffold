const STYLE_ID = "aie-styles";

/**
 * The widget's own token set, `--aie-*`, with a dark theme via
 * prefers-color-scheme — the same self-containment rule the feedback widget
 * follows: this renders inside a page whose CSS it cannot know, so every colour
 * resolves through a token and nothing depends on the host's Tailwind.
 */
const CSS_TEXT = `
.aie-root, .aie-fab, .aie-backdrop {
  --aie-surface: #ffffff;
  --aie-surface-2: #f5f7f9;
  --aie-ink: #0e161c;
  --aie-ink-muted: #55636f;
  --aie-ink-faint: #8494a1;
  --aie-line: #e1e7ec;
  --aie-line-strong: #c3ced7;
  --aie-accent: #0c7d8c;
  --aie-accent-strong: #095f6b;
  --aie-accent-soft: #d6eef1;
  --aie-danger: #a02e21;
  --aie-on-accent: #ffffff;
  --aie-shadow: 0 8px 40px rgba(14,22,28,.22);
  --aie-scrim: rgba(10,14,17,.5);
}
@media (prefers-color-scheme: dark) {
  .aie-root, .aie-fab, .aie-backdrop {
    --aie-surface: #161d23;
    --aie-surface-2: #0f1418;
    --aie-ink: #e8edf1;
    --aie-ink-muted: #93a2ae;
    --aie-ink-faint: #61707c;
    --aie-line: #29343d;
    --aie-line-strong: #3c4a55;
    --aie-accent: #45c4ad;
    --aie-accent-strong: #6cd6c3;
    --aie-accent-soft: #113029;
    --aie-danger: #e08272;
    --aie-on-accent: #0e161c;
    --aie-shadow: 0 8px 40px rgba(0,0,0,.55);
    --aie-scrim: rgba(0,0,0,.6);
  }
}
.aie-fab { position: fixed; right: 20px; bottom: 20px; z-index: 2147483000;
  border: 0; border-radius: 999px; background: var(--aie-accent); color: var(--aie-on-accent);
  font: 600 14px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  padding: 12px 18px; cursor: pointer; box-shadow: var(--aie-shadow); }
.aie-fab:hover { background: var(--aie-accent-strong); }
.aie-backdrop { position: fixed; inset: 0; z-index: 2147483001; background: var(--aie-scrim);
  display: flex; align-items: center; justify-content: center; padding: 16px; }
.aie-modal { width: min(560px, 100%); max-height: 92vh; overflow-y: auto; background: var(--aie-surface);
  border-radius: 16px; box-shadow: var(--aie-shadow); color: var(--aie-ink);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
.aie-head { display: flex; align-items: flex-start; gap: 10px; padding: 18px 20px 6px; }
.aie-title { font-size: 18px; font-weight: 700; letter-spacing: -.01em; }
.aie-sub { font-size: 13px; color: var(--aie-ink-muted); margin-top: 2px; }
.aie-close { margin-left: auto; border: 0; background: transparent; font-size: 22px; line-height: 1;
  color: var(--aie-ink-muted); cursor: pointer; padding: 0 4px; }
.aie-body { padding: 8px 20px 20px; display: flex; flex-direction: column; gap: 14px; }
.aie-label { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .05em;
  color: var(--aie-ink-faint); display: block; margin-bottom: 6px; }
.aie-chips { display: flex; flex-wrap: wrap; gap: 8px; }
.aie-chip { border: 1px solid var(--aie-line); background: var(--aie-surface); color: var(--aie-ink-muted);
  border-radius: 8px; padding: 6px 11px; font-size: 13px; cursor: pointer; }
.aie-chip:hover { border-color: var(--aie-line-strong); color: var(--aie-ink); }
.aie-chip.aie-on { border-color: var(--aie-accent); background: var(--aie-accent-soft); color: var(--aie-accent); font-weight: 600; }
.aie-fields { display: flex; flex-wrap: wrap; gap: 12px; align-items: flex-end; }
.aie-field { display: flex; flex-direction: column; gap: 4px; }
.aie-input { border: 1px solid var(--aie-line-strong); border-radius: 8px; padding: 8px 10px; font: inherit;
  font-size: 14px; background: var(--aie-surface); color: var(--aie-ink); width: 100%; box-sizing: border-box; }
.aie-drop { border: 1px dashed var(--aie-line-strong); border-radius: 10px; padding: 12px; background: var(--aie-surface-2); }
.aie-note { font-size: 12px; color: var(--aie-ink-muted); }
.aie-range { border: 1px solid var(--aie-line); border-radius: 10px; padding: 14px; background: var(--aie-surface-2); }
.aie-range-n { font-size: 26px; font-weight: 700; letter-spacing: -.01em; margin-top: 4px; }
.aie-detail { border: 1px solid var(--aie-line); border-radius: 8px; padding: 8px 11px; font-size: 12px; color: var(--aie-ink-muted); }
.aie-btn { border: 0; border-radius: 8px; background: var(--aie-accent); color: var(--aie-on-accent);
  font: 600 14px inherit; padding: 10px 16px; cursor: pointer; }
.aie-btn:hover { background: var(--aie-accent-strong); }
.aie-btn:disabled { background: var(--aie-ink-faint); cursor: default; }
.aie-btn-ghost { background: transparent; color: var(--aie-ink-muted); }
.aie-ok { border: 1px solid var(--aie-accent); background: var(--aie-accent-soft); color: var(--aie-accent);
  border-radius: 10px; padding: 12px 14px; font-size: 14px; }
.aie-powered { text-align: center; font-size: 11px; color: var(--aie-ink-faint); padding: 4px 0 14px; }
`;

export function injectStyles(): void {
  if (typeof document === "undefined" || document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = CSS_TEXT;
  document.head.appendChild(style);
}
