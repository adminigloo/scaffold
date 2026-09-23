/**
 * A stand-in for a buyer's app: React 19 + a shadcn-shaped Radix Dialog (the
 * most common modal a Next.js/Tailwind buyer has), Headless UI, a native
 * <dialog>, a floating AI chat panel, and the feedback widget mounted the way a
 * buyer mounts it. The browser specs drive it like a person: open the modal,
 * press the feedback button, type.
 *
 * Bundled by bundle.mjs from the widget's SOURCE, with react/react-dom pinned to
 * e2e's single copy so the widget and Radix share one React. The platform URL is
 * a fake host the specs intercept with page.route.
 */
import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import * as Dialog from "@radix-ui/react-dialog";
import { Dialog as HDialog, DialogBackdrop, DialogPanel, DialogTitle } from "@headlessui/react";
import {
  FeedbackButton,
  FeedbackModal,
  FeedbackProvider,
  useFeedback,
} from "../../packages/feedback-widget/src/index";

export const PLATFORM = "https://feedback.test/api";

declare global {
  interface Window {
    __host: {
      openDialog: () => void;
      openChat: () => void;
      openNativeDialog: () => void;
      openHeadless: () => void;
      headlessOpen: () => boolean;
      openBoardPanel: () => void;
      nativeDialogOpen: () => boolean;
      dialogOpen: () => boolean;
      openSecrets: () => void;
      secretState: () => { apiKey: string };
      openClickaway: () => void;
      clickawayOpen: () => boolean;
    };
    __fb: { step: string; isOpen: boolean; shot: string | null };
  }
}

const marker = (name: string, color: string, pos: React.CSSProperties) => (
  <div data-marker={name} style={{ position: "absolute", width: 48, height: 48, background: color, ...pos }} />
);

/** Mirrors widget state onto window so the spec can read the real screenshot. */
function Spy() {
  const f = useFeedback();
  useEffect(() => {
    window.__fb = { step: f.step, isOpen: f.isOpen, shot: f.screenshot?.dataUrl ?? null };
  });
  return null;
}

/**
 * A modal with a React-CONTROLLED secret field that re-renders on a timer (a
 * clock, polling, a streaming chat) — the shape that leaked a secret when
 * redaction swapped live values: the re-render wrote the real value back
 * between layer captures. Big red text so a leak is visible in pixels.
 */
function SecretsModal() {
  const [apiKey, setApiKey] = useState("WWWWWWWWWWWWWWWWWWWWWWWW");
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 2);
    (window.__host as { secretState?: () => { apiKey: string } }).secretState = () => ({ apiKey });
    return () => clearInterval(id);
  });
  const big: React.CSSProperties = { font: "28px monospace", color: "rgb(255,0,0)", width: 620, border: 0, background: "#fff" };
  return (
    <>
      {/* A second, lower fixed layer, so the modal is not the first capture. */}
      <div style={{ position: "fixed", left: 0, bottom: 0, width: 200, height: 80, zIndex: 10, background: "rgb(0,128,255)" }} />
      <div role="dialog" data-secrets-modal style={{ position: "fixed", left: 40, top: 60, width: 700, height: 360, zIndex: 50, background: "#fff" }}>
        <input data-secret="apiKey" name="apiKey" value={apiKey} onChange={(e) => setApiKey(e.target.value)} style={{ ...big, position: "absolute", left: 20, top: 20 }} />
        <input data-secret="password" type="password" name="password" defaultValue="hunter2" style={{ position: "absolute", left: 20, top: 90 }} />
        <input data-secret="card" name="credit_card" defaultValue="4242424242424242" style={{ ...big, position: "absolute", left: 20, top: 150 }} />
        <textarea data-secret="pk" name="private_key" defaultValue="WWWWWWWWWWWWWWWWWWWWWWWW" style={{ ...big, position: "absolute", left: 20, top: 220, height: 50, resize: "none" }} />
        <input data-secret="auto" type="text" autoComplete="current-password" defaultValue="WWWWWWWWWWWWWWWWWWWWWWWW" style={{ ...big, position: "absolute", left: 20, top: 290 }} />
      </div>
    </>
  );
}

function HostApp() {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const nativeRef = useRef<HTMLDialogElement>(null);
  const [headlessOpen, setHeadlessOpen] = useState(false);
  const [boardPanelOpen, setBoardPanelOpen] = useState(false);
  const [secretsOpen, setSecretsOpen] = useState(false);
  const [clickawayOpen, setClickawayOpen] = useState(false);
  const clickawayRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    window.__host = {
      ...(window.__host ?? {}),
      openDialog: () => setDialogOpen(true),
      openChat: () => setChatOpen(true),
      openNativeDialog: () => nativeRef.current?.showModal(),
      nativeDialogOpen: () => !!nativeRef.current?.open,
      openHeadless: () => setHeadlessOpen(true),
      headlessOpen: () => !!document.querySelector("[data-headless-panel]"),
      openBoardPanel: () => setBoardPanelOpen(true),
      dialogOpen: () => !!document.querySelector("[data-host-dialog][data-state='open']"),
      openSecrets: () => setSecretsOpen(true),
      secretState: () => ({ apiKey: "" }),
      openClickaway: () => setClickawayOpen(true),
      clickawayOpen: () => !!document.querySelector("[data-clickaway-panel]"),
    };
  }, []);

  // MUI ClickAwayListener's shape: a document `click` outside the panel closes it.
  useEffect(() => {
    if (!clickawayOpen) return;
    const onClick = (event: MouseEvent) => {
      if (clickawayRef.current && !clickawayRef.current.contains(event.target as Node)) {
        queueMicrotask(() => setClickawayOpen(false));
      }
    };
    const id = setTimeout(() => document.addEventListener("click", onClick), 0);
    return () => {
      clearTimeout(id);
      document.removeEventListener("click", onClick);
    };
  }, [clickawayOpen]);

  return (
    <>
      {/* A host rule for its OWN native dialogs; must not reshape the widget's. */}
      <style>{`dialog:modal { max-width: 420px; max-height: 300px; } dialog[open] { padding: 1rem; }`}</style>

      <main style={{ padding: 24, font: "16px sans-serif", minHeight: 2000, background: "rgb(230,230,230)" }}>
        <h1>Host app</h1>
        <p>Background page content.</p>
        <p>
          <code data-sensitive="true" data-probe="secret-code">sk_live_TOPSECRET123</code>
        </p>
        <div data-feedback-ignore data-probe="ignored">IGNORED-acct-99887766</div>
        <button data-probe="plain">Plain host button</button>
      </main>

      {/* shadcn's DialogContent, as Tailwind v4 compiles it: left/top 50% + the
          independent `translate` property. */}
      <Dialog.Root
        open={dialogOpen}
        onOpenChange={(open) => {
          // Record WHO closed it — the spec prints this when the modal dies unexpectedly.
          if (!open) (window as unknown as { __closedBy?: string }).__closedBy = new Error().stack;
          setDialogOpen(open);
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.8)", zIndex: 50 }} />
          <Dialog.Content
            data-host-dialog
            aria-describedby={undefined}
            style={{
              position: "fixed",
              left: "50%",
              top: "50%",
              translate: "-50% -50%",
              width: 480,
              height: 320,
              zIndex: 50,
              background: "#fff",
              borderRadius: 12,
              font: "16px sans-serif",
            }}
          >
            <Dialog.Title style={{ position: "absolute", left: 80, top: 16, margin: 0 }}>AI interview</Dialog.Title>
            <input data-host-input placeholder="Host dialog field" style={{ position: "absolute", left: 80, top: 140 }} />
            {marker("tl", "rgb(255,0,0)", { left: 12, top: 12 })}
            {marker("tr", "rgb(0,200,0)", { right: 12, top: 12 })}
            {marker("bl", "rgb(0,0,255)", { left: 12, bottom: 12 })}
            {marker("br", "rgb(255,0,255)", { right: 12, bottom: 12 })}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      {/* A host modal built on the platform <dialog>: everything outside it is
          inert, so only the keyboard shortcut can reach the widget. */}
      <dialog
        ref={nativeRef}
        data-native-host-dialog
        style={{ width: 360, height: 220, padding: 0, border: 0, background: "rgb(255,0,255)" }}
      >
        <input data-native-input placeholder="Native dialog field" />
      </dialog>

      {/* Headless UI v2 (Tailwind UI / Catalyst shape). It makes the app root inert
          while open, and treats a press anywhere outside the panel as a close. */}
      <HDialog open={headlessOpen} onClose={() => setHeadlessOpen(false)} style={{ position: "relative", zIndex: 50 }}>
        <DialogBackdrop style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.3)" }} />
        <div style={{ position: "fixed", inset: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <DialogPanel data-headless-panel style={{ width: 420, height: 260, background: "rgb(0,200,0)", position: "relative" }}>
            <DialogTitle style={{ margin: 0, padding: 12, font: "16px sans-serif" }}>Headless dialog</DialogTitle>
            <input data-headless-input placeholder="Headless field" style={{ marginLeft: 12 }} />
          </DialogPanel>
        </div>
      </HDialog>

      {/* The feedback board ticket panel shape: a scrim and a drawer ABOVE the
          widget's range (2147483002 / 2147483003), with its reply Send button in
          the same bottom-right corner as the Feedback button. */}
      {boardPanelOpen ? (
        <>
          <div style={{ position: "fixed", inset: 0, zIndex: 2147483002, background: "rgba(0,0,0,0.3)" }} onClick={() => setBoardPanelOpen(false)} />
          <aside data-board-panel style={{ position: "fixed", top: 0, right: 0, bottom: 0, width: 420, zIndex: 2147483003, background: "rgb(255,140,0)" }}>
            <button data-board-send style={{ position: "absolute", right: 16, bottom: 12, width: 60, height: 33 }}>
              Send
            </button>
          </aside>
        </>
      ) : null}

      {secretsOpen ? <SecretsModal /> : null}

      {clickawayOpen ? (
        <div ref={clickawayRef} data-clickaway-panel style={{ position: "fixed", right: 24, top: 24, width: 260, height: 160, zIndex: 30, background: "rgb(16,185,129)" }} />
      ) : null}

      {chatOpen ? (
        <div
          data-chat-panel
          style={{ position: "fixed", left: 24, bottom: 24, width: 320, height: 420, zIndex: 40, background: "#fff" }}
        >
          <div data-marker="chat" style={{ position: "absolute", left: 40, top: 140, width: 160, height: 100, background: "rgb(0,128,255)" }} />
        </div>
      ) : null}
    </>
  );
}

createRoot(document.getElementById("root")!).render(
  <FeedbackProvider config={{ baseUrl: PLATFORM, clientKey: "fbk_e2e" }}>
    <HostApp />
    <FeedbackButton />
    <FeedbackModal />
    <Spy />
  </FeedbackProvider>,
);
