const STYLE_ID = "aia-styles";

/**
 * The chat surface's own token set, `--aia-*`, dark theme via
 * prefers-color-scheme — self-contained so it needs no CSS from the host, the
 * same rule the feedback and estimator widgets follow.
 */
const CSS_TEXT = `
.aia-root {
  --aia-surface: #ffffff;
  --aia-surface-2: #f5f7f9;
  --aia-ink: #0e161c;
  --aia-ink-muted: #55636f;
  --aia-ink-faint: #8494a1;
  --aia-line: #e1e7ec;
  --aia-line-strong: #c3ced7;
  --aia-accent: #0c7d8c;
  --aia-accent-strong: #095f6b;
  --aia-accent-soft: #d6eef1;
  --aia-danger: #a02e21;
  --aia-warn: #7d5a0c;
  --aia-on-accent: #ffffff;
  display: flex; flex-direction: column; height: 100%; min-height: 0;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  color: var(--aia-ink); background: var(--aia-surface);
}
@media (prefers-color-scheme: dark) {
  .aia-root {
    --aia-surface: #161d23; --aia-surface-2: #0f1418; --aia-ink: #e8edf1;
    --aia-ink-muted: #93a2ae; --aia-ink-faint: #61707c; --aia-line: #29343d;
    --aia-line-strong: #3c4a55; --aia-accent: #45c4ad; --aia-accent-strong: #6cd6c3;
    --aia-accent-soft: #113029; --aia-danger: #e08272; --aia-warn: #cfa14e; --aia-on-accent: #0e161c;
  }
}
.aia-thread { flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 12px; min-height: 0; }
.aia-msg { max-width: 85%; padding: 10px 13px; border-radius: 14px; font-size: 14px; line-height: 1.5; white-space: pre-wrap; overflow-wrap: anywhere; }
.aia-user { align-self: flex-end; background: var(--aia-accent); color: var(--aia-on-accent); border-bottom-right-radius: 4px; }
.aia-assistant { align-self: flex-start; background: var(--aia-surface-2); border: 1px solid var(--aia-line); border-bottom-left-radius: 4px; }
.aia-truncated { border-color: var(--aia-warn); }
.aia-activity { align-self: flex-start; display: inline-flex; align-items: center; gap: 8px; font-size: 12px; color: var(--aia-ink-muted); }
.aia-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--aia-accent); animation: aia-pulse 1s ease-in-out infinite; }
@keyframes aia-pulse { 0%,100% { opacity: .3; } 50% { opacity: 1; } }
@media (prefers-reduced-motion: reduce) { .aia-dot { animation: none; } }
.aia-action { align-self: flex-start; max-width: 85%; border: 1px solid var(--aia-accent); background: var(--aia-accent-soft);
  border-radius: 12px; padding: 10px 13px; font-size: 13px; }
.aia-action-label { font-weight: 700; text-transform: uppercase; letter-spacing: .04em; font-size: 10px; color: var(--aia-accent); }
.aia-action-buttons { display: flex; gap: 8px; margin-top: 8px; }
.aia-confirm { border: 0; border-radius: 8px; padding: 5px 12px; font-size: 13px; font-weight: 600; cursor: pointer;
  background: var(--aia-accent); color: var(--aia-on-accent); }
.aia-decline { border: 1px solid var(--aia-line-strong); border-radius: 8px; padding: 5px 12px; font-size: 13px; cursor: pointer;
  background: var(--aia-surface); color: var(--aia-ink-muted); }
.aia-error { align-self: center; color: var(--aia-danger); font-size: 13px; text-align: center; }
.aia-compose { display: flex; gap: 8px; padding: 12px; border-top: 1px solid var(--aia-line); }
.aia-input { flex: 1; resize: none; min-height: 40px; max-height: 140px; border: 1px solid var(--aia-line-strong);
  border-radius: 10px; padding: 9px 11px; font: inherit; font-size: 14px; background: var(--aia-surface); color: var(--aia-ink); }
.aia-send { align-self: flex-end; border: 0; border-radius: 10px; background: var(--aia-accent); color: var(--aia-on-accent);
  font: 600 14px inherit; padding: 9px 16px; cursor: pointer; }
.aia-send:hover { background: var(--aia-accent-strong); }
.aia-send:disabled { background: var(--aia-ink-faint); cursor: default; }
.aia-empty { margin: auto; color: var(--aia-ink-faint); font-size: 13px; text-align: center; padding: 24px; }
`;

export function injectStyles(): void {
  if (typeof document === "undefined" || document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = CSS_TEXT;
  document.head.appendChild(style);
}
