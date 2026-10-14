import { useEffect, useId, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { isValidEmail } from "../form.js";
import { formatMoney, zoneLabel } from "../format.js";
import type { ClientError } from "../http.js";
import { describedBy, Field, Loading, Notice, WidgetRoot } from "../parts.js";
import { normalizeHex } from "../styles.js";
import type { EstimatorAdminTransport } from "./client.js";
import {
  allTimeZones,
  bpToInput,
  centsToInput,
  COMMON_CURRENCIES,
  formatMicros,
  formatMicrosExact,
  issuesByField,
  parseMoneyInput,
  parseNumberInput,
  parsePercentInput,
  US_TIME_ZONES,
} from "./helpers.js";
import type { EstimatorSettingsPatch, EstimatorSettingsWire, UsageResponse } from "./types.js";
import { AdminFrame, errorSummary, LoadError, Panel, SaveRow, Switch, useAdminBasics, useAdminTransport, type AdminBasics, type AdminChromeProps } from "./ui.js";

/**
 * <EstimatorSettings> — what an owner sets once and tweaks rarely (contract
 * 9.7), in sections that each save on their own:
 *
 *   Business      name, contact, time zone, the brand colour (with a live
 *                 sample in both themes)
 *   Quotes        how long a quote is good for, when to follow up, the footer
 *   Pricing       tax, currency, the default labor rate and contingency
 *   Lead alerts   who hears about a new lead or an answer
 *   Your website  take instant estimates on/off
 *   Photos and AI photos on/off, the most reading may cost a day, readings per
 *                 person, and what it has cost
 *
 * Unsaved changes are marked; a save says "Saved"; a refusal from the server
 * lands on the field it is about, in its words.
 *
 * FIRST RUN. Until the business has saved its settings, the estimate page is
 * closed and no quote can be sent (the server enforces it). So a business
 * that never saved sees ONE form first, "Get started": the name, how to reach
 * them, the sales tax and the default labor rate, saved together. The other
 * sections open once that is saved (review EST-R02).
 */

export type EstimatorSettingsSection = "business" | "quotes" | "pricing" | "alerts" | "website" | "photos";

export interface EstimatorSettingsProps extends AdminChromeProps {
  /** Which sections, in this order. Default all six. */
  sections?: EstimatorSettingsSection[];
  /**
   * Offer the forms. The server still refuses a save without
   * `estimator.settings.manage`; false shows every section read-only (and,
   * before the first save, says who has to make it) instead of offering a
   * Save that would fail (Tenancy 2a: a company's member reads the quote
   * rules; its owner and admins set them). Default true.
   */
  canManage?: boolean;
}

/** Above the sections, for someone who may read them but not change them. */
export const READ_ONLY_SETTINGS = "Only the owner or an admin can change these settings.";
/** In place of the first-run form, for the same person. */
export const NOT_SAVED_READ_ONLY = "Your estimate page is closed until the owner or an admin saves these settings.";

const ALL_SECTIONS: EstimatorSettingsSection[] = ["business", "quotes", "pricing", "alerts", "website", "photos"];

export function EstimatorSettings(props: EstimatorSettingsProps) {
  const transport = useAdminTransport(props.transport, props.baseUrl);
  const basics = useAdminBasics(transport);
  const sections = props.sections && props.sections.length > 0 ? props.sections : ALL_SECTIONS;
  const canManage = props.canManage !== false;
  const settings = basics.settings;
  const saved = (next: EstimatorSettingsWire) => {
    basics.setSettings(next);
    basics.refresh();
  };
  return (
    <AdminFrame chrome={props} basics={basics} data={{ "aiew-settings": settings ? "ready" : basics.settingsError ? "error" : "loading" }}>
      <h2 className="aiew-admin-title">Estimate settings</h2>
      {basics.settingsError && !settings ? <LoadError error={basics.settingsError} onRetry={basics.refresh} /> : null}
      {!settings && !basics.settingsError ? <Loading label="Loading settings…" /> : null}
      {settings && !settings.saved ? (
        canManage ? (
          <GetStartedSection settings={settings} transport={transport} onSaved={saved} />
        ) : (
          <Notice tone="info" data="read-only">
            {NOT_SAVED_READ_ONLY}
          </Notice>
        )
      ) : null}
      {settings && settings.saved && !canManage ? (
        <p className="aiew-muted" data-aiew-read-only="">
          {READ_ONLY_SETTINGS}
        </p>
      ) : null}
      {/* Read-only is a disabled fieldset round every section: each field still
          shows its value, and nothing in it can be changed or sent. */}
      <fieldset disabled={!canManage} className="aiew-admin-fields" data-aiew-settings-fields="">
        {settings && settings.saved
          ? sections.map((section) => {
              const common = { key: section, settings, transport, onSaved: saved };
              switch (section) {
                case "business":
                  // Tenancy 2a, D6: a company's name, contact, zone and colour
                  // are the company's: read-only here, with the way to change them.
                  return settings.managedByCompany ? (
                    <ManagedBusinessSection key={section} settings={settings} href={settings.managedByCompany.href} />
                  ) : (
                    <BusinessSection {...common} />
                  );
                case "quotes":
                  return <QuotesSection {...common} />;
                case "pricing":
                  return <PricingSection {...common} />;
                case "alerts":
                  return <AlertsSection {...common} />;
                case "website":
                  return <WebsiteSection {...common} />;
                case "photos":
                  return <PhotosSection {...common} basics={basics} />;
                default:
                  return null;
              }
            })
          : null}
      </fieldset>
    </AdminFrame>
  );
}

// ---------------------------------------------------------------------------
// The draft for one section
// ---------------------------------------------------------------------------

interface SectionProps {
  settings: EstimatorSettingsWire;
  transport: EstimatorAdminTransport;
  onSaved: (settings: EstimatorSettingsWire) => void;
}

/** One section's own fields, the patch it sends (or the problem that stops it), and the save. */
function useDraft<T extends Record<string, unknown>>(
  initial: T,
  transport: EstimatorAdminTransport,
  toPatch: (draft: T) => EstimatorSettingsPatch | string,
  onSaved: (settings: EstimatorSettingsWire) => void,
) {
  const [draft, setDraft] = useState<T>(initial);
  const [base, setBase] = useState<T>(initial);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<ClientError | null>(null);
  const dirty = JSON.stringify(draft) !== JSON.stringify(base);
  const patch = toPatch(draft);
  const problem = typeof patch === "string" && dirty ? patch : null;
  const set = <K extends keyof T>(key: K, value: T[K]) => {
    setDraft((current) => ({ ...current, [key]: value }));
    setSaved(false);
  };
  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!dirty || busy || typeof patch === "string") return;
    setBusy(true);
    setError(null);
    const res = await transport.updateSettings(patch);
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setBase(draft);
    setSaved(true);
    onSaved(res.data.settings);
  };
  return { draft, set, dirty, busy, saved, error, problem, save, fields: issuesByField(error) };
}

function Form({ onSubmit, children }: { onSubmit: (event: FormEvent) => void; children: ReactNode }) {
  return (
    <form className="aiew-stack" onSubmit={onSubmit} noValidate>
      {children}
    </form>
  );
}

function TextInput({
  id,
  value,
  onChange,
  error,
  hint,
  type = "text",
  inputMode,
  maxLength,
  max,
  className = "aiew-input",
  autoComplete,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  error?: string | null;
  hint?: boolean;
  type?: string;
  inputMode?: "text" | "email" | "tel" | "decimal" | "numeric";
  maxLength?: number;
  /** The most it may be (the site's ceiling on photo-reading spend, in dollars). */
  max?: string;
  className?: string;
  autoComplete?: string;
}) {
  return (
    <input
      id={id}
      className={className}
      type={type}
      value={value}
      inputMode={inputMode}
      maxLength={maxLength}
      max={max}
      autoComplete={autoComplete ?? "off"}
      aria-invalid={error ? true : undefined}
      aria-describedby={describedBy(id, Boolean(hint), error)}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}

// ---------------------------------------------------------------------------
// Get started (first run)
// ---------------------------------------------------------------------------

function GetStartedSection({ settings, transport, onSaved }: SectionProps) {
  const ids = useId();
  // Tenancy 2a: with the business's basics coming from the company, the
  // first-run form asks only for what is still the estimator's own.
  const managed = settings.managedByCompany !== null;
  // Without access to costs the default labor rate is stripped (null): not asked.
  const asksLabor = settings.defaultLaborRateCents !== null;
  const [draft, setDraft] = useState({
    businessName: settings.businessName,
    contactPhone: settings.contactPhone ?? "",
    contactEmail: settings.contactEmail ?? "",
    // Empty, not the 8.25% default: the owner types the rate they charge.
    taxRate: "",
    laborRate: settings.defaultLaborRateCents ? centsToInput(settings.defaultLaborRateCents) : "",
  });
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ClientError | null>(null);
  const set = (key: keyof typeof draft, value: string) => setDraft((d) => ({ ...d, [key]: value }));

  const patch = ((): EstimatorSettingsPatch | string => {
    if (!managed && !draft.businessName.trim()) return "Add your business name.";
    if (!managed && draft.contactEmail.trim() && !isValidEmail(draft.contactEmail)) return "The contact email doesn't look right.";
    const tax = parsePercentInput(draft.taxRate);
    if (tax === null || Number.isNaN(tax) || tax < 0 || tax > 3000) return "Enter your sales tax rate, from 0% to 30% (0 if you don't charge tax).";
    const labor = asksLabor ? parseMoneyInput(draft.laborRate) : null;
    if (labor !== null && (Number.isNaN(labor) || labor < 0 || labor > 1_000_000)) return "Enter an hourly rate from $0 to $10,000.";
    return {
      ...(managed
        ? {}
        : {
            businessName: draft.businessName.trim(),
            contactPhone: draft.contactPhone.trim() || null,
            contactEmail: draft.contactEmail.trim() || null,
          }),
      taxRateBp: tax,
      ...(labor !== null ? { defaultLaborRateCents: labor } : {}),
    };
  })();
  const problem = tried && typeof patch === "string" ? patch : null;
  const fields = issuesByField(error);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setTried(true);
    if (busy || typeof patch === "string") return;
    setBusy(true);
    setError(null);
    const res = await transport.updateSettings(patch);
    setBusy(false);
    if (!res.ok) return setError(res.error);
    onSaved(res.data.settings);
  };

  return (
    <Panel
      id="get-started"
      title="Get started"
      hint="Your estimate page is closed until you save these: customers can't get a price, and quotes can't be sent. Everything else can wait."
    >
      <Form onSubmit={(event) => void save(event)}>
        {managed ? (
          <CompanyNote href={settings.managedByCompany?.href ?? null} />
        ) : (
          <Field id={`${ids}-name`} label="Business name" hint="On your quotes, your emails and the estimate page." error={fields.businessName ?? null}>
            <TextInput id={`${ids}-name`} hint value={draft.businessName} maxLength={120} error={fields.businessName} onChange={(v) => set("businessName", v)} />
          </Field>
        )}
        <div className="aiew-grid2">
          {managed ? null : (
            <>
              <Field id={`${ids}-phone`} label="Contact phone" optional hint="Shown on quotes, so customers can call." error={fields.contactPhone ?? null}>
                <TextInput id={`${ids}-phone`} type="tel" inputMode="tel" hint value={draft.contactPhone} maxLength={40} error={fields.contactPhone} onChange={(v) => set("contactPhone", v)} />
              </Field>
              <Field id={`${ids}-email`} label="Contact email" optional hint="Customers can reply to it." error={fields.contactEmail ?? null}>
                <TextInput id={`${ids}-email`} type="email" inputMode="email" hint value={draft.contactEmail} maxLength={320} error={fields.contactEmail} onChange={(v) => set("contactEmail", v)} />
              </Field>
            </>
          )}
          <Field id={`${ids}-tax`} label="Sales tax (%)" hint="Added on top of every estimate and quote. 0 if you don't charge tax." error={fields.taxRateBp ?? null}>
            <TextInput id={`${ids}-tax`} className="aiew-input aiew-number" inputMode="decimal" hint value={draft.taxRate} error={fields.taxRateBp} onChange={(v) => set("taxRate", v)} />
          </Field>
          {asksLabor ? (
            <Field
              id={`${ids}-labor`}
              label="Hourly labor rate ($)"
              optional
              hint="What an hour of your crew's time is charged at, for products that don't set their own. Empty: labor hours are priced at $0."
              error={fields.defaultLaborRateCents ?? null}
            >
              <TextInput id={`${ids}-labor`} className="aiew-input aiew-number" inputMode="decimal" hint value={draft.laborRate} error={fields.defaultLaborRateCents} onChange={(v) => set("laborRate", v)} />
            </Field>
          ) : null}
        </div>
        <div className="aiew-row">
          <button type="submit" className="aiew-btn aiew-btn-primary" disabled={busy} aria-busy={busy || undefined} data-aiew-get-started="">
            {busy ? "Saving…" : "Save and open my estimate page"}
          </button>
          {problem ? (
            <span className="aiew-danger-text" role="alert">
              {problem}
            </span>
          ) : error ? (
            <span className="aiew-danger-text" role="alert">
              {errorSummary(error)}
            </span>
          ) : null}
        </div>
        <p className="aiew-hint">The rest of your settings open once these are saved.</p>
      </Form>
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// Business
// ---------------------------------------------------------------------------

function BusinessSection({ settings, transport, onSaved }: SectionProps) {
  const ids = useId();
  const form = useDraft(
    {
      businessName: settings.businessName,
      contactEmail: settings.contactEmail ?? "",
      contactPhone: settings.contactPhone ?? "",
      timeZone: settings.timeZone,
      brandColor: settings.brandColor ?? "",
    },
    transport,
    (d) => {
      if (d.contactEmail.trim() && !isValidEmail(d.contactEmail)) return "The contact email doesn't look right.";
      if (d.brandColor.trim() && !normalizeHex(d.brandColor)) return "Use a colour like #0d6b64.";
      return {
        businessName: d.businessName.trim(),
        contactEmail: d.contactEmail.trim() || null,
        contactPhone: d.contactPhone.trim() || null,
        timeZone: d.timeZone,
        brandColor: normalizeHex(d.brandColor),
      };
    },
    onSaved,
  );
  const { draft, set, fields } = form;
  const usZone = US_TIME_ZONES.some((z) => z.zone === draft.timeZone);
  const [other, setOther] = useState(!usZone);
  const zones = useMemo(() => allTimeZones(), []);
  const colour = normalizeHex(draft.brandColor);
  return (
    <Panel id="business" title="Business" hint="On your quotes, your emails and the estimate page.">
      <Form onSubmit={(event) => void form.save(event)}>
        <Field id={`${ids}-name`} label="Business name" error={fields.businessName ?? null}>
          <TextInput id={`${ids}-name`} value={draft.businessName} maxLength={120} error={fields.businessName} onChange={(v) => set("businessName", v)} />
        </Field>
        <div className="aiew-grid2">
          <Field id={`${ids}-email`} label="Contact email" optional hint="Customers can reply to it." error={fields.contactEmail ?? null}>
            <TextInput id={`${ids}-email`} type="email" inputMode="email" hint value={draft.contactEmail} maxLength={320} error={fields.contactEmail} onChange={(v) => set("contactEmail", v)} />
          </Field>
          <Field id={`${ids}-phone`} label="Contact phone" optional hint="Shown on quotes, so customers can call." error={fields.contactPhone ?? null}>
            <TextInput id={`${ids}-phone`} type="tel" inputMode="tel" hint value={draft.contactPhone} maxLength={40} error={fields.contactPhone} onChange={(v) => set("contactPhone", v)} />
          </Field>
        </div>
        <Field id={`${ids}-zone`} label="Time zone" hint="Dates on quotes and in emails are written in it." error={fields.timeZone ?? null}>
          <select
            id={`${ids}-zone`}
            className="aiew-input"
            value={other ? "__other" : draft.timeZone}
            aria-describedby={describedBy(`${ids}-zone`, true, fields.timeZone)}
            onChange={(event) => {
              if (event.target.value === "__other") setOther(true);
              else {
                setOther(false);
                set("timeZone", event.target.value);
              }
            }}
          >
            {US_TIME_ZONES.map((z) => (
              <option key={z.zone} value={z.zone}>
                {z.label}
              </option>
            ))}
            <option value="__other">Other…</option>
          </select>
        </Field>
        {other ? (
          <Field id={`${ids}-zone-other`} label="Other time zone">
            <select id={`${ids}-zone-other`} className="aiew-input" value={draft.timeZone} onChange={(event) => set("timeZone", event.target.value)}>
              {zones.includes(draft.timeZone) ? null : <option value={draft.timeZone}>{draft.timeZone.replace(/_/g, " ")}</option>}
              {zones.map((z) => (
                <option key={z} value={z}>
                  {z.replace(/_/g, " ")}
                </option>
              ))}
            </select>
          </Field>
        ) : null}
        <Field id={`${ids}-colour`} label="Brand colour" optional hint="Buttons and links on your estimate and quote pages. Leave it empty for ours." error={fields.brandColor ?? null}>
          <div className="aiew-color-row">
            <input
              type="color"
              aria-label="Pick a colour"
              value={colour ?? "#0d6b64"}
              onChange={(event) => set("brandColor", event.target.value)}
            />
            <TextInput id={`${ids}-colour`} className="aiew-input aiew-number" hint value={draft.brandColor} maxLength={7} error={fields.brandColor} onChange={(v) => set("brandColor", v)} />
            {draft.brandColor ? (
              <button type="button" className="aiew-btn aiew-btn-link" onClick={() => set("brandColor", "")}>
                Use ours
              </button>
            ) : null}
          </div>
        </Field>
        <BrandSample colour={colour} />
        <SaveRow dirty={form.dirty} busy={form.busy} saved={form.saved} error={form.error} problem={form.problem} />
      </Form>
    </Panel>
  );
}

/** "These come from your company settings." with the way to change them (Tenancy 2a, D6). */
function CompanyNote({ href }: { href: string | null }) {
  return (
    <p className="aiew-hint" data-aiew-company-note="">
      These come from your company settings. {href ? <a href={href}>Change them in company settings</a> : null}
    </p>
  );
}

/** The business section when the company owns the basics: what customers see, read-only. */
function ManagedBusinessSection({ settings, href }: { settings: EstimatorSettingsWire; href: string | null }) {
  const colour = normalizeHex(settings.brandColor);
  return (
    <Panel id="business" title="Business" hint="On your quotes, your emails and the estimate page.">
      <div className="aiew-stack-sm" data-aiew-managed="">
        <CompanyNote href={href} />
        <dl className="aiew-facts">
          <div>
            <dt>Business name</dt>
            <dd>{settings.businessName || "Not set yet"}</dd>
          </div>
          <div>
            <dt>Contact email</dt>
            <dd>{settings.contactEmail ?? "Not set yet"}</dd>
          </div>
          <div>
            <dt>Contact phone</dt>
            <dd>{settings.contactPhone ?? "Not set yet"}</dd>
          </div>
          <div>
            <dt>Time zone</dt>
            <dd>{zoneLabel(settings.timeZone)}</dd>
          </div>
          <div>
            <dt>Brand colour</dt>
            <dd>{colour ?? "Ours (none set)"}</dd>
          </div>
        </dl>
      </div>
    </Panel>
  );
}

/** A primary button and a link in the chosen colour, in light AND dark: both must read well. */
function BrandSample({ colour }: { colour: string | null }) {
  return (
    <div className="aiew-swatches" data-aiew-brand-sample="">
      {(["light", "dark"] as const).map((theme) => (
        <WidgetRoot key={theme} theme={theme} accent={colour} className="aiew-swatch" data={{ "aiew-sample": theme }}>
          <span className="aiew-hint">{theme === "light" ? "On a light page" : "On a dark page"}</span>
          <span className="aiew-btn aiew-btn-primary" aria-hidden="true">
            Send me this estimate
          </span>
          <a href="#brand-sample" onClick={(event) => event.preventDefault()}>
            A link looks like this
          </a>
        </WidgetRoot>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Quotes
// ---------------------------------------------------------------------------

function QuotesSection({ settings, transport, onSaved }: SectionProps) {
  const ids = useId();
  const form = useDraft(
    { quoteValidDays: String(settings.quoteValidDays), followUpDays: String(settings.followUpDays), quoteFooter: settings.quoteFooter ?? "" },
    transport,
    (d) => {
      const valid = parseNumberInput(d.quoteValidDays);
      const follow = parseNumberInput(d.followUpDays);
      if (valid === null || !Number.isInteger(valid) || valid < 1 || valid > 365) return "Quotes can be good for 1 to 365 days.";
      if (follow === null || !Number.isInteger(follow) || follow < 0 || follow > 60) return "Follow up after 0 to 60 days.";
      return { quoteValidDays: valid, followUpDays: follow, quoteFooter: d.quoteFooter.trim() || null };
    },
    onSaved,
  );
  const { draft, set, fields } = form;
  return (
    <Panel id="quotes" title="Quotes" hint="What a customer gets when you send a quote.">
      <Form onSubmit={(event) => void form.save(event)}>
        <div className="aiew-grid2">
          <Field id={`${ids}-valid`} label="Quotes are good for (days)" hint="After this, the customer can't accept it online." error={fields.quoteValidDays ?? null}>
            <TextInput id={`${ids}-valid`} className="aiew-input aiew-number" inputMode="numeric" hint value={draft.quoteValidDays} error={fields.quoteValidDays} onChange={(v) => set("quoteValidDays", v)} />
          </Field>
          <Field id={`${ids}-follow`} label="Follow up after (days)" hint="One reminder email if they haven't answered. 0 = no follow-up." error={fields.followUpDays ?? null}>
            <TextInput id={`${ids}-follow`} className="aiew-input aiew-number" inputMode="numeric" hint value={draft.followUpDays} error={fields.followUpDays} onChange={(v) => set("followUpDays", v)} />
          </Field>
        </div>
        <Field id={`${ids}-footer`} label="Quote footer" optional hint='Printed at the bottom of every quote, e.g. "Price includes installation and haul-away."' error={fields.quoteFooter ?? null}>
          <textarea
            id={`${ids}-footer`}
            className="aiew-input"
            rows={3}
            maxLength={2000}
            value={draft.quoteFooter}
            aria-describedby={describedBy(`${ids}-footer`, true, fields.quoteFooter)}
            onChange={(event) => set("quoteFooter", event.target.value)}
          />
        </Field>
        <SaveRow dirty={form.dirty} busy={form.busy} saved={form.saved} error={form.error} problem={form.problem} />
      </Form>
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// Pricing
// ---------------------------------------------------------------------------

function PricingSection({ settings, transport, onSaved }: SectionProps) {
  const ids = useId();
  const known = COMMON_CURRENCIES.some((c) => c.code === settings.currency);
  // Null without access to costs: not shown, and never sent (a save would
  // otherwise zero the business's labor rate; review ADV-3).
  const showsLabor = settings.defaultLaborRateCents !== null;
  const form = useDraft(
    {
      taxRate: bpToInput(settings.taxRateBp),
      currency: settings.currency,
      laborRate: centsToInput(settings.defaultLaborRateCents),
      contingency: bpToInput(settings.contingencyBp),
    },
    transport,
    (d) => {
      const tax = parsePercentInput(d.taxRate);
      const labor = parseMoneyInput(d.laborRate);
      const contingency = parsePercentInput(d.contingency);
      if (tax === null || Number.isNaN(tax) || tax < 0 || tax > 3000) return "Enter a tax rate from 0% to 30%.";
      if (!/^[A-Z]{3}$/.test(d.currency.trim().toUpperCase())) return "Use a three-letter currency code, like USD.";
      if (labor !== null && (Number.isNaN(labor) || labor < 0 || labor > 1_000_000)) return "Enter an hourly rate from $0 to $10,000.";
      if (contingency !== null && (Number.isNaN(contingency) || contingency < 0 || contingency > 5000)) return "Enter a contingency from 0% to 50%.";
      return {
        taxRateBp: tax,
        currency: d.currency.trim().toUpperCase(),
        ...(showsLabor ? { defaultLaborRateCents: labor ?? 0 } : {}),
        contingencyBp: contingency ?? 0,
      };
    },
    onSaved,
  );
  const { draft, set, fields } = form;
  const [otherCurrency, setOtherCurrency] = useState(!known);
  return (
    <Panel id="pricing" title="Pricing" hint="Used by every product unless the product sets its own.">
      <Form onSubmit={(event) => void form.save(event)}>
        <div className="aiew-grid2">
          <Field id={`${ids}-tax`} label="Sales tax (%)" hint={settings.saved ? "Added on top of every estimate and quote." : "Not set yet: enter the rate you charge. It's added on top of every estimate and quote."} error={fields.taxRateBp ?? null}>
            <TextInput id={`${ids}-tax`} className="aiew-input aiew-number" inputMode="decimal" hint value={draft.taxRate} error={fields.taxRateBp} onChange={(v) => set("taxRate", v)} />
          </Field>
          <Field id={`${ids}-currency`} label="Currency" hint="Shown as set; nothing is converted." error={fields.currency ?? null}>
            <select
              id={`${ids}-currency`}
              className="aiew-input"
              value={otherCurrency ? "__other" : draft.currency}
              aria-describedby={describedBy(`${ids}-currency`, true, fields.currency)}
              onChange={(event) => {
                if (event.target.value === "__other") setOtherCurrency(true);
                else {
                  setOtherCurrency(false);
                  set("currency", event.target.value);
                }
              }}
            >
              {COMMON_CURRENCIES.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.label}
                </option>
              ))}
              <option value="__other">Other</option>
            </select>
          </Field>
          {otherCurrency ? (
            <Field id={`${ids}-currency-other`} label="Currency code" hint="Three letters, like CHF.">
              <TextInput id={`${ids}-currency-other`} className="aiew-input aiew-number" hint maxLength={3} value={draft.currency} onChange={(v) => set("currency", v.toUpperCase())} />
            </Field>
          ) : null}
          {showsLabor ? (
            <Field id={`${ids}-labor`} label="Default hourly labor rate ($)" hint="For products that don't set their own." error={fields.defaultLaborRateCents ?? null}>
              <TextInput id={`${ids}-labor`} className="aiew-input aiew-number" inputMode="decimal" hint value={draft.laborRate} error={fields.defaultLaborRateCents} onChange={(v) => set("laborRate", v)} />
            </Field>
          ) : null}
          <Field
            id={`${ids}-contingency`}
            label="Default contingency (%)"
            hint="Widens the range customers see on a measured product, both ways. 0 = none."
            error={fields.contingencyBp ?? null}
          >
            <TextInput id={`${ids}-contingency`} className="aiew-input aiew-number" inputMode="decimal" hint value={draft.contingency} error={fields.contingencyBp} onChange={(v) => set("contingency", v)} />
          </Field>
        </div>
        <SaveRow dirty={form.dirty} busy={form.busy} saved={form.saved} error={form.error} problem={form.problem} />
      </Form>
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// Lead alerts
// ---------------------------------------------------------------------------

function AlertsSection({ settings, transport, onSaved }: SectionProps) {
  const ids = useId();
  const form = useDraft(
    { emails: settings.leadNotifyEmails.length > 0 ? [...settings.leadNotifyEmails] : [""] },
    transport,
    (d) => {
      const list = d.emails.map((e) => e.trim()).filter(Boolean);
      const bad = list.find((e) => !isValidEmail(e));
      if (bad) return `"${bad}" doesn't look like an email address.`;
      if (list.length > 5) return "Up to 5 addresses.";
      return { leadNotifyEmails: list };
    },
    onSaved,
  );
  const { draft, set, fields } = form;
  return (
    <Panel id="alerts" title="Lead alerts" hint="Who gets an email for a new lead, and when a customer accepts or declines a quote.">
      <Form onSubmit={(event) => void form.save(event)}>
        {/* An empty list isn't "nobody" (review T2A-BO-14): with a company, the
            alerts go to its contact email. Said, so nobody types it in twice
            or thinks the leads are lost. */}
        {settings.managedByCompany && draft.emails.every((e) => !e.trim()) ? (
          <p className="aiew-hint" data-aiew-alerts-default="">
            {settings.contactEmail
              ? `Leave it empty and alerts go to ${settings.contactEmail}, your company's contact email.`
              : "Leave it empty and alerts go to your company's owner."}
          </p>
        ) : null}
        <ul className="aiew-stack-sm" style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {draft.emails.map((email, i) => (
            <li key={i} className="aiew-inline">
              <label className="aiew-sr" htmlFor={`${ids}-email-${i}`}>
                Alert email {i + 1}
              </label>
              <TextInput
                id={`${ids}-email-${i}`}
                type="email"
                inputMode="email"
                className="aiew-input aiew-grow"
                value={email}
                maxLength={320}
                error={fields[`leadNotifyEmails.${i}`]}
                onChange={(v) => set("emails", draft.emails.map((e, n) => (n === i ? v : e)))}
              />
              {draft.emails.length > 1 ? (
                <button type="button" className="aiew-btn aiew-btn-secondary aiew-btn-sm" onClick={() => set("emails", draft.emails.filter((_, n) => n !== i))}>
                  Remove
                </button>
              ) : null}
            </li>
          ))}
        </ul>
        {draft.emails.length < 5 ? (
          <button type="button" className="aiew-btn aiew-btn-secondary" style={{ justifySelf: "start" }} onClick={() => set("emails", [...draft.emails, ""])}>
            Add an address
          </button>
        ) : null}
        <SaveRow dirty={form.dirty} busy={form.busy} saved={form.saved} error={form.error} problem={form.problem ?? fields.leadNotifyEmails ?? null} />
      </Form>
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// Your website
// ---------------------------------------------------------------------------

function WebsiteSection({ settings, transport, onSaved }: SectionProps) {
  const form = useDraft({ on: settings.instantEstimatesEnabled }, transport, (d) => ({ instantEstimatesEnabled: d.on }), onSaved);
  return (
    <Panel id="website" title="Your website">
      <Form onSubmit={(event) => void form.save(event)}>
        <Switch
          checked={form.draft.on}
          onChange={(next) => form.set("on", next)}
          label="Take instant estimates"
          hint="Off: your estimate page and website embeds say instant estimates aren't available, and show your phone and email."
        />
        <SaveRow dirty={form.dirty} busy={form.busy} saved={form.saved} error={form.error} problem={form.problem} />
      </Form>
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// Photos and AI
// ---------------------------------------------------------------------------

function PhotosSection({ settings, transport, onSaved, basics }: SectionProps & { basics: AdminBasics }) {
  const ids = useId();
  const ceiling = settings.aiBudgetCeilingCents;
  const form = useDraft(
    { photos: settings.photosEnabled, budget: centsToInput(settings.aiDailyBudgetCents), perPerson: String(settings.aiPerRequesterDaily) },
    transport,
    (d) => {
      const budget = parseMoneyInput(d.budget);
      const perPerson = parseNumberInput(d.perPerson);
      if (budget === null || Number.isNaN(budget) || budget < 0 || budget > 100_000) return "Enter a daily limit from $0 to $1,000.";
      // The site's ceiling (Tenancy 2a, D14), said in the owner's money before the server has to.
      if (ceiling !== null && budget > ceiling) return `This site allows up to ${formatMoney(ceiling, settings.currency, settings.locale)} a day of photo reading per business.`;
      if (perPerson === null || !Number.isInteger(perPerson) || perPerson < 0 || perPerson > 100) return "Enter 0 to 100 readings per person.";
      return { photosEnabled: d.photos, aiDailyBudgetCents: budget, aiPerRequesterDaily: perPerson };
    },
    onSaved,
  );
  const { draft, set, fields } = form;
  const spend = basics.status?.spend ?? null;
  const [usage, setUsage] = useState<UsageResponse | null>(null);
  useEffect(() => {
    if (!spend) return;
    let alive = true;
    void transport.usage({ days: 30 }).then((res) => {
      if (alive && res.ok) setUsage(res.data);
    });
    return () => {
      alive = false;
    };
  }, [transport, spend]);
  return (
    <Panel id="photos" title="Photos and AI" hint="Customers can add a photo. The AI only says what it sees (how many steps, windows or items); your prices do the rest.">
      <Form onSubmit={(event) => void form.save(event)}>
        <Switch
          checked={draft.photos}
          onChange={(next) => set("photos", next)}
          label="Take photos"
          hint="Off: no photo button, and nothing is read."
        />
        <div className="aiew-grid2">
          <Field
            id={`${ids}-budget`}
            label="Most photo reading may cost per day ($)"
            hint={
              ceiling !== null
                ? `When today's readings reach it, customers enter the count by hand. 0 = reading off. Up to ${formatMoney(ceiling, settings.currency, settings.locale)} a day on this site.`
                : "When today's readings reach it, customers enter the count by hand. 0 = reading off."
            }
            error={fields.aiDailyBudgetCents ?? null}
          >
            <TextInput
              id={`${ids}-budget`}
              className="aiew-input aiew-number"
              inputMode="decimal"
              hint
              value={draft.budget}
              error={fields.aiDailyBudgetCents}
              onChange={(v) => set("budget", v)}
              {...(ceiling !== null ? { max: centsToInput(ceiling) } : {})}
            />
          </Field>
          <Field id={`${ids}-per`} label="Photo readings per person per day" hint="Stops one visitor running up the bill. 0 = reading off." error={fields.aiPerRequesterDaily ?? null}>
            <TextInput id={`${ids}-per`} className="aiew-input aiew-number" inputMode="numeric" hint value={draft.perPerson} error={fields.aiPerRequesterDaily} onChange={(v) => set("perPerson", v)} />
          </Field>
        </div>
        {spend ? (
          <p className="aiew-hint" data-aiew-spend="">
            Photo readings: {spend.readingsToday} today, {formatMicros(spend.costTodayMicros)}; {spend.readingsMonth} this month, {formatMicros(spend.costMonthMicros)}.
            {usage && usage.totals.readings > 0 ? ` About ${formatMicrosExact(usage.totals.averageCostMicros)} a photo.` : ""}
          </p>
        ) : null}
        <SaveRow dirty={form.dirty} busy={form.busy} saved={form.saved} error={form.error} problem={form.problem} />
      </Form>
    </Panel>
  );
}
