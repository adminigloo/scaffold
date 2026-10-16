import { useCallback, useEffect, useId, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { isValidEmail } from "../form.js";
import type { ClientError } from "../http.js";
import { CopyField, describedBy, Field, Loading, Notice, type ChromeProps } from "../parts.js";
import { formatClock, formatDateRange, formatDuration, formatTimeRange, isDate, todayIn, zoneLabel } from "../time.js";
import type { SchedulingAdminTransport } from "./client.js";
import {
  adminErrorText,
  allTimeZones,
  groupTimeOff,
  issuesByField,
  nextWindow,
  noticeMinutes,
  noticeParts,
  QUARTER_HOURS,
  serviceKeyFrom,
  strandedVisitsWarning,
  US_TIME_ZONES,
  WEEK_ORDER,
  WEEKDAYS,
  weekFromWindows,
  weekProblem,
  windowsFromWeek,
  type EditWindow,
} from "./helpers.js";
import type {
  AdminResource,
  AdminStatus,
  AvailabilityResponse,
  PersonOption,
  ResourceInput,
  ServiceWire,
  SettingsPatch,
  SettingsWire,
} from "./types.js";
import { AdminNotices, AdminRoot, Check, Outcome, Switch, useAdminStatus, useAdminTransport } from "./ui.js";

/**
 * <SchedulingSettings> — everything an owner sets once and tweaks rarely
 * (contract 8.7), in five cards that each save on their own:
 *
 *   Business          name, time zone, contact, who gets new-request alerts
 *   Online booking    on/off, auto-confirm, services, notice, how far ahead…
 *   Customer messages when unanswered requests are released, the reminder,
 *                     the online change cutoff
 *   Crews             add, edit, pause online booking, remove and restore
 *   Hours             each crew's week (split shifts allowed) and days off
 *
 * Unsaved changes are marked; a save says "Saved"; a refusal from the server
 * lands on the field it is about, in its words. Every field has one plain
 * sentence of help, written for the owner, not a developer.
 *
 * At the top, what the owner should know (the server's `status`): setup left
 * to do on a new site — online booking still off, no business name, no phone —
 * and whether customer emails and reminders actually go out.
 */

export type SettingsSection = "business" | "booking" | "messages" | "crews" | "hours";

export interface SchedulingSettingsProps extends ChromeProps {
  /** The mounted staff handlers, e.g. "/api/admin/schedule". Ignored when `transport` is given. */
  baseUrl?: string;
  transport?: SchedulingAdminTransport;
  /** false = read-only. Default true. */
  canManage?: boolean;
  /** Which cards, in this order. Default all five. */
  sections?: SettingsSection[];
  /** "Your booking page: …" with a copy button. */
  bookingPageUrl?: string;
  /** Where a new crew member signs in once, so they can be picked for their crew. Shown beside the picker. */
  signInUrl?: string;
  /**
   * Where the owner invites people (Tenancy 2a, a company's Team page). When
   * given, the crew-person picker's hint is "Not listed? Invite them on the
   * Team page." linking here, in place of the sign-in hint: in a company the
   * picker lists the company's own people, and the way in is an invitation.
   */
  inviteHref?: string | null;
}

const ALL_SECTIONS: SettingsSection[] = ["business", "booking", "messages", "crews", "hours"];

/** The cards a link can open on (the setup checklist links "#booking" and "#crews"). */
const DEEP_LINKS: ReadonlySet<string> = new Set(["booking", "crews", "hours", "business", "messages"]);

export function SchedulingSettings(props: SchedulingSettingsProps) {
  const locale = props.locale ?? "en-US";
  const canManage = props.canManage !== false;
  const transport = useAdminTransport(props.transport, props.baseUrl);
  const sections = props.sections && props.sections.length > 0 ? props.sections : ALL_SECTIONS;
  const [settings, setSettings] = useState<SettingsWire | null>(null);
  const [resources, setResources] = useState<AdminResource[] | null>(null);
  const [error, setError] = useState<ClientError | null>(null);
  const [reload, setReload] = useState(0);
  const [statusReload, setStatusReload] = useState(0);
  const status = useAdminStatus(transport, statusReload);
  const [people, setPeople] = useState<PersonOption[] | null | undefined>(undefined);

  // Who can be picked for a crew's route. `undefined` until known; `null`
  // when the host lists nobody (the screen falls back to typing the login).
  useEffect(() => {
    let alive = true;
    if (typeof transport.people !== "function") {
      setPeople(null);
      return;
    }
    void transport.people().then((res) => {
      if (alive) setPeople(res.ok ? res.data.people : null);
    });
    return () => {
      alive = false;
    };
  }, [transport]);
  const savedSettings = useCallback((next: SettingsWire) => {
    setSettings(next);
    setStatusReload((n) => n + 1);
  }, []);

  useEffect(() => {
    let alive = true;
    setError(null);
    void Promise.all([transport.getSettings(), transport.listResources({ includeInactive: true })]).then(([s, r]) => {
      if (!alive) return;
      if (s.ok) setSettings(s.data.settings);
      else setError(s.error);
      if (r.ok) setResources(r.data.resources);
      else setError((current) => current ?? r.error);
    });
    return () => {
      alive = false;
    };
  }, [transport, reload]);

  // Deep links (the setup checklist's "#booking", "#crews", "#hours"): once
  // the cards are on the page, scroll to that card and put focus on its
  // heading, so a keyboard or screen-reader user lands where the link said.
  const cardsReady = Boolean(settings && resources);
  useEffect(() => {
    if (!cardsReady || typeof window === "undefined") return;
    const focusHash = () => {
      const hash = window.location.hash.replace(/^#/, "");
      if (!DEEP_LINKS.has(hash)) return;
      const heading = document.querySelector<HTMLElement>(`[data-aisw-card="${hash}"] .aisw-card-title`);
      if (!heading) return;
      if (typeof heading.scrollIntoView === "function") heading.scrollIntoView({ block: "start" });
      heading.focus();
    };
    focusHash();
    window.addEventListener("hashchange", focusHash);
    return () => window.removeEventListener("hashchange", focusHash);
  }, [cardsReady]);

  const replaceResource = useCallback((next: AdminResource) => {
    setResources((list) => {
      if (!list) return [next];
      return list.some((r) => r.id === next.id) ? list.map((r) => (r.id === next.id ? next : r)) : [...list, next];
    });
  }, []);

  return (
    <AdminRoot theme={props.theme} nonce={props.nonce} className={props.className} style={props.style} data={{ "aisw-settings": settings ? "ready" : "loading" }}>
      <div className="aisw-admin-inner">
        <h2 className="aisw-admin-title">Schedule settings</h2>
        {props.bookingPageUrl ? (
          <CopyField
            label="Your booking page"
            value={props.bookingPageUrl}
            buttonLabel="Copy link"
            hint="Share it, or link to it from your website. Customers pick a time there."
          />
        ) : null}
        {!canManage ? <Notice tone="info">You can look, but not change these settings.</Notice> : null}
        {status ? <AdminNotices notices={status.notices} /> : null}
        {error ? (
          <Notice tone="error">
            {adminErrorText(error)}{" "}
            <button type="button" className="aisw-btn aisw-btn-link" onClick={() => setReload((n) => n + 1)}>
              Try again
            </button>
          </Notice>
        ) : null}
        {!settings && !error ? <Loading label="Loading settings…" /> : null}
        {settings
          ? sections.map((section) => {
              switch (section) {
                case "business":
                  return <BusinessCard key={section} settings={settings} transport={transport} canManage={canManage} status={status} onSaved={savedSettings} />;
                case "booking":
                  return (
                    <BookingCard key={section} settings={settings} transport={transport} canManage={canManage} bookingPageUrl={props.bookingPageUrl} onSaved={savedSettings} />
                  );
                case "messages":
                  return <MessagesCard key={section} settings={settings} transport={transport} canManage={canManage} status={status} onSaved={savedSettings} />;
                case "crews":
                  return resources ? (
                    <CrewsCard
                      key={section}
                      resources={resources}
                      transport={transport}
                      canManage={canManage}
                      locale={locale}
                      people={people}
                      signInUrl={props.signInUrl}
                      inviteHref={props.inviteHref ?? null}
                      onChanged={replaceResource}
                    />
                  ) : null;
                case "hours":
                  return resources ? (
                    <HoursCard
                      key={section}
                      resources={resources.filter((r) => r.isActive)}
                      transport={transport}
                      canManage={canManage}
                      timeZone={settings.timeZone}
                      locale={locale}
                    />
                  ) : null;
                default:
                  return null;
              }
            })
          : null}
      </div>
    </AdminRoot>
  );
}

// ---------------------------------------------------------------------------
// Shared card chrome and save logic
// ---------------------------------------------------------------------------

function Card({ id, title, hint, children }: { id: string; title: string; hint?: string; children: ReactNode }) {
  const headingId = useId();
  return (
    // `id` is the card's plain name, so "#booking" in a link scrolls here
    // natively too; the heading takes focus (tabIndex -1) for deep links.
    <section className="aisw-card" aria-labelledby={headingId} data-aisw-card={id} id={id}>
      <div className="aisw-card-head">
        <h3 className="aisw-card-title" id={headingId} tabIndex={-1}>
          {title}
        </h3>
        {hint ? <p className="aisw-card-hint">{hint}</p> : null}
      </div>
      <div className="aisw-card-body">{children}</div>
    </section>
  );
}

function SaveRow({
  dirty,
  busy,
  saved,
  error,
  problem,
  label = "Save",
  canManage,
  canSave,
  pendingNote,
}: {
  dirty: boolean;
  busy: boolean;
  saved: boolean;
  error: ClientError | null;
  problem?: string | null;
  label?: string;
  canManage: boolean;
  /** Saving is useful though nothing was edited (a crew's usual hours, never saved). Default: `dirty`. */
  canSave?: boolean;
  /** What to say instead of "Unsaved changes" when there's something to save but nobody edited anything. */
  pendingNote?: string | null;
}) {
  if (!canManage) return null;
  const savable = canSave ?? dirty;
  return (
    <div className="aisw-row">
      <button type="submit" className="aisw-btn aisw-btn-primary" disabled={!savable || busy || Boolean(problem)} aria-busy={busy || undefined}>
        {busy ? "Saving…" : label}
      </button>
      {dirty ? <span className="aisw-dirty">Unsaved changes</span> : pendingNote && savable && !saved ? <span className="aisw-hint">{pendingNote}</span> : null}
      <Outcome ok={saved && !dirty ? "Saved" : null} error={problem ?? (error ? errorSummary(error) : null)} />
    </div>
  );
}

function errorSummary(error: ClientError): string {
  if (error.code === "invalid" && error.issues && error.issues.length > 0) return "Check the highlighted fields.";
  return adminErrorText(error);
}

/** The draft for one card: its own fields, the patch to send, and the save. */
function useSettingsDraft<T extends Record<string, unknown>>(
  initial: T,
  transport: SchedulingAdminTransport,
  toPatch: (draft: T) => SettingsPatch,
  onSaved: (settings: SettingsWire) => void,
  extraPatch?: () => Partial<SettingsPatch>,
) {
  const [draft, setDraft] = useState<T>(initial);
  const [base, setBase] = useState<T>(initial);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<ClientError | null>(null);
  const dirty = JSON.stringify(draft) !== JSON.stringify(base);
  const set = <K extends keyof T>(key: K, value: T[K]) => {
    setDraft((current) => ({ ...current, [key]: value }));
    setSaved(false);
  };
  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!dirty || busy) return;
    setBusy(true);
    setError(null);
    const res = await transport.updateSettings({ ...toPatch(draft), ...(extraPatch?.() ?? {}) });
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setBase(draft);
    setSaved(true);
    onSaved(res.data.settings);
  };
  return { draft, setDraft, set, dirty, busy, saved, error, save, fields: issuesByField(error) };
}

function numberOr(value: string, fallback: number): number {
  const n = Number(value);
  return value.trim() !== "" && Number.isFinite(n) ? n : fallback;
}

// ---------------------------------------------------------------------------
// Business
// ---------------------------------------------------------------------------

function BusinessCard({
  settings,
  transport,
  canManage,
  status,
  onSaved,
}: {
  settings: SettingsWire;
  transport: SchedulingAdminTransport;
  canManage: boolean;
  status: AdminStatus | null;
  onSaved: (settings: SettingsWire) => void;
}) {
  const ids = useId();
  // Whether to email the customers a time-zone correction moves (BO-08).
  const [tellCustomers, setTellCustomers] = useState(false);
  const initial = {
    businessName: settings.businessName,
    timeZone: settings.timeZone,
    contactPhone: settings.contactPhone ?? "",
    contactEmail: settings.contactEmail ?? "",
    staffNotifyEmails: settings.staffNotifyEmails.length > 0 ? [...settings.staffNotifyEmails] : [""],
  };
  // Tenancy 2a, D6: the name, zone and contact belong to the company. They
  // are shown read-only and a save sends none of them (the server would
  // drop them anyway); the office alert addresses stay scheduling's own.
  const managed = settings.managedByCompany;
  // Tenancy 2b-1, D6: with alerts installed, who hears about new requests is
  // chosen in Alert settings, the ONE place. The list here is replaced by a
  // link, and a save never sends it (the server drops it too): two places
  // to choose the same people is how a lead gets emailed twice, or never.
  const alertsElsewhere = settings.alertRecipients;
  const addresses = (d: { staffNotifyEmails: string[] }) =>
    alertsElsewhere ? {} : { staffNotifyEmails: d.staffNotifyEmails.map((e) => e.trim()).filter(Boolean) };
  const form = useSettingsDraft(
    initial,
    transport,
    (d) =>
      managed
        ? addresses(d)
        : {
            businessName: d.businessName.trim(),
            timeZone: d.timeZone,
            contactPhone: d.contactPhone.trim() || null,
            contactEmail: d.contactEmail.trim() || null,
            ...addresses(d),
          },
    onSaved,
    () => (tellCustomers && !managed ? { notifyCustomers: true } : {}),
  );
  // Nothing on this card is editable here: the company owns the details and
  // Alert settings owns the people. No Save button for a form with nothing in it.
  const nothingToSave = Boolean(managed && alertsElsewhere);
  const { draft, set, fields } = form;
  const upcoming = status?.upcomingVisits ?? 0;
  const zoneChanging = draft.timeZone !== settings.timeZone;
  const usZone = US_TIME_ZONES.some((z) => z.zone === draft.timeZone);
  const [other, setOther] = useState(!usZone);
  const zones = useMemo(() => allTimeZones(), []);
  const badEmail = alertsElsewhere ? undefined : draft.staffNotifyEmails.find((e) => e.trim() && !isValidEmail(e));
  const problem =
    draft.contactEmail.trim() && !isValidEmail(draft.contactEmail)
      ? "The contact email doesn't look right."
      : badEmail
        ? `"${badEmail}" doesn't look like an email address.`
        : null;

  return (
    <Card id="business" title="Business" hint="Shown to customers on the booking page and in every email.">
      <form className="aisw-stack" onSubmit={(event) => void form.save(event)} noValidate>
        <fieldset disabled={!canManage} className="aisw-stack" style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
          {managed ? (
            <div className="aisw-stack-sm" data-aisw-managed="">
              <p className="aisw-hint">
                These come from your company settings.{" "}
                {managed.href ? <a href={managed.href}>Change them in company settings</a> : null}
              </p>
              <dl className="aisw-facts">
                <div className="aisw-fact">
                  <dt>Business name</dt>
                  <dd>{settings.businessName || "Not set yet"}</dd>
                </div>
                <div className="aisw-fact">
                  <dt>Time zone</dt>
                  <dd>{zoneLabel(settings.timeZone, null)}</dd>
                </div>
                <div className="aisw-fact">
                  <dt>Contact email</dt>
                  <dd>{settings.contactEmail ?? "Not set yet"}</dd>
                </div>
                <div className="aisw-fact">
                  <dt>Contact phone</dt>
                  <dd>{settings.contactPhone ?? "Not set yet"}</dd>
                </div>
              </dl>
            </div>
          ) : null}
          {managed ? null : (
          <>
          <Field id={`${ids}-name`} label="Business name" error={fields.businessName ?? null}>
            <input
              id={`${ids}-name`}
              className="aisw-input"
              value={draft.businessName}
              maxLength={120}
              aria-invalid={fields.businessName ? true : undefined}
              aria-describedby={describedBy(`${ids}-name`, false, fields.businessName)}
              onChange={(event) => set("businessName", event.target.value)}
            />
          </Field>
          <Field
            id={`${ids}-zone`}
            label="Time zone"
            hint="Where your crews work. Every time customers and crews see is in it."
            error={fields.timeZone ?? null}
          >
            <select
              id={`${ids}-zone`}
              className="aisw-input"
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
              <select id={`${ids}-zone-other`} className="aisw-input" value={draft.timeZone} onChange={(event) => set("timeZone", event.target.value)}>
                {zones.includes(draft.timeZone) ? null : <option value={draft.timeZone}>{draft.timeZone.replace(/_/g, " ")}</option>}
                {zones.map((z) => (
                  <option key={z} value={z}>
                    {z.replace(/_/g, " ")}
                  </option>
                ))}
              </select>
            </Field>
          ) : null}
          <p className="aisw-hint">Right now that's {zoneLabel(draft.timeZone, null)}.</p>
          {zoneChanging && upcoming > 0 ? (
            <div className="aisw-stack-sm" data-aisw-zone-warning="">
              <Notice tone="warn">
                {upcoming === 1 ? "You have 1 upcoming visit." : `You have ${upcoming} upcoming visits.`} Each keeps its clock time
                (9:00 AM stays 9:00 AM) in the new time zone, which moves it in real time. Reminders follow.
              </Notice>
              <Check
                checked={tellCustomers}
                onChange={setTellCustomers}
                label={upcoming === 1 ? "Email that customer the corrected time" : "Email those customers the corrected time"}
              />
            </div>
          ) : null}
          <div className="aisw-grid2">
            <Field id={`${ids}-phone`} label="Contact phone" hint="Customers are told to call it inside the change cutoff." error={fields.contactPhone ?? null}>
              <input id={`${ids}-phone`} className="aisw-input" type="tel" value={draft.contactPhone} maxLength={40} onChange={(event) => set("contactPhone", event.target.value)} />
            </Field>
            <Field id={`${ids}-email`} label="Contact email" error={fields.contactEmail ?? null}>
              <input id={`${ids}-email`} className="aisw-input" type="email" value={draft.contactEmail} maxLength={320} onChange={(event) => set("contactEmail", event.target.value)} />
            </Field>
          </div>
          </>
          )}
          {alertsElsewhere ? (
            <div className="aisw-stack-sm" data-aisw-alerts-managed="">
              <p className="aisw-label">New-request alerts</p>
              <p className="aisw-hint">
                Who gets new-request alerts is chosen in Alert settings.{" "}
                {alertsElsewhere.href ? <a href={alertsElsewhere.href}>Open Alert settings</a> : null}
              </p>
            </div>
          ) : (
          <fieldset className="aisw-stack-sm" style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
            <legend className="aisw-label">Send new-request alerts to</legend>
            <p className="aisw-hint">Up to 5 addresses. They also hear when a customer moves or cancels online.</p>
            {/* Empty isn't "nobody" (review T2A-BO-14): with a company, the
                alerts go to its contact email, else its owner. */}
            {managed && draft.staffNotifyEmails.every((e) => !e.trim()) ? (
              <p className="aisw-hint" data-aisw-alerts-default="">
                {settings.contactEmail
                  ? `Leave it empty and alerts go to ${settings.contactEmail}, your company's contact email.`
                  : "Leave it empty and alerts go to your company's owner."}
              </p>
            ) : null}
            {draft.staffNotifyEmails.map((email, index) => (
              <div key={index} className="aisw-row">
                <input
                  className="aisw-input aisw-grow"
                  type="email"
                  aria-label={`Alert email ${index + 1}`}
                  value={email}
                  aria-invalid={fields[`staffNotifyEmails.${index}`] ? true : undefined}
                  onChange={(event) => set("staffNotifyEmails", draft.staffNotifyEmails.map((e, i) => (i === index ? event.target.value : e)))}
                />
                {draft.staffNotifyEmails.length > 1 ? (
                  <button
                    type="button"
                    className="aisw-btn aisw-btn-secondary"
                    aria-label={`Remove alert email ${index + 1}`}
                    onClick={() => set("staffNotifyEmails", draft.staffNotifyEmails.filter((_, i) => i !== index))}
                  >
                    Remove
                  </button>
                ) : null}
              </div>
            ))}
            {draft.staffNotifyEmails.length < 5 ? (
              <div>
                <button type="button" className="aisw-btn aisw-btn-link" onClick={() => set("staffNotifyEmails", [...draft.staffNotifyEmails, ""])}>
                  + Add another
                </button>
              </div>
            ) : null}
            {fields.staffNotifyEmails ? <span className="aisw-field-error">{fields.staffNotifyEmails}</span> : null}
          </fieldset>
          )}
        </fieldset>
        {nothingToSave ? null : (
          <SaveRow dirty={form.dirty} busy={form.busy} saved={form.saved} error={form.error} problem={problem} canManage={canManage} />
        )}
      </form>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Online booking
// ---------------------------------------------------------------------------

const LENGTHS = [15, 30, 45, 60, 75, 90, 105, 120, 150, 180, 210, 240, 300, 360, 420, 480, 540, 600, 660, 720];
const STEPS = [5, 10, 15, 20, 30, 45, 60, 90, 120, 180, 240];

interface ServiceDraft {
  key: string;
  name: string;
  durationMinutes: number;
  description: string;
  requiredSkill: string;
}

function BookingCard({
  settings,
  transport,
  canManage,
  bookingPageUrl,
  onSaved,
}: {
  settings: SettingsWire;
  transport: SchedulingAdminTransport;
  canManage: boolean;
  bookingPageUrl?: string | undefined;
  onSaved: (settings: SettingsWire) => void;
}) {
  const ids = useId();
  const notice = noticeParts(settings.minNoticeMinutes);
  const initial = {
    publicBookingEnabled: settings.publicBookingEnabled,
    autoConfirm: settings.autoConfirm,
    services: settings.services.map((s) => ({
      key: s.key,
      name: s.name,
      durationMinutes: s.durationMinutes,
      description: s.description ?? "",
      requiredSkill: s.requiredSkill ?? "",
    })) as ServiceDraft[],
    noticeAmount: String(notice.amount),
    noticeUnit: notice.unit as "hours" | "days",
    horizonDays: String(settings.horizonDays),
    slotStepMinutes: settings.slotStepMinutes,
    travelBufferMinutes: String(settings.travelBufferMinutes),
    maxOpen: settings.maxOpenRequestsPerRequester === null ? "" : String(settings.maxOpenRequestsPerRequester),
    requireAddress: settings.requireAddress,
  };
  const form = useSettingsDraft(
    initial,
    transport,
    (d) => ({
      publicBookingEnabled: d.publicBookingEnabled,
      autoConfirm: d.autoConfirm,
      services: d.services.map(
        (s): ServiceWire => ({
          key: s.key,
          name: s.name.trim(),
          durationMinutes: s.durationMinutes,
          description: s.description.trim() || null,
          requiredSkill: s.requiredSkill.trim() || null,
        }),
      ),
      minNoticeMinutes: noticeMinutes(numberOr(d.noticeAmount, 0), d.noticeUnit),
      horizonDays: numberOr(d.horizonDays, settings.horizonDays),
      slotStepMinutes: d.slotStepMinutes,
      travelBufferMinutes: numberOr(d.travelBufferMinutes, settings.travelBufferMinutes),
      maxOpenRequestsPerRequester: d.maxOpen.trim() === "" ? null : numberOr(d.maxOpen, 3),
      requireAddress: d.requireAddress,
    }),
    onSaved,
  );
  const { draft, set, fields } = form;
  const services = draft.services;
  const setServices = (next: ServiceDraft[]) => set("services", next);
  const problem =
    services.length === 0
      ? "Offer at least one service."
      : services.some((s) => !s.name.trim())
        ? "Every service needs a name."
        : null;

  return (
    <Card id="booking" title="Online booking" hint="What customers can book on your booking page, and how far ahead.">
      <form className="aisw-stack" onSubmit={(event) => void form.save(event)} noValidate>
        <fieldset disabled={!canManage} className="aisw-stack" style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
          <Switch
            checked={draft.publicBookingEnabled}
            onChange={(v) => set("publicBookingEnabled", v)}
            label="Take bookings online"
            hint="Off: the booking page says online booking is closed and gives your phone number."
            disabled={!canManage}
          />
          <Switch
            checked={draft.autoConfirm}
            onChange={(v) => set("autoConfirm", v)}
            label="Confirm requests automatically"
            hint="On: requests go straight onto the calendar. Off: you accept each one."
            disabled={!canManage}
          />

          <fieldset className="aisw-stack-sm" style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }} data-aisw-services="">
            <legend className="aisw-label">Services</legend>
            <p className="aisw-hint">What a customer picks. The length sets how long the visit holds on the calendar.</p>
            {services.map((service, index) => {
              const prefix = `services.${index}`;
              const update = (patch: Partial<ServiceDraft>) => setServices(services.map((s, i) => (i === index ? { ...s, ...patch } : s)));
              const move = (delta: number) => {
                const next = [...services];
                const [item] = next.splice(index, 1);
                next.splice(index + delta, 0, item!);
                setServices(next);
              };
              const lengths = LENGTHS.includes(service.durationMinutes) ? LENGTHS : [...LENGTHS, service.durationMinutes].sort((a, b) => a - b);
              return (
                <div key={service.key} className="aisw-service-row" data-service-row={service.key}>
                  <div className="aisw-grid2">
                    <Field id={`${ids}-svc-${index}-name`} label="Name" error={fields[`${prefix}.name`] ?? null}>
                      <input
                        id={`${ids}-svc-${index}-name`}
                        className="aisw-input"
                        value={service.name}
                        maxLength={80}
                        aria-invalid={fields[`${prefix}.name`] ? true : undefined}
                        aria-describedby={describedBy(`${ids}-svc-${index}-name`, false, fields[`${prefix}.name`])}
                        onChange={(event) => update({ name: event.target.value })}
                      />
                    </Field>
                    <Field id={`${ids}-svc-${index}-len`} label="Length" error={fields[`${prefix}.durationMinutes`] ?? null}>
                      <select
                        id={`${ids}-svc-${index}-len`}
                        className="aisw-input"
                        value={service.durationMinutes}
                        onChange={(event) => update({ durationMinutes: Number(event.target.value) })}
                      >
                        {lengths.map((m) => (
                          <option key={m} value={m}>
                            {formatDuration(m)}
                          </option>
                        ))}
                      </select>
                    </Field>
                  </div>
                  <Field id={`${ids}-svc-${index}-desc`} label="Description" optional error={fields[`${prefix}.description`] ?? null}>
                    <input
                      id={`${ids}-svc-${index}-desc`}
                      className="aisw-input"
                      value={service.description}
                      maxLength={300}
                      onChange={(event) => update({ description: event.target.value })}
                    />
                  </Field>
                  <Field
                    id={`${ids}-svc-${index}-skill`}
                    label="Only crews with this skill"
                    optional
                    hint="Leave empty for any crew. A crew with no skills listed can do everything."
                    error={fields[`${prefix}.requiredSkill`] ?? null}
                  >
                    <input
                      id={`${ids}-svc-${index}-skill`}
                      className="aisw-input"
                      value={service.requiredSkill}
                      maxLength={60}
                      aria-describedby={`${ids}-svc-${index}-skill-hint`}
                      onChange={(event) => update({ requiredSkill: event.target.value })}
                    />
                  </Field>
                  <div className="aisw-row">
                    {/* Not "Booking-page key: mowing" (BO-09): a link the owner can paste, or nothing. */}
                    <span className="aisw-hint aisw-grow" data-aisw-service-link="">
                      {bookingPageUrl ? `Link straight to it: ${bookingPageUrl}?service=${service.key}` : ""}
                    </span>
                    <button type="button" className="aisw-btn aisw-btn-secondary aisw-btn-sm" disabled={index === 0} onClick={() => move(-1)} aria-label={`Move ${service.name || "service"} up`}>
                      Up
                    </button>
                    <button
                      type="button"
                      className="aisw-btn aisw-btn-secondary aisw-btn-sm"
                      disabled={index === services.length - 1}
                      onClick={() => move(1)}
                      aria-label={`Move ${service.name || "service"} down`}
                    >
                      Down
                    </button>
                    <button
                      type="button"
                      className="aisw-btn aisw-btn-danger-outline aisw-btn-sm"
                      disabled={services.length === 1}
                      onClick={() => setServices(services.filter((_, i) => i !== index))}
                      aria-label={`Remove ${service.name || "service"}`}
                    >
                      Remove
                    </button>
                  </div>
                </div>
              );
            })}
            {services.length < 20 ? (
              <div>
                <button
                  type="button"
                  className="aisw-btn aisw-btn-secondary"
                  onClick={() =>
                    setServices([
                      ...services,
                      { key: serviceKeyFrom("New service", services.map((s) => s.key)), name: "", durationMinutes: 60, description: "", requiredSkill: "" },
                    ])
                  }
                >
                  + Add a service
                </button>
              </div>
            ) : null}
            {fields.services && !Object.keys(fields).some((k) => k.startsWith("services.")) ? <span className="aisw-field-error">{fields.services}</span> : null}
          </fieldset>

          <div className="aisw-grid2">
            <Field id={`${ids}-notice`} label="Notice needed" hint="How soon a customer can book. 1 day means nothing before this time tomorrow." error={fields.minNoticeMinutes ?? null}>
              <div className="aisw-inline-fields">
                <input
                  id={`${ids}-notice`}
                  className="aisw-input aisw-number"
                  type="number"
                  min={0}
                  step="any"
                  inputMode="decimal"
                  value={draft.noticeAmount}
                  aria-describedby={describedBy(`${ids}-notice`, true, fields.minNoticeMinutes)}
                  onChange={(event) => set("noticeAmount", event.target.value)}
                />
                <select className="aisw-input" aria-label="Notice unit" value={draft.noticeUnit} onChange={(event) => set("noticeUnit", event.target.value as "hours" | "days")}>
                  <option value="hours">hours</option>
                  <option value="days">days</option>
                </select>
              </div>
            </Field>
            <Field id={`${ids}-horizon`} label="How far ahead (days)" hint="The latest a customer can book." error={fields.horizonDays ?? null}>
              <input
                id={`${ids}-horizon`}
                className="aisw-input aisw-number"
                type="number"
                min={1}
                max={365}
                inputMode="numeric"
                value={draft.horizonDays}
                aria-describedby={describedBy(`${ids}-horizon`, true, fields.horizonDays)}
                onChange={(event) => set("horizonDays", event.target.value)}
              />
            </Field>
            <Field id={`${ids}-step`} label="Start times every" hint="9:00, 9:30, 10:00… with 30 minutes." error={fields.slotStepMinutes ?? null}>
              <select id={`${ids}-step`} className="aisw-input" value={draft.slotStepMinutes} onChange={(event) => set("slotStepMinutes", Number(event.target.value))}>
                {(STEPS.includes(draft.slotStepMinutes) ? STEPS : [...STEPS, draft.slotStepMinutes].sort((a, b) => a - b)).map((m) => (
                  <option key={m} value={m}>
                    {formatDuration(m)}
                  </option>
                ))}
              </select>
            </Field>
            <Field id={`${ids}-buffer`} label="Travel time kept free (minutes)" hint="Kept clear around every booked visit on the booking page." error={fields.travelBufferMinutes ?? null}>
              <input
                id={`${ids}-buffer`}
                className="aisw-input aisw-number"
                type="number"
                min={0}
                max={240}
                inputMode="numeric"
                value={draft.travelBufferMinutes}
                onChange={(event) => set("travelBufferMinutes", event.target.value)}
              />
            </Field>
            <Field
              id={`${ids}-maxopen`}
              label="Most requests one person can have waiting"
              hint="Stops one person filling your calendar with requests. Empty: no limit."
              error={fields.maxOpenRequestsPerRequester ?? null}
            >
              <input
                id={`${ids}-maxopen`}
                className="aisw-input aisw-number"
                type="number"
                min={1}
                max={50}
                inputMode="numeric"
                value={draft.maxOpen}
                onChange={(event) => set("maxOpen", event.target.value)}
              />
            </Field>
          </div>
          <Switch
            checked={draft.requireAddress}
            onChange={(v) => set("requireAddress", v)}
            label="Address required"
            hint="On: customers must give the address of the visit."
            disabled={!canManage}
          />
        </fieldset>
        <SaveRow dirty={form.dirty} busy={form.busy} saved={form.saved} error={form.error} problem={problem} canManage={canManage} />
      </form>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Customer messages
// ---------------------------------------------------------------------------

function MessagesCard({
  settings,
  transport,
  canManage,
  status,
  onSaved,
}: {
  settings: SettingsWire;
  transport: SchedulingAdminTransport;
  canManage: boolean;
  status: AdminStatus | null;
  onSaved: (settings: SettingsWire) => void;
}) {
  const ids = useId();
  const form = useSettingsDraft(
    {
      pendingExpiryHours: String(settings.pendingExpiryHours),
      reminderLeadHours: String(settings.reminderLeadHours),
      cancelCutoffHours: String(settings.cancelCutoffHours),
    },
    transport,
    (d) => ({
      pendingExpiryHours: numberOr(d.pendingExpiryHours, settings.pendingExpiryHours),
      reminderLeadHours: numberOr(d.reminderLeadHours, settings.reminderLeadHours),
      cancelCutoffHours: numberOr(d.cancelCutoffHours, settings.cancelCutoffHours),
    }),
    onSaved,
  );
  const { draft, set, fields } = form;
  const number = (key: keyof typeof draft, label: string, hint: string, min: number, max: number) => (
    <Field id={`${ids}-${key}`} label={label} hint={hint} error={fields[key] ?? null}>
      <input
        id={`${ids}-${key}`}
        className="aisw-input aisw-number"
        type="number"
        min={min}
        max={max}
        inputMode="numeric"
        value={draft[key]}
        aria-invalid={fields[key] ? true : undefined}
        aria-describedby={describedBy(`${ids}-${key}`, true, fields[key])}
        onChange={(event) => set(key, event.target.value)}
      />
    </Field>
  );
  return (
    <Card id="messages" title="Customer messages" hint="When customers hear from you, and how late they can change a visit themselves.">
      <form className="aisw-stack" onSubmit={(event) => void form.save(event)} noValidate>
        <fieldset disabled={!canManage} className="aisw-stack" style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
          {number(
            "pendingExpiryHours",
            "Release unanswered requests after (hours)",
            "If nobody accepts or declines a request in this time, its slot opens up again and the customer is told.",
            1,
            720,
          )}
          {number("reminderLeadHours", "Send a reminder this many hours before (0 = off)", "One email reminder before each confirmed visit.", 0, 168)}
          {status
            ? (status.notices.filter((n) => n.code === "reminders_daily" || n.code === "reminders_off" || n.code === "emails_off")).map((n) => (
                <p key={n.code} className="aisw-hint" data-aisw-reminder-note={n.code}>
                  {n.message}
                </p>
              ))
            : null}
          {number(
            "cancelCutoffHours",
            "Customers can change or cancel online until (hours before)",
            "Inside this time they're asked to call you instead, so your crew's day doesn't change at the last minute.",
            0,
            168,
          )}
        </fieldset>
        <SaveRow dirty={form.dirty} busy={form.busy} saved={form.saved} error={form.error} canManage={canManage} />
      </form>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Crews
// ---------------------------------------------------------------------------

interface CrewDraft {
  name: string;
  homeBaseAddress: string;
  workStartTime: string;
  workEndTime: string;
  maxJobsPerDay: string;
  skills: string;
  userId: string;
}

/** "Casey Crew (casey@acme.test)" — how a person reads in the crew's login picker. */
function personLabel(person: PersonOption): string {
  if (person.name && person.email) return `${person.name} (${person.email})`;
  return person.name ?? person.email ?? "Someone without a name";
}

function crewDraft(resource?: AdminResource): CrewDraft {
  return {
    name: resource?.name ?? "",
    homeBaseAddress: resource?.homeBaseAddress ?? "",
    workStartTime: resource?.workStartTime ?? "08:00",
    workEndTime: resource?.workEndTime ?? "17:00",
    maxJobsPerDay: String(resource?.maxJobsPerDay ?? 6),
    skills: resource?.skills.join(", ") ?? "",
    userId: resource?.userId ?? "",
  };
}

function crewInput(draft: CrewDraft): ResourceInput {
  return {
    name: draft.name.trim(),
    homeBaseAddress: draft.homeBaseAddress.trim() || null,
    workStartTime: draft.workStartTime,
    workEndTime: draft.workEndTime,
    maxJobsPerDay: numberOr(draft.maxJobsPerDay, 6),
    skills: draft.skills
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    userId: draft.userId.trim() || null,
  };
}

function CrewForm({
  initial,
  submitLabel,
  canManage,
  locale,
  people,
  signInUrl,
  inviteHref,
  onSubmit,
  onCancel,
}: {
  initial: CrewDraft;
  submitLabel: string;
  canManage: boolean;
  locale: string;
  /** Who can be picked to open this crew's route; null: type the login instead; undefined: still loading. */
  people: PersonOption[] | null | undefined;
  signInUrl?: string | undefined;
  inviteHref?: string | null | undefined;
  onSubmit: (input: ResourceInput) => Promise<ClientError | null>;
  onCancel?: () => void;
}) {
  const ids = useId();
  const [draft, setDraft] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ClientError | null>(null);
  const [saved, setSaved] = useState(false);
  const fields = issuesByField(error);
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial);
  const set = (key: keyof CrewDraft, value: string) => {
    setDraft((current) => ({ ...current, [key]: value }));
    setSaved(false);
  };
  const problem = !draft.name.trim() ? "Give the crew a name." : draft.workEndTime <= draft.workStartTime ? "The day has to end after it starts." : null;
  return (
    <form
      className="aisw-stack"
      noValidate
      data-aisw-crew-form=""
      onSubmit={async (event) => {
        event.preventDefault();
        if (problem || busy) return;
        setBusy(true);
        setError(null);
        const failure = await onSubmit(crewInput(draft));
        setBusy(false);
        setError(failure);
        if (!failure) setSaved(true);
      }}
    >
      <fieldset disabled={!canManage} className="aisw-stack" style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
        <div className="aisw-grid2">
          <Field id={`${ids}-name`} label="Crew name" error={fields.name ?? null}>
            <input id={`${ids}-name`} className="aisw-input" value={draft.name} maxLength={120} onChange={(event) => set("name", event.target.value)} />
          </Field>
          <Field id={`${ids}-max`} label="Most visits a day" error={fields.maxJobsPerDay ?? null}>
            <input
              id={`${ids}-max`}
              className="aisw-input aisw-number"
              type="number"
              min={1}
              max={50}
              inputMode="numeric"
              value={draft.maxJobsPerDay}
              onChange={(event) => set("maxJobsPerDay", event.target.value)}
            />
          </Field>
        </div>
        <Field id={`${ids}-base`} label="Home base address" optional hint="Where the crew starts the day. Used for the first drive." error={fields.homeBaseAddress ?? null}>
          <input id={`${ids}-base`} className="aisw-input" value={draft.homeBaseAddress} maxLength={500} onChange={(event) => set("homeBaseAddress", event.target.value)} />
        </Field>
        <div className="aisw-grid2">
          <Field id={`${ids}-start`} label="Usual start" hint="Used Monday to Friday until you set this crew's hours below." error={fields.workStartTime ?? null}>
            <select id={`${ids}-start`} className="aisw-input" value={draft.workStartTime} onChange={(event) => set("workStartTime", event.target.value)}>
              {QUARTER_HOURS.slice(0, -1).map((t) => (
                <option key={t} value={t}>
                  {formatClock(t, locale)}
                </option>
              ))}
            </select>
          </Field>
          <Field id={`${ids}-end`} label="Usual finish" error={fields.workEndTime ?? null}>
            <select id={`${ids}-end`} className="aisw-input" value={draft.workEndTime} onChange={(event) => set("workEndTime", event.target.value)}>
              {QUARTER_HOURS.slice(1).map((t) => (
                <option key={t} value={t}>
                  {formatClock(t, locale)}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <Field id={`${ids}-skills`} label="Skills" optional hint="Comma-separated, like: windows, gutters. Services that need a skill only go to crews that have it." error={fields.skills ?? null}>
          <input id={`${ids}-skills`} className="aisw-input" value={draft.skills} onChange={(event) => set("skills", event.target.value)} />
        </Field>
        {people ? (
          // BO-02: a person, not an internal id. Picking someone is also what
          // lets them in: the host gives them the crew's route and nothing else.
          <Field
            id={`${ids}-user`}
            label="Who opens this crew's route"
            optional
            hint={
              inviteHref ? (
                <>
                  Picking someone lets them open Today's route on their phone with their own sign-in — their stops only. Not listed?{" "}
                  <a href={inviteHref}>Invite them on the Team page.</a>
                </>
              ) : (
                `Picking someone lets them open Today's route on their phone with their own sign-in — their stops only. Not in the list? Ask them to sign in once${signInUrl ? ` at ${signInUrl}` : ""}, then pick them here.`
              )
            }
            error={fields.userId ?? null}
          >
            <select id={`${ids}-user`} className="aisw-input" value={draft.userId} onChange={(event) => set("userId", event.target.value)}>
              <option value="">Nobody yet</option>
              {draft.userId && !people.some((p) => p.userId === draft.userId) ? <option value={draft.userId}>Someone not in the list</option> : null}
              {people.map((person) => (
                <option key={person.userId} value={person.userId}>
                  {personLabel(person)}
                </option>
              ))}
            </select>
          </Field>
        ) : people === null ? (
          <Field
            id={`${ids}-user`}
            label="Their login (for their own route)"
            optional
            hint="The id your app knows them by, so Today's route opens on their crew."
            error={fields.userId ?? null}
          >
            <input id={`${ids}-user`} className="aisw-input" value={draft.userId} maxLength={200} autoComplete="off" onChange={(event) => set("userId", event.target.value)} />
          </Field>
        ) : null}
      </fieldset>
      {canManage ? (
        <div className="aisw-row">
          <button type="submit" className="aisw-btn aisw-btn-primary" disabled={busy || Boolean(problem) || (!dirty && submitLabel !== "Add crew")} aria-busy={busy || undefined}>
            {busy ? "Saving…" : submitLabel}
          </button>
          {onCancel ? (
            <button type="button" className="aisw-btn aisw-btn-secondary" onClick={onCancel}>
              Close
            </button>
          ) : null}
          {dirty && !saved ? <span className="aisw-dirty">Unsaved changes</span> : null}
          <Outcome ok={saved && !dirty ? "Saved" : null} error={problem && dirty ? problem : error ? errorSummary(error) : null} />
        </div>
      ) : null}
    </form>
  );
}

function CrewsCard({
  resources,
  transport,
  canManage,
  locale,
  people,
  signInUrl,
  inviteHref,
  onChanged,
}: {
  resources: AdminResource[];
  transport: SchedulingAdminTransport;
  canManage: boolean;
  locale: string;
  people: PersonOption[] | null | undefined;
  signInUrl?: string | undefined;
  inviteHref?: string | null | undefined;
  onChanged: (resource: AdminResource) => void;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [rowError, setRowError] = useState<Record<string, string>>({});
  const active = resources.filter((r) => r.isActive);
  const removed = resources.filter((r) => !r.isActive);

  const act = async (id: string, call: () => ReturnType<SchedulingAdminTransport["deactivateResource"]>) => {
    setBusy(id);
    setRowError((current) => ({ ...current, [id]: "" }));
    const res = await call();
    setBusy(null);
    if (res.ok) onChanged(res.data.resource);
    else setRowError((current) => ({ ...current, [id]: adminErrorText(res.error) }));
  };

  return (
    <Card id="crews" title="Crews" hint="The people or vans that go out to jobs. Each gets its own column on the calendar.">
      {active.length === 0 ? <p className="aisw-hint">No crews yet. Add the first one below.</p> : null}
      <ul className="aisw-list-rows" data-aisw-crews="">
        {active.map((r) => (
          <li key={r.id} className="aisw-stack-sm" style={{ border: "1px solid var(--aisw-line)", borderRadius: "var(--aisw-radius-sm)", padding: 12 }} data-crew={r.id}>
            <div className="aisw-row">
              <strong className="aisw-grow">{r.name}</strong>
              {!r.acceptsPublicBookings ? <span className="aisw-tag aisw-tag-muted">Online booking paused</span> : null}
              {canManage ? (
                <button type="button" className="aisw-btn aisw-btn-secondary aisw-btn-sm" aria-expanded={editing === r.id} onClick={() => setEditing(editing === r.id ? null : r.id)}>
                  {editing === r.id ? "Close" : "Edit"}
                </button>
              ) : null}
            </div>
            <span className="aisw-hint">
              {r.homeBaseAddress ?? "No home base"} · up to {r.maxJobsPerDay} visits a day{r.skills.length > 0 ? ` · ${r.skills.join(", ")}` : ""}
            </span>
            <Switch
              checked={r.acceptsPublicBookings}
              onChange={(next) => void act(r.id, () => transport.updateResource(r.id, { acceptsPublicBookings: next }))}
              label="Takes online bookings"
              hint="Off: customers can't book this crew online. Staff still can."
              disabled={!canManage || busy === r.id}
            />
            {editing === r.id ? (
              <>
                <CrewForm
                  initial={crewDraft(r)}
                  submitLabel="Save crew"
                  canManage={canManage}
                  locale={locale}
                  people={people}
                  signInUrl={signInUrl}
                  inviteHref={inviteHref}
                  onCancel={() => setEditing(null)}
                  onSubmit={async (input) => {
                    const res = await transport.updateResource(r.id, input);
                    if (!res.ok) return res.error;
                    onChanged(res.data.resource);
                    return null;
                  }}
                />
                <div>
                  <button
                    type="button"
                    className="aisw-btn aisw-btn-danger-outline"
                    disabled={busy === r.id}
                    onClick={() => void act(r.id, () => transport.deactivateResource(r.id))}
                  >
                    Remove crew
                  </button>
                  <p className="aisw-hint">Their visits stay on the calendar; move them to another crew.</p>
                </div>
              </>
            ) : null}
            {rowError[r.id] ? (
              <p className="aisw-danger-text" role="alert">
                {rowError[r.id]}
              </p>
            ) : null}
          </li>
        ))}
      </ul>
      {canManage ? (
        adding ? (
          <div className="aisw-panel-box">
            <strong>New crew</strong>
            <CrewForm
              initial={crewDraft()}
              submitLabel="Add crew"
              canManage={canManage}
              locale={locale}
              people={people}
              signInUrl={signInUrl}
                  inviteHref={inviteHref}
              onCancel={() => setAdding(false)}
              onSubmit={async (input) => {
                const res = await transport.createResource(input);
                if (!res.ok) return res.error;
                onChanged(res.data.resource);
                setAdding(false);
                return null;
              }}
            />
          </div>
        ) : (
          <div>
            <button type="button" className="aisw-btn aisw-btn-secondary" onClick={() => setAdding(true)}>
              + Add a crew
            </button>
          </div>
        )
      ) : null}
      {removed.length > 0 ? (
        <details data-aisw-removed="">
          <summary>Removed crews ({removed.length})</summary>
          <ul className="aisw-list-rows">
            {removed.map((r) => (
              <li key={r.id} className="aisw-list-row" data-crew={r.id}>
                <span className="aisw-grow">{r.name}</span>
                {canManage ? (
                  <button type="button" className="aisw-btn aisw-btn-secondary aisw-btn-sm" disabled={busy === r.id} onClick={() => void act(r.id, () => transport.reactivateResource(r.id))}>
                    Restore
                  </button>
                ) : null}
                {rowError[r.id] ? (
                  <span className="aisw-danger-text" role="alert">
                    {rowError[r.id]}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Hours
// ---------------------------------------------------------------------------

function HoursCard({
  resources,
  transport,
  canManage,
  timeZone,
  locale,
}: {
  resources: AdminResource[];
  transport: SchedulingAdminTransport;
  canManage: boolean;
  timeZone: string;
  locale: string;
}) {
  const ids = useId();
  const [crewId, setCrewId] = useState(resources[0]?.id ?? "");
  const [availability, setAvailability] = useState<AvailabilityResponse | null>(null);
  const [error, setError] = useState<ClientError | null>(null);
  const crew = resources.find((r) => r.id === crewId) ?? resources[0] ?? null;

  useEffect(() => {
    if (!crew) return;
    let alive = true;
    setAvailability(null);
    setError(null);
    void transport.getAvailability(crew.id).then((res) => {
      if (!alive) return;
      if (res.ok) setAvailability(res.data);
      else setError(res.error);
    });
    return () => {
      alive = false;
    };
  }, [transport, crew?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <Card id="hours" title="Hours" hint={`When each crew works, in ${zoneLabel(timeZone, null, locale)}. Customers can only book inside these hours.`}>
      {resources.length === 0 ? (
        <p className="aisw-hint">Add a crew first.</p>
      ) : (
        <>
          {resources.length > 1 ? (
            <Field id={`${ids}-crew`} label="Crew">
              <select id={`${ids}-crew`} className="aisw-input" value={crew?.id ?? ""} onChange={(event) => setCrewId(event.target.value)}>
                {resources.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </select>
            </Field>
          ) : null}
          {error ? <Notice tone="error">{adminErrorText(error)}</Notice> : null}
          {!availability && !error ? <Loading label="Loading hours…" /> : null}
          {availability && crew ? (
            <>
              <WeeklyEditor
                key={crew.id}
                availability={availability}
                transport={transport}
                canManage={canManage}
                locale={locale}
                onSaved={setAvailability}
              />
              <TimeOffEditor
                key={`${crew.id}-off`}
                crewId={crew.id}
                availability={availability}
                transport={transport}
                canManage={canManage}
                timeZone={timeZone}
                locale={locale}
                onChanged={setAvailability}
              />
            </>
          ) : null}
        </>
      )}
    </Card>
  );
}

/**
 * Seven rows, Monday first; each row holds one or more blocks of hours, with
 * "+ Add hours" for a split shift. It starts from the crew's saved week, or —
 * for a crew whose hours were never saved — from what applies to it today
 * (`effectiveWeekly`), never from hours the crew doesn't have (SB-17). It
 * saves the week only, so days off survive.
 */
export function WeeklyEditor({
  availability,
  transport,
  canManage,
  locale,
  onSaved,
}: {
  availability: AvailabilityResponse;
  transport: SchedulingAdminTransport;
  canManage: boolean;
  locale: string;
  onSaved: (next: AvailabilityResponse) => void;
}) {
  const source = availability.weekly.length > 0 ? availability.weekly : availability.effectiveWeekly;
  const initial = useMemo(() => weekFromWindows(source), [source]);
  const [days, setDays] = useState<EditWindow[][]>(initial);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<ClientError | null>(null);
  const dirty = JSON.stringify(days) !== JSON.stringify(initial);
  const problem = weekProblem(days);

  const update = (day: number, next: EditWindow[]) => {
    setDays(days.map((windows, i) => (i === day ? next : windows)));
    setSaved(false);
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (problem || busy) return;
    setBusy(true);
    setError(null);
    const res = await transport.setWeekly(availability.resourceId, { weekly: windowsFromWeek(days) });
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    // The saved week becomes the new starting point (the parent hands the
    // same rows back as `availability`), so "unsaved" clears and "Saved" shows.
    setDays(weekFromWindows(res.data.weekly.length > 0 ? res.data.weekly : res.data.effectiveWeekly));
    setSaved(true);
    onSaved(res.data);
  };

  return (
    <form className="aisw-stack" onSubmit={(event) => void save(event)} noValidate data-aisw-week="">
      <h4 className="aisw-h3">The week</h4>
      {!availability.hoursConfigured ? (
        <p className="aisw-hint">These are the hours this crew has now (its usual hours, Monday to Friday). Save to make them its own.</p>
      ) : null}
      <div>
        {WEEK_ORDER.map((day) => {
          const name = WEEKDAYS[day]!;
          const windows = days[day] ?? [];
          return (
            <div key={day} className="aisw-week-row" data-day={day}>
              <span className="aisw-week-day">{name}</span>
              <div className="aisw-week-windows">
                {windows.length === 0 ? <span className="aisw-hint" style={{ paddingTop: 11 }}>Off</span> : null}
                {windows.map((window, i) => (
                  <div key={i} className="aisw-inline-fields">
                    <select
                      className="aisw-input"
                      aria-label={`${name} block ${i + 1} starts`}
                      value={window.start}
                      disabled={!canManage}
                      onChange={(event) => update(day, windows.map((w, j) => (j === i ? { ...w, start: event.target.value } : w)))}
                    >
                      {QUARTER_HOURS.slice(0, -1).map((t) => (
                        <option key={t} value={t}>
                          {formatClock(t, locale)}
                        </option>
                      ))}
                    </select>
                    <span className="aisw-hint">to</span>
                    <select
                      className="aisw-input"
                      aria-label={`${name} block ${i + 1} ends`}
                      value={window.end}
                      disabled={!canManage}
                      onChange={(event) => update(day, windows.map((w, j) => (j === i ? { ...w, end: event.target.value } : w)))}
                    >
                      {QUARTER_HOURS.slice(1).map((t) => (
                        <option key={t} value={t}>
                          {formatClock(t, locale)}
                        </option>
                      ))}
                    </select>
                    {canManage ? (
                      <button
                        type="button"
                        className="aisw-btn aisw-btn-secondary aisw-btn-sm"
                        aria-label={`Remove ${name} block ${i + 1}`}
                        onClick={() => update(day, windows.filter((_, j) => j !== i))}
                      >
                        Remove
                      </button>
                    ) : null}
                  </div>
                ))}
                {canManage ? (
                  <div>
                    <button type="button" className="aisw-btn aisw-btn-link" aria-label={`Add hours on ${name}`} onClick={() => update(day, [...windows, nextWindow(windows)])}>
                      + Add hours
                    </button>
                  </div>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
      {/* BO-15: a crew whose hours were never saved isn't "unsaved changes" —
          nobody changed anything. It can be saved as it is, and says so. */}
      <SaveRow
        dirty={dirty}
        canSave={dirty || !availability.hoursConfigured}
        pendingNote={!availability.hoursConfigured ? "Using the crew's usual hours — save to keep them." : null}
        busy={busy}
        saved={saved}
        error={error}
        problem={problem}
        label="Save the week"
        canManage={canManage}
      />
    </form>
  );
}

function TimeOffEditor({
  crewId,
  availability,
  transport,
  canManage,
  timeZone,
  locale,
  onChanged,
}: {
  crewId: string;
  availability: AvailabilityResponse;
  transport: SchedulingAdminTransport;
  canManage: boolean;
  timeZone: string;
  locale: string;
  onChanged: (next: AvailabilityResponse) => void;
}) {
  const ids = useId();
  const today = todayIn(timeZone);
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ClientError | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [added, setAdded] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const ranges = groupTimeOff(availability.timeOff);
  const end = to || from;
  const local = !isDate(from) ? "Pick the first day off." : !isDate(end) ? "Pick the last day off, or leave it empty for one day." : end < from ? "The last day has to be on or after the first." : null;

  const add = async (event: FormEvent) => {
    event.preventDefault();
    if (local || busy) return;
    setBusy(true);
    setError(null);
    setWarning(null);
    setAdded(null);
    const res = await transport.addTimeOff(crewId, { from, to: end, ...(note.trim() ? { note: note.trim().slice(0, 200) } : {}) });
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    const { visitsOnThoseDays, ...next } = res.data;
    onChanged(next);
    setAdded(`Added ${formatDateRange(from, end, locale)}.`);
    setWarning(strandedVisitsWarning(visitsOnThoseDays.length));
    setNote("");
    setTo("");
  };

  const remove = async (rangeIds: readonly string[], key: string) => {
    setRemoving(key);
    setError(null);
    let latest: AvailabilityResponse | null = null;
    for (const id of rangeIds) {
      const res = await transport.removeTimeOff(crewId, id);
      if (!res.ok) {
        setError(res.error);
        break;
      }
      latest = res.data;
    }
    setRemoving(null);
    if (latest) onChanged(latest);
  };

  return (
    <div className="aisw-stack" data-aisw-time-off="">
      <h4 className="aisw-h3">Days off</h4>
      {canManage ? (
        <form className="aisw-stack-sm" onSubmit={(event) => void add(event)} noValidate>
          <div className="aisw-grid2">
            <Field id={`${ids}-from`} label="First day off" error={issuesByField(error).from ?? null}>
              <input id={`${ids}-from`} className="aisw-input" type="date" value={from} min={today} onChange={(event) => setFrom(event.target.value)} />
            </Field>
            <Field id={`${ids}-to`} label="Last day off" optional hint="Leave empty for one day. Up to 62 days at a time." error={issuesByField(error).to ?? null}>
              <input
                id={`${ids}-to`}
                className="aisw-input"
                type="date"
                value={to}
                min={from}
                aria-describedby={`${ids}-to-hint`}
                onChange={(event) => setTo(event.target.value)}
              />
            </Field>
          </div>
          <Field id={`${ids}-note`} label="Note" optional>
            <input id={`${ids}-note`} className="aisw-input" value={note} maxLength={200} placeholder="Vacation, training…" onChange={(event) => setNote(event.target.value)} />
          </Field>
          <div className="aisw-row">
            <button type="submit" className="aisw-btn aisw-btn-primary" disabled={busy || local !== null} aria-busy={busy || undefined}>
              {busy ? "Adding…" : "Add days off"}
            </button>
            <Outcome ok={added} error={local && (to || from !== today) ? local : error ? adminErrorText(error) : null} />
          </div>
          {warning ? <Notice tone="warn">{warning}</Notice> : null}
        </form>
      ) : null}
      {ranges.length === 0 ? (
        <p className="aisw-hint">No days off coming up.</p>
      ) : (
        <ul className="aisw-list-rows">
          {ranges.map((range) => {
            const key = range.ids.join("|");
            return (
              <li key={key} className="aisw-list-row" data-time-off={range.from}>
                <span className="aisw-grow">
                  {formatDateRange(range.from, range.to, locale)}
                  {range.days > 1 ? ` · ${range.days} days` : ""}
                  {range.note ? ` · ${range.note}` : ""}
                </span>
                {canManage ? (
                  <button type="button" className="aisw-btn aisw-btn-secondary aisw-btn-sm" disabled={removing !== null} onClick={() => void remove(range.ids, key)}>
                    {removing === key ? "Removing…" : "Remove"}
                  </button>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      {availability.specialHours.length > 0 ? (
        <>
          <h4 className="aisw-h3">Special hours</h4>
          <ul className="aisw-list-rows">
            {availability.specialHours.map((s) => (
              <li key={s.id} className="aisw-list-row">
                {formatDateRange(s.date, s.date, locale)} · {formatTimeRange(s.startTime, s.endTime, locale)}
                {s.note ? ` · ${s.note}` : ""}
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}
