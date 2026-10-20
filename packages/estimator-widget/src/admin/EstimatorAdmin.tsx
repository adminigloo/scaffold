import { useId, useRef, useState, type KeyboardEvent } from "react";
import { EmbedKeys } from "./EmbedKeys.js";
import { EstimateEditor } from "./EstimateEditor.js";
import { EstimatesQueue } from "./EstimatesQueue.js";
import { EstimatorSettings } from "./EstimatorSettings.js";
import { PriceBook } from "./PriceBook.js";
import { AdminNotices, AdminRoot, AdminShellProvider, useAdminTransport, useShellBasics, type AdminChromeProps } from "./ui.js";

/**
 * <EstimatorAdmin> — the whole estimator for the office, in four tabs
 * (contract 9.7): Estimates (the queue, and one estimate opened in place),
 * Price book, Settings, Website embed. It reads the status and the settings
 * ONCE and shares them with every tab, so the notices ("Set your business
 * details…", "Customers won't get emails…") show once, at the top.
 *
 * Each tab is also its own export, for a host that wants them on separate
 * pages (create-app mounts the queue, the editor, the price book and the
 * settings on their own admin routes).
 */

export type EstimatorAdminSection = "estimates" | "pricebook" | "settings" | "keys";

export interface EstimatorAdminProps extends AdminChromeProps {
  /** Which tabs, in this order. Default all four. */
  sections?: EstimatorAdminSection[];
  initialSection?: EstimatorAdminSection;
  /** Links to an estimate's own page instead of opening it in place. */
  estimateHref?: string | ((id: string) => string);
  /** The public estimator's address for the embed snippet. Default the server's, then `${location.origin}/api/estimator`. */
  embedBaseUrl?: string;
}

const ALL: EstimatorAdminSection[] = ["estimates", "pricebook", "settings", "keys"];
const LABEL: Record<EstimatorAdminSection, string> = { estimates: "Estimates", pricebook: "Price book", settings: "Settings", keys: "Website embed" };

export function EstimatorAdmin(props: EstimatorAdminProps) {
  const transport = useAdminTransport(props.transport, props.baseUrl);
  const basics = useShellBasics(transport);
  const ids = useId();
  const sections = props.sections && props.sections.length > 0 ? props.sections : ALL;
  const [section, setSection] = useState<EstimatorAdminSection>(
    props.initialSection && sections.includes(props.initialSection) ? props.initialSection : sections[0]!,
  );
  const [openId, setOpenId] = useState<string | null>(null);
  const tabRefs = useRef<Partial<Record<EstimatorAdminSection, HTMLButtonElement | null>>>({});

  const onTabKey = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const delta = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    const target = event.key === "Home" ? 0 : event.key === "End" ? sections.length - 1 : delta ? (index + delta + sections.length) % sections.length : -1;
    if (target < 0) return;
    event.preventDefault();
    const next = sections[target]!;
    setSection(next);
    tabRefs.current[next]?.focus();
  };

  const chrome = { theme: props.theme, nonce: props.nonce, className: props.className, style: props.style, accentColor: props.accentColor, locale: props.locale };
  const child = { transport, ...(props.locale ? { locale: props.locale } : {}) };

  return (
    <AdminRoot chrome={chrome} brandColor={basics.settings?.brandColor ?? null} data={{ "aiew-admin": section }}>
      <div className="aiew-admin-inner">
        {basics.status ? <AdminNotices notices={basics.status.notices} showTechnical={props.showTechnical === true} /> : null}
        <div className="aiew-tabs" role="tablist" aria-label="Estimator">
          {sections.map((key, i) => (
            <button
              key={key}
              ref={(el) => {
                tabRefs.current[key] = el;
              }}
              type="button"
              role="tab"
              id={`${ids}-tab-${key}`}
              aria-controls={`${ids}-panel`}
              aria-selected={section === key}
              tabIndex={section === key ? 0 : -1}
              className="aiew-tab"
              data-tab={key}
              onClick={() => {
                setSection(key);
                if (key === "estimates") setOpenId(null);
              }}
              onKeyDown={(event) => onTabKey(event, i)}
            >
              {LABEL[key]}
            </button>
          ))}
        </div>
        <div role="tabpanel" id={`${ids}-panel`} aria-labelledby={`${ids}-tab-${section}`}>
          <AdminShellProvider value={basics}>
            {section === "estimates" ? (
              openId ? (
                <EstimateEditor key={openId} {...child} estimateId={openId} onBack={() => setOpenId(null)} onOpenEstimate={setOpenId} />
              ) : (
                <EstimatesQueue {...child} {...(props.estimateHref ? { estimateHref: props.estimateHref } : {})} onOpen={setOpenId} />
              )
            ) : section === "pricebook" ? (
              <PriceBook {...child} />
            ) : section === "settings" ? (
              <EstimatorSettings {...child} />
            ) : (
              <EmbedKeys {...child} {...(props.embedBaseUrl ? { embedBaseUrl: props.embedBaseUrl } : {})} />
            )}
          </AdminShellProvider>
        </div>
      </div>
    </AdminRoot>
  );
}
