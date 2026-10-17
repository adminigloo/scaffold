import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { AssistantChat } from "./AssistantChat.js";
import type { AssistantTransport } from "./client.js";
import { injectStyles } from "./styles.js";
import { useHostTheme, useStyles } from "./theme.js";
import type { AssistantConfig } from "./types.js";

/**
 * The assistant on every page: a floating button that opens the chat as a
 * slide-over panel (full screen on a phone).
 *
 * A REAL DIALOG: `role="dialog"` with `aria-modal`, labelled by the chat's
 * title; focus moves into it (the question box) and is TRAPPED there — Tab and
 * Shift+Tab cycle inside — Escape or the scrim closes it, and focus returns to
 * the button. The page behind doesn't scroll while it's open. The conversation
 * is kept while the panel is closed and opened again.
 */

export interface AssistantLauncherProps {
  config: AssistantConfig;
  transport?: AssistantTransport;
  /** The button's words. Default "Ask the assistant". */
  label?: string;
  /** Open on first render (a page that links straight to the assistant). */
  defaultOpen?: boolean;
}

const FOCUSABLE = 'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function AssistantLauncher({ config, transport, label = "Ask the assistant", defaultOpen = false }: AssistantLauncherProps) {
  useStyles(injectStyles);
  const rootRef = useRef<HTMLDivElement>(null);
  const theme = useHostTheme(rootRef, config.theme ?? "auto");
  const [open, setOpen] = useState(defaultOpen);
  // Mounted once opened, then kept: closing hides the panel, it doesn't end the conversation.
  const [started, setStarted] = useState(defaultOpen);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

  const close = useCallback(() => {
    setOpen(false);
    // Back to where the person was.
    requestAnimationFrameSafe(() => buttonRef.current?.focus());
  }, []);

  useEffect(() => {
    if (!open || typeof document === "undefined") return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    // Into the dialog: the question box, else the first control.
    requestAnimationFrameSafe(() => {
      const sheet = sheetRef.current;
      const box = sheet?.querySelector<HTMLElement>("textarea") ?? sheet?.querySelector<HTMLElement>(FOCUSABLE);
      box?.focus();
    });
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open]);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      close();
      return;
    }
    if (event.key !== "Tab") return;
    const sheet = sheetRef.current;
    if (!sheet) return;
    const items = [...sheet.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => !el.hasAttribute("hidden"));
    if (items.length === 0) return;
    const first = items[0]!;
    const last = items[items.length - 1]!;
    const active = document.activeElement;
    if (event.shiftKey && (active === first || !sheet.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || !sheet.contains(active))) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div ref={rootRef} className="aia-root" data-theme={theme} data-aia-launcher="">
      {open ? null : (
        <button
          ref={buttonRef}
          type="button"
          className="aia-launcher"
          aria-haspopup="dialog"
          aria-expanded={false}
          onClick={() => {
            setStarted(true);
            setOpen(true);
          }}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z" />
          </svg>
          {label}
        </button>
      )}
      {started ? (
        <div hidden={!open}>
          <div className="aia-scrim" onClick={close} aria-hidden="true" />
          <div
            ref={sheetRef}
            className="aia-sheet"
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            onKeyDown={onKeyDown}
          >
            <AssistantChat config={config} transport={transport} onClose={close} titleId={titleId} />
          </div>
        </div>
      ) : null}
    </div>
  );
}

function requestAnimationFrameSafe(run: () => void): void {
  if (typeof window !== "undefined" && typeof window.requestAnimationFrame === "function") window.requestAnimationFrame(run);
  else setTimeout(run, 0);
}
