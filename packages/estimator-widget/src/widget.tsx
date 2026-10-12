import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import type { EstimatorPublicTransport } from "./client.js";
import { DEFAULT_INTRO, DEFAULT_TITLE, EstimateFlow, useEstimatorConfig } from "./EstimateTool.js";
import { Dialog, resolveAccent, WidgetRoot } from "./parts.js";
import { EstimatorTransport } from "./transport.js";
import type { EstimatorConfig } from "./types.js";

/**
 * 0.1's API, kept (contract 9.5): a provider holding the business's settings,
 * a floating "Get an instant estimate" button, and the dialog it opens —
 * which is now a REAL dialog (ES-14): labelled, Escape and a click outside
 * close it, focus is trapped inside and handed back to the button, and the
 * page doesn't scroll behind it. Inside, it is the same flow as the inline
 * `<EstimateTool>`.
 *
 *   <EstimatorProvider config={{ baseUrl: "https://summitramps.com/api/estimator", clientKey: "esk_…" }}>
 *     <EstimatorButton />
 *     <EstimatorModal />
 *   </EstimatorProvider>
 */

interface EstimatorContextValue {
  /** @deprecated 0.1's class, kept for hosts that call it. The components use `client`. */
  transport: EstimatorTransport;
  /** The transport the button and dialog use (a host's own, when passed to the provider). */
  client: EstimatorPublicTransport;
  config: EstimatorConfig;
  open: boolean;
  setOpen: (open: boolean) => void;
  /** The button that opened the dialog, so focus goes back to it on close. */
  openerRef: { current: HTMLElement | null };
}

const EstimatorContext = createContext<EstimatorContextValue | null>(null);

export function useEstimator(): EstimatorContextValue {
  const ctx = useContext(EstimatorContext);
  if (!ctx) throw new Error("useEstimator must be used inside <EstimatorProvider>");
  return ctx;
}

export function EstimatorProvider({
  config,
  transport,
  children,
}: {
  config: EstimatorConfig;
  /** Back the button and dialog with your own transport (tRPC, a server action) instead of `config.baseUrl`. */
  transport?: EstimatorPublicTransport;
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const openerRef = useRef<HTMLElement | null>(null);
  const legacy = useMemo(() => new EstimatorTransport(config.baseUrl, config.clientKey), [config.baseUrl, config.clientKey]);
  const client = transport ?? legacy.client;
  const value = useMemo(() => ({ transport: legacy, client, config, open, setOpen, openerRef }), [legacy, client, config, open]);
  return <EstimatorContext.Provider value={value}>{children}</EstimatorContext.Provider>;
}

/**
 * The floating button. It styles itself (the brand colour, the host's theme)
 * without wrapping the page in a card.
 *
 * CONTRACT: the button takes its colour from `config.accentColor` only. The
 * business's own setting arrives with the config, which the dialog loads when
 * it opens; loading it on every page view just to colour a button would cost
 * every visitor a request. A host that wants the brand colour on the button
 * passes `accentColor`.
 */
export function EstimatorButton({ label = "Get an instant estimate" }: { label?: string }) {
  const { setOpen, config, openerRef } = useEstimator();
  return (
    <WidgetRoot
      as="span"
      extraClass="aiew-fab-wrap"
      theme={config.theme}
      {...(config.nonce ? { nonce: config.nonce } : {})}
      accent={resolveAccent(config.accentColor, null)}
    >
      <button
        type="button"
        className="aiew-fab"
        aria-haspopup="dialog"
        onClick={(event) => {
          openerRef.current = event.currentTarget;
          setOpen(true);
        }}
      >
        {label}
      </button>
    </WidgetRoot>
  );
}

/** The dialog. Renders nothing while closed; the flow inside loads the business's products when it opens. */
export function EstimatorModal() {
  const ctx = useEstimator();
  if (!ctx.open) return null;
  return <OpenModal ctx={ctx} />;
}

function OpenModal({ ctx }: { ctx: EstimatorContextValue }) {
  const { client, config, setOpen, openerRef } = ctx;
  const { state, reload } = useEstimatorConfig(client);
  const loaded = state.status === "ready" ? state.config : null;
  const accent = resolveAccent(config.accentColor, loaded?.brandColor);
  const close = useCallback(() => setOpen(false), [setOpen]);
  const [phase, setPhase] = useState("loading");
  return (
    <WidgetRoot
      theme={config.theme}
      {...(config.nonce ? { nonce: config.nonce } : {})}
      accent={accent}
      data={{ "aiew-modal": phase }}
    >
      <Dialog
        title={config.title ?? DEFAULT_TITLE}
        subtitle={config.subtitle ?? DEFAULT_INTRO}
        onClose={close}
        returnFocus={() => openerRef.current}
        data={{ "aiew-dialog": "estimate" }}
      >
        <EstimateFlow
          transport={client}
          configState={state}
          reload={reload}
          showHeader={false}
          onPhase={setPhase}
          {...(config.bookHref ? { bookHref: config.bookHref } : {})}
          {...(config.poweredBy ? { poweredBy: true } : {})}
          {...(config.locale ? { locale: config.locale } : {})}
        />
      </Dialog>
    </WidgetRoot>
  );
}
