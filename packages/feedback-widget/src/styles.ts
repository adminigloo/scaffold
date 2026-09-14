/**
 * The widget's entire appearance, injected once as a <style> tag. Every rule
 * is prefixed `aif-` and scoped under the widget's own roots, so the host
 * app's CSS cannot break the widget and the widget cannot break the host.
 * This is what "React is the only peer" costs: no Tailwind, no CSS import
 * step for the buyer, no assumptions.
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
.aif-root, .aif-root * { box-sizing: border-box; margin: 0; padding: 0; }
.aif-root {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  font-size: 14px; line-height: 1.45; color: #1a1d21;
}

/* Floating trigger */
.aif-fab {
  position: fixed; right: 20px; bottom: 20px; z-index: 2147483000;
  display: inline-flex; align-items: center; gap: 8px;
  padding: 10px 16px; border: 0; border-radius: 999px; cursor: pointer;
  background: #1a1d21; color: #ffffff; font-weight: 600; font-size: 13px;
  box-shadow: 0 4px 14px rgba(0,0,0,.25);
  transition: transform .12s ease, box-shadow .12s ease;
}
.aif-fab:hover { transform: translateY(-1px); box-shadow: 0 6px 18px rgba(0,0,0,.3); }
.aif-fab svg { width: 15px; height: 15px; }

/* Overlay + modal shell */
.aif-overlay {
  position: fixed; inset: 0; z-index: 2147483001;
  background: rgba(10, 12, 14, .55);
  display: flex; align-items: center; justify-content: center; padding: 24px;
}
.aif-modal {
  background: #ffffff; border-radius: 12px; width: 100%; max-width: 860px;
  max-height: calc(100vh - 48px); display: flex; flex-direction: column;
  box-shadow: 0 24px 64px rgba(0,0,0,.35); overflow: hidden;
}
.aif-modal-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 14px 18px; border-bottom: 1px solid #e7e9ec;
}
.aif-modal-title { font-size: 15px; font-weight: 700; }
.aif-modal-sub { font-size: 12px; color: #6b7280; margin-top: 2px; }
.aif-modal-body { padding: 18px; overflow: auto; flex: 1; }
.aif-modal-footer {
  display: flex; justify-content: space-between; align-items: center; gap: 12px;
  padding: 14px 18px; border-top: 1px solid #e7e9ec;
}

/* Buttons */
.aif-btn {
  display: inline-flex; align-items: center; gap: 7px; cursor: pointer;
  border-radius: 8px; padding: 9px 15px; font-size: 13px; font-weight: 600;
  border: 1px solid transparent; transition: background .12s ease;
}
.aif-btn svg { width: 14px; height: 14px; }
.aif-btn-primary { background: #1a1d21; color: #ffffff; }
.aif-btn-primary:hover { background: #33383f; }
.aif-btn-primary:disabled { background: #9aa0a8; cursor: default; }
.aif-btn-ghost { background: transparent; color: #40444b; border-color: #d4d8dd; }
.aif-btn-ghost:hover { background: #f3f4f6; }
.aif-icon-btn {
  display: inline-flex; align-items: center; justify-content: center;
  width: 32px; height: 32px; border-radius: 7px; border: 1px solid transparent;
  background: transparent; color: #4b5158; cursor: pointer;
}
.aif-icon-btn:hover { background: #f3f4f6; }
.aif-icon-btn.aif-active { background: #1a1d21; color: #ffffff; }
.aif-icon-btn:disabled { color: #c3c8cf; cursor: default; background: transparent; }
.aif-icon-btn svg { width: 15px; height: 15px; }

/* Capture step */
.aif-capture { display: flex; flex-direction: column; align-items: center; gap: 14px; padding: 40px 0; color: #4b5158; }
.aif-spinner {
  width: 28px; height: 28px; border-radius: 50%;
  border: 3px solid #e7e9ec; border-top-color: #1a1d21;
  animation: aif-spin .8s linear infinite;
}
@keyframes aif-spin { to { transform: rotate(360deg); } }

/* Annotation workspace */
.aif-toolbar {
  display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
  padding: 8px 10px; border: 1px solid #e7e9ec; border-radius: 10px;
  margin-bottom: 12px; background: #fafbfc;
}
.aif-toolbar-group { display: flex; align-items: center; gap: 4px; }
.aif-toolbar-sep { width: 1px; height: 22px; background: #e0e3e7; }
.aif-swatch {
  width: 20px; height: 20px; border-radius: 50%; cursor: pointer;
  border: 2px solid rgba(0,0,0,.12); padding: 0;
}
.aif-swatch.aif-active { outline: 2px solid #1a1d21; outline-offset: 2px; }
.aif-width-select { border: 1px solid #d4d8dd; border-radius: 7px; padding: 5px 7px; font-size: 12px; background: #ffffff; }
.aif-stage-wrap { overflow: auto; border: 1px solid #e7e9ec; border-radius: 10px; background: #f0f1f3; max-height: 55vh; }
.aif-stage { position: relative; margin: 0 auto; line-height: 0; }
.aif-stage img { width: 100%; height: auto; display: block; user-select: none; -webkit-user-drag: none; }
.aif-stage canvas { position: absolute; inset: 0; width: 100%; height: 100%; }
.aif-stage canvas.aif-draw-layer { cursor: crosshair; touch-action: none; }
.aif-text-input {
  position: absolute; z-index: 5; font-size: 14px; padding: 3px 6px;
  border: 1px dashed #1a1d21; border-radius: 4px; background: rgba(255,255,255,.95);
}
.aif-hint { font-size: 12px; color: #6b7280; margin-top: 8px; }

/* Describe step */
.aif-form { display: flex; flex-direction: column; gap: 14px; }
.aif-field { display: flex; flex-direction: column; gap: 6px; }
.aif-label { font-size: 12px; font-weight: 700; color: #40444b; text-transform: uppercase; letter-spacing: .03em; }
.aif-textarea {
  min-height: 110px; resize: vertical; border: 1px solid #d4d8dd; border-radius: 8px;
  padding: 10px 12px; font: inherit; color: inherit;
}
.aif-textarea:focus, .aif-select:focus, .aif-text-input:focus { outline: 2px solid #1a1d21; outline-offset: 1px; border-color: transparent; }
.aif-select { border: 1px solid #d4d8dd; border-radius: 8px; padding: 9px 12px; font: inherit; background: #ffffff; }
.aif-row { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
@media (max-width: 560px) { .aif-row { grid-template-columns: 1fr; } }
.aif-thumb { border: 1px solid #e7e9ec; border-radius: 10px; overflow: hidden; max-height: 180px; }
.aif-thumb img { width: 100%; height: 100%; object-fit: cover; object-position: top; display: block; }
.aif-error {
  background: #fdf1f1; border: 1px solid #f3c9c9; color: #a13030;
  border-radius: 8px; padding: 10px 12px; font-size: 13px;
}
.aif-context-note { font-size: 12px; color: #6b7280; }

/* Header actions (My reports / back) */
.aif-header-actions { display: flex; align-items: center; gap: 8px; }

/* My reports list */
.aif-reports { display: flex; flex-direction: column; gap: 8px; }
.aif-report-row {
  display: flex; align-items: baseline; gap: 10px; width: 100%; text-align: left;
  border: 1px solid #e7e9ec; border-radius: 10px; padding: 11px 13px;
  background: #ffffff; cursor: pointer; font: inherit; color: inherit;
  transition: background .12s ease, border-color .12s ease;
}
.aif-report-row:hover { background: #f7f8f9; border-color: #d4d8dd; }
.aif-report-number { font-weight: 700; font-size: 12px; white-space: nowrap; }
.aif-report-title {
  flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.aif-report-age { font-size: 12px; color: #6b7280; white-space: nowrap; }

/* Thread view */
.aif-thread { display: flex; flex-direction: column; gap: 12px; }
.aif-thread-head { display: flex; align-items: center; gap: 10px; }
.aif-status-chip {
  display: inline-flex; align-items: center; border-radius: 999px;
  padding: 3px 10px; font-size: 12px; font-weight: 600;
  background: #eef1f4; color: #40444b;
}
.aif-thread-msgs { display: flex; flex-direction: column; gap: 8px; }
.aif-msg { border: 1px solid #e7e9ec; border-radius: 10px; padding: 9px 12px; font-size: 13px; }
.aif-msg-team { background: #f4f6ff; border-color: #dfe4fb; }
.aif-msg-mine { background: #ffffff; }
.aif-msg-meta { display: flex; gap: 8px; font-size: 11px; color: #6b7280; margin-bottom: 3px; }
.aif-msg-body { white-space: pre-wrap; }
.aif-reply-row { display: flex; gap: 10px; align-items: flex-end; }
.aif-reply-input { flex: 1; min-height: 64px; }

/* Success step */
.aif-success { display: flex; flex-direction: column; align-items: center; gap: 10px; padding: 42px 0; text-align: center; }
.aif-success-actions { display: flex; gap: 10px; margin-top: 4px; }
.aif-success-badge {
  width: 44px; height: 44px; border-radius: 50%; background: #eaf7ee; color: #217a3c;
  display: flex; align-items: center; justify-content: center;
}
.aif-success-badge svg { width: 22px; height: 22px; }
.aif-ticket-number { font-weight: 700; font-size: 15px; }
`;
