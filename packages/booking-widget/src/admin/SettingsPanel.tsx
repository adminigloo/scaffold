import { useId, useState } from "react";
import { CopyField, Notice } from "../parts.js";
import { browserTimeZone } from "../time.js";
import type { Medium } from "../types.js";
import { formatStamp, timeZoneOptions, typeIsForHost } from "./helpers.js";
import type { AdminBookingType, AdminHost, BookingAdminAdapter, BookingTypeInput } from "./types.js";
import { Card, FormField, Outcome, useAction } from "./ui.js";

/**
 * Who takes the calls and how: the host's details, the real calendar that
 * keeps the booking page honest, the feed that puts calls into that
 * calendar, and the call types themselves.
 *
 * The two calendar links run in OPPOSITE directions and the page keeps them
 * apart on purpose. The secret iCal address is read FROM the host's
 * calendar, so nobody is offered a time they are already busy; the feed
 * link is read BY their calendar, so booked calls show up there. Both are
 * secrets: the first is stored and only ever shown masked; the second is
 * shown once, the moment it is minted, and only its hash is kept.
 */
export function SettingsPanel({
  adapter,
  host,
  hostCount,
  types,
  locale,
  onChanged,
}: {
  adapter: BookingAdminAdapter;
  host: AdminHost;
  /** With several hosts, a new type is for this host only; with one, for every host (so a second host gets it too). */
  hostCount: number;
  types: readonly AdminBookingType[];
  locale: string;
  onChanged: () => void;
}) {
  const mine = types.filter((type) => typeIsForHost(type, host.id));
  const [adding, setAdding] = useState(mine.length === 0);
  return (
    <div className="aibk-stack">
      <HostCard key={`${host.id}:${String(host.updatedAt ?? "")}`} adapter={adapter} host={host} onSaved={onChanged} />
      <CalendarCard adapter={adapter} host={host} locale={locale} onChanged={onChanged} />
      <FeedCard adapter={adapter} host={host} onChanged={onChanged} />
      <div className="aibk-stack" data-aibk-target="types">
        {mine.map((type) => (
          <TypeCard key={`${type.id}:${String(type.updatedAt ?? "")}`} adapter={adapter} type={type} onSaved={onChanged} />
        ))}
        {adding ? (
          <TypeCard
            adapter={adapter}
            type={null}
            newHostIds={hostCount > 1 ? [host.id] : []}
            sortOrder={mine.length}
            onSaved={() => {
              setAdding(false);
              onChanged();
            }}
            onCancel={mine.length > 0 ? () => setAdding(false) : undefined}
          />
        ) : (
          <div>
            <button type="button" className="aibk-btn aibk-btn-secondary" onClick={() => setAdding(true)}>
              Add another call type
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/** The fields upsertHost always needs; every partial save sends the host's current values for them. */
function identity(host: AdminHost) {
  return { id: host.id, displayName: host.displayName, email: host.email, timezone: host.timezone };
}

/**
 * The host's own details — or, with no host yet, the form that creates one
 * (the first thing a new install sees).
 */
export function HostCard({
  adapter,
  host,
  onSaved,
}: {
  adapter: BookingAdminAdapter;
  host: AdminHost | null;
  onSaved: () => void;
}) {
  const [form, setForm] = useState({
    displayName: host?.displayName ?? "",
    email: host?.email ?? "",
    timezone: host?.timezone ?? browserTimeZone(),
    meetingLink: host?.meetingLink ?? "",
    phone: host?.phone ?? "",
    inviteMailbox: host?.inviteMailbox ?? "",
    autoConfirm: host?.autoConfirm ?? true,
  });
  const [saved, setSaved] = useState(false);
  const save = useAction(
    () =>
      adapter.upsertHost({
        ...(host ? { id: host.id } : {}),
        displayName: form.displayName.trim(),
        email: form.email.trim(),
        timezone: form.timezone,
        // "" clears a field; the server stores null.
        meetingLink: form.meetingLink.trim(),
        phone: form.phone.trim(),
        inviteMailbox: form.inviteMailbox.trim(),
        autoConfirm: form.autoConfirm,
      }),
    () => {
      setSaved(true);
      onSaved();
    },
  );
  const set = (patch: Partial<typeof form>) => {
    setForm({ ...form, ...patch });
    setSaved(false);
  };
  const ids = { name: useId(), email: useId(), zone: useId(), link: useId(), phone: useId(), mailbox: useId(), auto: useId() };
  const zones = timeZoneOptions(form.timezone);
  const emails = adapter.emailsEnabled;
  const missing = !form.displayName.trim() || !form.email.trim();

  return (
    <Card
      id="host"
      title={host ? "You, as the host" : "Set up who takes the calls"}
      hint={
        host
          ? "What the booking page, the calendar files and any emails say about you."
          : "Your booking page opens once there's a host and a call type. You can change all of this later."
      }
    >
      <div className="aibk-grid2">
        <FormField id={ids.name} label="Name shown to people booking">
          <input id={ids.name} className="aibk-input" value={form.displayName} maxLength={120} onChange={(e) => set({ displayName: e.target.value })} />
        </FormField>
        <FormField
          id={ids.email}
          label="Your email"
          hint="Where notices go. Also shown to invitees as the organizer in calendar files, and as the invite address unless you set an invite mailbox below."
        >
          <input
            id={ids.email}
            className="aibk-input"
            type="email"
            value={form.email}
            aria-describedby={`${ids.email}-hint`}
            onChange={(e) => set({ email: e.target.value })}
          />
        </FormField>
        <FormField id={ids.zone} label="Your time zone" hint="Your weekly hours are in this zone. People booking see times in their own.">
          <select
            id={ids.zone}
            className="aibk-input"
            value={form.timezone}
            aria-describedby={`${ids.zone}-hint`}
            onChange={(e) => set({ timezone: e.target.value })}
          >
            {zones.map((zone) => (
              <option key={zone} value={zone}>
                {zone.replace(/_/g, " ")}
              </option>
            ))}
          </select>
        </FormField>
        <FormField
          id={ids.link}
          label="Meeting link (video calls)"
          hint={`Your standing Zoom, Meet or Teams room. Shown to people who choose video on their confirmation and manage page${emails ? ", and in their emails" : ""}.`}
        >
          <input
            id={ids.link}
            className="aibk-input"
            type="url"
            value={form.meetingLink}
            placeholder="https://meet.google.com/abc-defg-hij"
            aria-describedby={`${ids.link}-hint`}
            onChange={(e) => set({ meetingLink: e.target.value })}
          />
        </FormField>
        <FormField
          id={ids.phone}
          label="Your phone (phone calls)"
          hint="The number you call from, so they know to pick up. Include the country code: +1 801 555 0143."
        >
          <input
            id={ids.phone}
            className="aibk-input"
            type="tel"
            value={form.phone}
            placeholder="+1 801 555 0143"
            aria-describedby={`${ids.phone}-hint`}
            onChange={(e) => set({ phone: e.target.value })}
          />
        </FormField>
        <FormField
          id={ids.mailbox}
          label="Invite mailbox (their meeting link)"
          hint="Where people who host the call send their invite. Blank uses your email."
        >
          <input
            id={ids.mailbox}
            className="aibk-input"
            type="email"
            value={form.inviteMailbox}
            aria-describedby={`${ids.mailbox}-hint`}
            onChange={(e) => set({ inviteMailbox: e.target.value })}
          />
        </FormField>
        <label htmlFor={ids.auto} className="aibk-check aibk-span2">
          <input id={ids.auto} type="checkbox" checked={form.autoConfirm} onChange={(e) => set({ autoConfirm: e.target.checked })} />
          <span>
            <strong>Confirm bookings automatically.</strong>{" "}
            <span className="aibk-hint">
              {emails
                ? "Off: each booking arrives as a request, the time is held, and the person hears back by email when you confirm it under Upcoming."
                : "Off: each booking arrives as a request, the time is held, and the person's manage page shows it once you confirm it under Upcoming."}
            </span>
          </span>
        </label>
      </div>
      <div className="aibk-row">
        <button
          type="button"
          className="aibk-btn aibk-btn-primary"
          disabled={save.pending || missing}
          aria-busy={save.pending || undefined}
          onClick={() => void save.run()}
        >
          {save.pending ? "Saving…" : host ? "Save" : "Create host"}
        </button>
        <Outcome ok={saved ? "Saved." : null} error={save.error} />
      </div>
    </Card>
  );
}

export function CalendarCard({
  adapter,
  host,
  locale,
  onChanged,
}: {
  adapter: BookingAdminAdapter;
  host: AdminHost;
  locale: string;
  onChanged: () => void;
}) {
  const [url, setUrl] = useState("");
  const [test, setTest] = useState<{ ok: boolean; events: number; error?: string } | null>(null);
  const save = useAction(
    (busyIcsUrl: string) => adapter.upsertHost({ ...identity(host), busyIcsUrl }),
    () => {
      setUrl("");
      setTest(null);
      onChanged();
    },
  );
  const check = useAction(
    () => adapter.testCalendar(host.id),
    (result) => {
      setTest(result);
      onChanged();
    },
  );
  const inputId = useId();
  const sync = host.busySync;

  return (
    <Card id="calendar" title="Your real calendar" hint="So nobody is offered a time you're already busy. Read-only: nothing is ever written to it.">
      <div className="aibk-hint aibk-stack-sm">
        <p>
          <strong className="aibk-strong">Where to find it in Google Calendar</strong>
        </p>
        <ol className="aibk-ol">
          <li>
            Open Google Calendar on the web and click the gear, then <b>Settings</b>.
          </li>
          <li>
            Under <b>Settings for my calendars</b> on the left, click the calendar you live in.
          </li>
          <li>
            Choose <b>Integrate calendar</b> and copy <b>Secret address in iCal format</b> (it ends in{" "}
            <code className="aibk-mono">basic.ics</code>).
          </li>
        </ol>
        <p>
          Anyone holding that address can read your whole calendar, so it stays on the server and is only ever shown
          masked. Outlook, iCloud and Fastmail &ldquo;publish&rdquo; links work the same way.
        </p>
        <p data-aibk-allday-note="">
          All-day events only block bookings when they're set to <b>Busy</b> in Google (Google makes them Free by
          default). For days off, use Time off in the Availability tab.
        </p>
      </div>

      <p>
        <span className="aibk-hint">Connected: </span>
        <span className="aibk-mono">{host.busyIcsUrl ?? "not yet"}</span>
      </p>
      {sync.error ? (
        <Notice tone="warn">
          <strong>Calendar sync is failing.</strong>{" "}
          {sync.failingSince ? `Since ${formatStamp(sync.failingSince, host.timezone, locale)}. ` : ""}
          {sync.error} Until it works again, only calls booked here block time.
        </Notice>
      ) : sync.okAt ? (
        <p className="aibk-hint">Last read successfully {formatStamp(sync.okAt, host.timezone, locale)}.</p>
      ) : null}

      <FormField id={inputId} label={host.busyIcsUrl ? "Replace it with a new address" : "Paste the secret address"}>
        <input
          id={inputId}
          className="aibk-input"
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={url}
          placeholder="https://calendar.google.com/calendar/ical/…/private-…/basic.ics"
          onChange={(e) => setUrl(e.target.value)}
        />
      </FormField>
      <div className="aibk-row">
        <button
          type="button"
          className="aibk-btn aibk-btn-primary"
          disabled={!url.trim() || save.pending}
          aria-busy={save.pending || undefined}
          onClick={() => void save.run(url.trim())}
        >
          {save.pending ? "Saving…" : "Save address"}
        </button>
        <button
          type="button"
          className="aibk-btn aibk-btn-secondary"
          disabled={!host.busyIcsUrl || check.pending}
          aria-busy={check.pending || undefined}
          onClick={() => void check.run()}
        >
          {check.pending ? "Testing…" : "Test"}
        </button>
        {host.busyIcsUrl ? (
          <button type="button" className="aibk-btn aibk-btn-secondary aibk-btn-danger-outline" disabled={save.pending} onClick={() => void save.run("")}>
            Disconnect
          </button>
        ) : null}
      </div>
      <Outcome error={save.error ?? check.error} />
      {test ? (
        test.ok ? (
          <p role="status" className="aibk-ok-text">
            It works: {test.events} busy {test.events === 1 ? "block" : "blocks"} in the next two weeks.
          </p>
        ) : (
          <p role="alert" className="aibk-danger-text">
            Couldn't read it: {test.error ?? "unknown error"}
          </p>
        )
      ) : null}
    </Card>
  );
}

export function FeedCard({ adapter, host, onChanged }: { adapter: BookingAdminAdapter; host: AdminHost; onChanged: () => void }) {
  const [minted, setMinted] = useState<{ httpsUrl: string; webcalUrl: string } | null>(null);
  const [confirming, setConfirming] = useState(false);
  const rotate = useAction(
    () => adapter.rotateFeed(host.id),
    (result) => {
      setMinted({ httpsUrl: result.httpsUrl, webcalUrl: result.webcalUrl ?? result.httpsUrl.replace(/^https?:\/\//, "webcal://") });
      setConfirming(false);
      onChanged();
    },
  );
  const emails = adapter.emailsEnabled;

  return (
    <Card
      id="feed"
      title="Your calls in your calendar"
      hint="A private feed of your upcoming calls that Google Calendar (or Apple, or Outlook) subscribes to."
    >
      <ol className="aibk-ol aibk-hint">
        <li>Generate the link below and copy it. It is shown once.</li>
        <li>
          In Google Calendar on the web, click <b>+</b> next to <b>Other calendars</b>, choose <b>From URL</b>, paste it,
          and click <b>Add calendar</b>.
        </li>
        <li>On a Mac or iPhone, open the webcal:// link instead.</li>
      </ol>
      <p className="aibk-hint">
        Google refreshes subscribed calendars every few hours, so a new call can take a while to appear
        {emails ? "; the email notice for each booking has a one-click add for right away" : ""}. Moved and cancelled
        calls update themselves in the feed. It shows first names and companies only, but anyone with the link sees your
        upcoming calls.
      </p>
      {minted ? (
        <div className="aibk-feed-once" data-aibk-feed-once="">
          <CopyField
            label="Your feed link — copy it now, it won't be shown again"
            value={minted.httpsUrl}
            buttonLabel="Copy link"
          />
          <a href={minted.webcalUrl}>Open as webcal://</a>
        </div>
      ) : null}
      {confirming ? (
        <Notice tone="warn">
          Make a new link? The old one stops working, so anywhere it's subscribed stops updating.{" "}
          <button type="button" className="aibk-btn aibk-btn-link" disabled={rotate.pending} onClick={() => void rotate.run()}>
            {rotate.pending ? "Making a new link…" : "Yes, make a new link"}
          </button>{" "}
          <button type="button" className="aibk-btn aibk-btn-link" onClick={() => setConfirming(false)}>
            Keep the old one
          </button>
        </Notice>
      ) : null}
      <div className="aibk-row">
        {!confirming ? (
          <button
            type="button"
            className={`aibk-btn ${host.hasFeedToken ? "aibk-btn-secondary" : "aibk-btn-primary"}`}
            disabled={rotate.pending}
            aria-busy={rotate.pending || undefined}
            onClick={() => (host.hasFeedToken ? setConfirming(true) : void rotate.run())}
          >
            {rotate.pending ? "Generating…" : host.hasFeedToken ? "Make a new link (stops the old one)" : "Generate feed link"}
          </button>
        ) : null}
        {host.hasFeedToken && !minted ? (
          <span className="aibk-hint">A link exists. It can't be shown again; make a new one if you've lost it.</span>
        ) : null}
        <Outcome error={rotate.error} />
      </div>
    </Card>
  );
}

const MEDIA: ReadonlyArray<readonly [Medium, string]> = [
  ["video", "Video call (you send your meeting link)"],
  ["phone", "Phone call (you call them)"],
  ["prospect_hosted", "Their meeting link (they send the invite)"],
];

function NumberField({
  label,
  hint,
  value,
  onChange,
  min,
  max,
  step,
  suffix,
  optional,
}: {
  label: string;
  hint?: string;
  value: number;
  onChange: (value: number) => void;
  min: number;
  max: number;
  step: number;
  suffix: string;
  optional?: boolean;
}) {
  const id = useId();
  return (
    <FormField id={id} label={optional ? <>{label} <span className="aibk-optional">(optional)</span></> : label} hint={hint}>
      <div className="aibk-row aibk-nowrap">
        <input
          id={id}
          className="aibk-input aibk-number"
          type="number"
          inputMode="numeric"
          min={min}
          max={max}
          step={step}
          value={Number.isFinite(value) ? value : ""}
          aria-describedby={hint ? `${id}-hint` : undefined}
          onChange={(e) => onChange(e.target.valueAsNumber)}
        />
        <span className="aibk-hint">{suffix}</span>
      </div>
    </FormField>
  );
}

const KEY_PATTERN = /^[a-z0-9][a-z0-9_-]*$/i;

/** Edit a call type — or, with `type` null, create one. */
export function TypeCard({
  adapter,
  type,
  newHostIds = [],
  sortOrder = 0,
  onSaved,
  onCancel,
}: {
  adapter: BookingAdminAdapter;
  type: AdminBookingType | null;
  /** Creating: the hosts the new type is for. Empty (the default) means every active host. */
  newHostIds?: string[];
  sortOrder?: number;
  onSaved: () => void;
  onCancel?: () => void;
}) {
  const [form, setForm] = useState({
    key: type?.key ?? "",
    name: type?.name ?? "",
    description: type?.description ?? "",
    durationMinutes: type?.durationMinutes ?? 30,
    bufferBeforeMinutes: type?.bufferBeforeMinutes ?? 0,
    bufferAfterMinutes: type?.bufferAfterMinutes ?? 15,
    stepMinutes: type?.stepMinutes ?? 30,
    noticeHours: type ? Math.round((type.minNoticeMinutes / 60) * 100) / 100 : 4,
    horizonDays: type?.horizonDays ?? 21,
    maxPerDay: type?.maxPerDay ?? Number.NaN,
    media: type?.media ?? (["video"] as Medium[]),
    isActive: type?.isActive ?? true,
  });
  const [saved, setSaved] = useState(false);
  const set = (patch: Partial<typeof form>) => {
    setForm({ ...form, ...patch });
    setSaved(false);
  };
  const ids = { key: useId(), name: useId(), desc: useId(), duration: useId(), active: useId() };
  const numbersOk = [form.bufferBeforeMinutes, form.bufferAfterMinutes, form.stepMinutes, form.noticeHours, form.horizonDays].every(
    Number.isFinite,
  );
  const keyOk = KEY_PATTERN.test(form.key.trim());
  const problem =
    form.media.length === 0
      ? "Offer at least one way to meet."
      : !form.name.trim()
        ? "Give the call a name."
        : !type && !keyOk
          ? "The key is letters, digits, dashes and underscores, like intro-call."
          : !numbersOk
            ? "Fill in every number."
            : null;
  const input = (): BookingTypeInput => ({
    ...(type ? { id: type.id } : {}),
    key: type ? type.key : form.key.trim(),
    name: form.name.trim(),
    description: form.description.trim() || null,
    durationMinutes: form.durationMinutes,
    bufferBeforeMinutes: form.bufferBeforeMinutes,
    bufferAfterMinutes: form.bufferAfterMinutes,
    stepMinutes: form.stepMinutes,
    minNoticeMinutes: Math.round(form.noticeHours * 60),
    horizonDays: form.horizonDays,
    maxPerDay: Number.isFinite(form.maxPerDay) && form.maxPerDay > 0 ? form.maxPerDay : null,
    media: form.media,
    // Not on this form, so sent as they are — upsertType replaces every field.
    hostIds: type ? type.hostIds : newHostIds,
    isActive: form.isActive,
    sortOrder: type ? type.sortOrder : sortOrder,
  });
  const save = useAction(
    () => adapter.upsertType(input()),
    () => {
      setSaved(true);
      onSaved();
    },
  );

  return (
    <Card
      id={type ? `type-${type.key}` : "types"}
      title={type ? `Call type: ${type.name}` : "New call type"}
      hint={type ? `Key "${type.key}". What the booking page offers.` : "What people can book with you: its name, length and how you meet."}
    >
      <div className="aibk-grid2">
        {!type ? (
          <FormField id={ids.key} label="Key" hint="A short id the booking page asks for, like intro-call. It can't be changed later.">
            <input
              id={ids.key}
              className="aibk-input"
              value={form.key}
              maxLength={64}
              placeholder="intro-call"
              aria-describedby={`${ids.key}-hint`}
              onChange={(e) => set({ key: e.target.value })}
            />
          </FormField>
        ) : null}
        <FormField id={ids.name} label="Name">
          <input id={ids.name} className="aibk-input" value={form.name} maxLength={120} placeholder="Intro call" onChange={(e) => set({ name: e.target.value })} />
        </FormField>
        <FormField id={ids.duration} label="Length">
          <select
            id={ids.duration}
            className="aibk-input"
            value={form.durationMinutes}
            onChange={(e) => set({ durationMinutes: Number(e.target.value) })}
          >
            {[...new Set([15, 20, 30, 45, 60, 90, 120, form.durationMinutes])]
              .sort((a, b) => a - b)
              .map((minutes) => (
                <option key={minutes} value={minutes}>
                  {minutes} minutes
                </option>
              ))}
          </select>
        </FormField>
        <FormField id={ids.desc} label="Description" hint="Shown on the booking page under the call's name." wide>
          <textarea
            id={ids.desc}
            className="aibk-input"
            rows={3}
            value={form.description}
            maxLength={1000}
            aria-describedby={`${ids.desc}-hint`}
            onChange={(e) => set({ description: e.target.value })}
          />
        </FormField>
        <NumberField
          label="Clear time before"
          hint="Nothing can be booked this close before the call."
          value={form.bufferBeforeMinutes}
          onChange={(value) => set({ bufferBeforeMinutes: value })}
          min={0}
          max={240}
          step={5}
          suffix="minutes"
        />
        <NumberField
          label="Clear time after"
          hint="Time to write the call up before the next one."
          value={form.bufferAfterMinutes}
          onChange={(value) => set({ bufferAfterMinutes: value })}
          min={0}
          max={240}
          step={5}
          suffix="minutes"
        />
        <NumberField
          label="Start times every"
          hint="The grid times are offered on, from the start of each block of hours."
          value={form.stepMinutes}
          onChange={(value) => set({ stepMinutes: value })}
          min={5}
          max={240}
          step={5}
          suffix="minutes"
        />
        <NumberField
          label="Minimum notice"
          hint="Nobody can book a call starting sooner than this."
          value={form.noticeHours}
          onChange={(value) => set({ noticeHours: value })}
          min={0}
          max={1440}
          step={1}
          suffix="hours"
        />
        <NumberField
          label="How far ahead"
          hint="Days you can be booked into, today included."
          value={form.horizonDays}
          onChange={(value) => set({ horizonDays: value })}
          min={1}
          max={365}
          step={1}
          suffix="days"
        />
        <NumberField
          label="Most per day"
          hint="Leave empty for no limit."
          value={form.maxPerDay}
          onChange={(value) => set({ maxPerDay: value })}
          min={1}
          max={100}
          step={1}
          suffix="calls"
          optional
        />
        <fieldset className="aibk-fieldset aibk-span2">
          <legend className="aibk-label">Ways to meet on offer</legend>
          {MEDIA.map(([medium, label]) => (
            <label key={medium} className="aibk-check">
              <input
                type="checkbox"
                checked={form.media.includes(medium)}
                onChange={(e) =>
                  set({ media: e.target.checked ? [...form.media, medium] : form.media.filter((m) => m !== medium) })
                }
              />
              <span>{label}</span>
            </label>
          ))}
        </fieldset>
        <label htmlFor={ids.active} className="aibk-check aibk-span2">
          <input id={ids.active} type="checkbox" checked={form.isActive} onChange={(e) => set({ isActive: e.target.checked })} />
          <span>
            <strong>Bookable.</strong> <span className="aibk-hint">Off hides it from the booking page; existing calls are untouched.</span>
          </span>
        </label>
      </div>
      <div className="aibk-row">
        <button
          type="button"
          className="aibk-btn aibk-btn-primary"
          disabled={save.pending || problem !== null}
          aria-busy={save.pending || undefined}
          onClick={() => void save.run()}
        >
          {save.pending ? "Saving…" : type ? "Save" : "Create call type"}
        </button>
        {onCancel ? (
          <button type="button" className="aibk-btn aibk-btn-secondary" onClick={onCancel}>
            Cancel
          </button>
        ) : null}
        <Outcome error={problem ?? save.error} ok={saved ? "Saved. Your booking page uses it now." : null} />
      </div>
    </Card>
  );
}
