import { useId, useState } from "react";
import type { TenancyTransport } from "./client.js";
import { CompanyMark, LiveRegion, navigate, PauseIcon, WidgetRoot, type ChromeProps, type NounProps } from "./parts.js";
import { useAnnouncer, useTenancyTransport } from "./transport.js";
import type { CompanyChoiceWire } from "./types.js";
import { errorText, nounOf, SUSPENDED } from "./words.js";

/**
 * <CompanySuspended> (contract 8.8): what a member sees when an operator has
 * suspended their company (decision D15). Plain and short: it's suspended,
 * contact support to restore it, and, for someone in other companies, a way
 * to carry on working in one of those.
 *
 * NOTHING ABOUT WHY. The operator's reason is staff-only; the company's
 * people are told where to ask, not what was written about them.
 */

export interface CompanySuspendedProps extends ChromeProps, NounProps {
  companyName: string;
  /** The person's other companies, to switch to. */
  companies?: CompanyChoiceWire[];
  baseUrl?: string;
  transport?: TenancyTransport;
  /** "Contact support" becomes a mailto link to this address. */
  supportEmail?: string | null;
  /** Where to go after switching. Default "/dashboard". */
  reloadHref?: string;
}

export function CompanySuspended(props: CompanySuspendedProps) {
  const { companyName, companies = [], supportEmail, reloadHref = "/dashboard", theme, nonce, className, style } = props;
  const noun = nounOf(props.noun);
  const transport = useTenancyTransport(props.transport, props.baseUrl);
  const { status, alert, fail } = useAnnouncer();
  const [busy, setBusy] = useState<string | null>(null);
  const headingId = useId();
  // Somewhere else to work: an ACTIVE company that isn't this one.
  const others = companies.filter((c) => c.status === "active" && !c.active && c.name !== companyName);

  const switchTo = async (choice: CompanyChoiceWire) => {
    setBusy(choice.id);
    const res = await transport.setActive(choice.id);
    if (res.ok) {
      navigate(reloadHref);
      return;
    }
    setBusy(null);
    fail(errorText(res.error, noun));
  };

  return (
    <WidgetRoot theme={theme} nonce={nonce} className={className} style={style} data={{ "aitw-suspended": "" }}>
      <section className="aitw-panel aitw-centre" aria-labelledby={headingId}>
        <div className="aitw-row">
          <span className="aitw-badge-icon">
            <PauseIcon />
          </span>
          <h2 className="aitw-title aitw-grow" id={headingId}>
            {SUSPENDED.heading(companyName)}
          </h2>
        </div>
        <p>
          {SUSPENDED.bodyBefore}
          {supportEmail ? <a href={`mailto:${supportEmail}`}>{SUSPENDED.contactSupport}</a> : SUSPENDED.contactSupport}
          {SUSPENDED.bodyAfter}
        </p>
        {others.length > 0 ? (
          <div className="aitw-stack-sm">
            <p className="aitw-h3">{SUSPENDED.switchTo(noun)}</p>
            <ul className="aitw-switch-list">
              {others.map((choice) => (
                <li key={choice.id}>
                  <button
                    type="button"
                    className="aitw-btn aitw-btn-secondary"
                    disabled={busy !== null}
                    aria-busy={busy === choice.id || undefined}
                    onClick={() => void switchTo(choice)}
                  >
                    <CompanyMark name={choice.name} logoUrl={choice.logoUrl} />
                    {choice.name}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        <LiveRegion status={status} alert={alert} />
      </section>
    </WidgetRoot>
  );
}
