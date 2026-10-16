import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { createAlertsClient, type AlertsTransport } from "../client.js";
import { safeHref } from "../href.js";
import type { AlertChannelWire, AlertChoiceWire, PreferencesWire, RoutingGroupWire, RoutingWire } from "../types.js";
import { Root, Spinner, type ChromeProps } from "../ui.js";
import {
  ADD_ADDRESS,
  ADDRESSES_STILL,
  ALSO_EMAIL,
  BAD_ADDRESS,
  businessEmailLine,
  coversLine,
  EMAIL_ADDRESS,
  emailLine,
  HOW_YOU_GET,
  IN_APP,
  IN_APP_AND_EMAIL,
  kindEmailToLine,
  MESSAGES_LINK,
  nobodyTickedLine,
  noEmailsLine,
  NOT_ON_A_LIST,
  NOT_ON_YOUR_LIST,
  NOT_ON_YOUR_LIST_NOTE,
  ownerAllInApp,
  ownerChoice,
  REMOVE_ADDRESS,
  routedSentence,
  SAVE,
  SAVED,
  SETTINGS,
  THESE_PEOPLE,
  TRY_AGAIN,
  WHO_HEARS,
} from "./words.js";

/**
 * `<AlertSettings>` (Tenancy 2b-1, section 5): Alert settings.
 *
 *   <AlertSettings baseUrl={`/api/app/${companyId}/alerts`} />
 *
 * 1. HOW YOU GET EACH ALERT, for everyone: per kind, "In the app" or "In the
 *    app and by email" (the second disabled, with the reason, when it can't
 *    go). A change saves at once and says "Saved."; a refusal puts the old
 *    choice back and shows the server's sentence. Kinds the person can't get
 *    now are listed together under "Not on your list" (review BO-12).
 * 2. WHO HEARS ABOUT NEW WORK, for the owner (`canManageRouting`): ONE place,
 *    per group, "The owner" or "These people" (picked from a list of the
 *    company's people, never typed), plus up to five addresses. A list with
 *    nobody ticked says, before saving, that the owner gets them (review
 *    BO-20), and where their emails go (review BO-7).
 *
 * WHERE THE EMAILS GO (review BO-1). While a list is on "The owner", the
 * owner's copies go to the business email in company settings, and the
 * owner's own "In the app" choice for a kind means the business mailbox gets
 * nothing for it. The top line, the kind and the list's card each say so,
 * naming "company settings" (the template's page) unless the host names its
 * own with `businessEmailSettings`.
 */

export interface AlertSettingsProps extends ChromeProps {
  baseUrl?: string;
  transport?: AlertsTransport;
  locale?: string;
  /** Leave out the "Alert settings" heading: for a page whose own header already shows it (review BO-11). */
  hideTitle?: boolean;
  /**
   * Where the business email is set in your app, in a few words, for the
   * three sentences that say the owner's emails go there ("…, the business
   * email in Settings → Business profile."). Absent: "company settings".
   */
  businessEmailSettings?: string;
}

export function AlertSettings({ baseUrl, transport: given, hideTitle, businessEmailSettings, theme, nonce, className, style }: AlertSettingsProps) {
  const transport = useMemo(() => given ?? (baseUrl ? createAlertsClient({ baseUrl }) : null), [given, baseUrl]);
  const [prefs, setPrefs] = useState<PreferencesWire | null>(null);
  const [routing, setRouting] = useState<RoutingWire | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [refusal, setRefusal] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!transport) return;
    const answer = await transport.preferences();
    if (!answer.ok) {
      setError(answer.error.message);
      return;
    }
    setError(null);
    setPrefs(answer.data);
    if (answer.data.canManageRouting) {
      const groups = await transport.routing();
      if (groups.ok) setRouting(groups.data);
      else setError(groups.error.message);
    }
  }, [transport]);

  useEffect(() => {
    void load();
  }, [load]);

  const choose = async (choice: AlertChoiceWire, channel: AlertChannelWire) => {
    if (!transport || !prefs || choice.channel === channel) return;
    const before = prefs;
    // At once, so the radio follows the finger; put back on a refusal.
    setPrefs({ ...prefs, choices: prefs.choices.map((c) => (c.kind === choice.kind ? { ...c, channel } : c)) });
    setStatus("");
    setRefusal(null);
    const answer = await transport.setPreference({ kind: choice.kind, channel });
    if (answer.ok) {
      setPrefs(answer.data);
      setStatus(SAVED);
      // Review BO-1: the owner's own choice decides what the business mailbox
      // gets while a list is on "The owner"; the cards below say so, so they
      // are read again (a card's unsaved edits are kept).
      if (answer.data.canManageRouting && choice.routed) {
        const groups = await transport.routing();
        if (groups.ok) setRouting(groups.data);
      }
    } else {
      setPrefs(before);
      setRefusal(answer.error.issues?.[0]?.message ?? answer.error.message);
    }
  };

  if (!transport) return null;
  const messages = prefs && safeHref(prefs.links.messages) ? prefs.links.messages : null;
  const receiving = prefs?.choices.filter((c) => c.receives) ?? [];
  const notMine = prefs?.choices.filter((c) => !c.receives) ?? [];
  // Review BO-1: a kind whose emails go somewhere other than the person's own address (the business email).
  const elsewhere = (choice: AlertChoiceWire) =>
    choice.emailOffered && choice.emailTo !== null && choice.emailTo.toLowerCase() !== (prefs?.emailAddress ?? "").toLowerCase() ? choice.emailTo : null;
  const workEmail = receiving.map(elsewhere).find((address): address is string => address !== null) ?? null;

  return (
    <Root theme={theme} nonce={nonce} className={className} style={style}>
      <div className="ainw-page">
        {hideTitle ? null : <h2 className="ainw-title">{SETTINGS}</h2>}
        <p className="ainw-status" role="status">
          {status}
        </p>
        {error ? (
          <div className="ainw-notice ainw-notice-error ainw-row">
            <span>{error}</span>
            <button type="button" className="ainw-btn ainw-btn-secondary" onClick={() => void load()}>
              {TRY_AGAIN}
            </button>
          </div>
        ) : null}
        {!prefs && !error ? <Spinner label="Loading your alert settings…" /> : null}
        {prefs ? (
          <section className="ainw-card" data-ainw-section="how">
            <h3 className="ainw-h2">{HOW_YOU_GET}</h3>
            {!prefs.reachable ? <p className="ainw-notice ainw-notice-info">{NOT_ON_A_LIST}</p> : null}
            <p className="ainw-muted">{emailLine({ ...prefs, workEmail, where: businessEmailSettings })}</p>
            {refusal ? (
              <p className="ainw-notice ainw-notice-error" role="alert">
                {refusal}
              </p>
            ) : null}
            {prefs.categories.map((category) => {
              const kinds = receiving.filter((c) => c.category === category);
              if (kinds.length === 0) return null;
              return (
                <div key={category} className="ainw-stack" data-ainw-category={category}>
                  <h4 className="ainw-h3">{category}</h4>
                  {kinds.map((choice) => (
                    <KindChoice
                      key={choice.kind}
                      choice={choice}
                      elsewhere={elsewhere(choice)}
                      where={businessEmailSettings}
                      messages={messages}
                      onChoose={(channel) => void choose(choice, channel)}
                    />
                  ))}
                </div>
              );
            })}
            {notMine.length > 0 ? (
              <div className="ainw-stack" data-ainw-section="not-mine">
                <h4 className="ainw-h3">{NOT_ON_YOUR_LIST}</h4>
                <p className="ainw-note">{NOT_ON_YOUR_LIST_NOTE}</p>
                <ul className="ainw-people">
                  {notMine.map((choice) => (
                    <li key={choice.kind}>{choice.label}</li>
                  ))}
                </ul>
              </div>
            ) : null}
          </section>
        ) : null}
        {prefs?.canManageRouting && routing ? (
          <section className="ainw-stack" data-ainw-section="who">
            <h3 className="ainw-h2">{WHO_HEARS}</h3>
            {routing.groups.map((group) => (
              <GroupCard
                key={group.key}
                group={group}
                where={businessEmailSettings}
                transport={transport}
                onSaved={(next) => {
                  setRouting(next);
                  setStatus(SAVED);
                }}
              />
            ))}
          </section>
        ) : null}
      </div>
    </Root>
  );
}

function KindChoice({
  choice,
  elsewhere,
  where,
  messages,
  onChoose,
}: {
  choice: AlertChoiceWire;
  /** Where its emails go when that isn't the person's own address (review BO-1). */
  elsewhere: string | null;
  /** Where the business email is set (`businessEmailSettings`). */
  where: string | undefined;
  messages: string | null;
  onChoose: (channel: AlertChannelWire) => void;
}) {
  const name = useId();
  const routed = routedSentence(choice.routed);
  return (
    <fieldset className="ainw-kind" data-ainw-kind={choice.kind}>
      <legend className="ainw-kind-label">{choice.label}</legend>
      {choice.description ? <p className="ainw-note">{choice.description}</p> : null}
      <div className="ainw-choices">
        <label className="ainw-choice">
          <input type="radio" name={name} value="in_app" checked={choice.channel === "in_app"} onChange={() => onChoose("in_app")} />
          {IN_APP}
        </label>
        <label className={`ainw-choice${choice.emailOffered ? "" : " ainw-choice-disabled"}`}>
          <input
            type="radio"
            name={name}
            value="email"
            checked={choice.channel === "email"}
            disabled={!choice.emailOffered}
            onChange={() => onChoose("email")}
          />
          {IN_APP_AND_EMAIL}
        </label>
      </div>
      {choice.emailNote ? (
        <p className="ainw-note" data-ainw-note="">
          {choice.emailNote}
          {choice.emailOffInMessages && messages ? (
            <>
              {" "}
              <a href={messages}>{MESSAGES_LINK}</a>
            </>
          ) : null}
        </p>
      ) : null}
      {elsewhere ? (
        <p className="ainw-note" data-ainw-email-to="">
          {kindEmailToLine(elsewhere, where)}
        </p>
      ) : null}
      {routed ? <p className="ainw-note">{routed}</p> : null}
    </fieldset>
  );
}

function GroupCard({
  group,
  where,
  transport,
  onSaved,
}: {
  group: RoutingGroupWire;
  /** Where the business email is set (`businessEmailSettings`). */
  where: string | undefined;
  transport: AlertsTransport;
  onSaved: (next: RoutingWire) => void;
}) {
  const name = useId();
  const [mode, setMode] = useState(group.mode);
  const [ticked, setTicked] = useState<string[]>(group.userIds);
  const [addresses, setAddresses] = useState<string[]>(group.extraEmails.length > 0 ? group.extraEmails : []);
  const [errors, setErrors] = useState<Record<number, string>>({});
  const [refusal, setRefusal] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // Reset to what is saved when THAT changes, not on every read of the cards
  // (they are read again after the owner's own choice changes: review BO-1).
  const saved = JSON.stringify([group.mode, group.userIds, group.extraEmails]);
  useEffect(() => {
    setMode(group.mode);
    setTicked(group.userIds);
    setAddresses(group.extraEmails);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saved]);

  const owner = group.candidates.find((person) => person.isOwner) ?? null;
  const filled = addresses.map((a) => a.trim()).filter(Boolean);
  const covers = coversLine(group.covers);
  // Review BO-1: on the business email, the owner's own "In the app" choice
  // leaves the company's mailbox without those kinds: say which.
  const business = group.ownerEmailIsBusiness && group.ownerEmail ? group.ownerEmail : null;
  const noEmails = business ? noEmailsLine(group.ownerInAppOnly, group.ownerIsYou) : null;
  const allInApp = ownerAllInApp(group);

  const save = async () => {
    const found: Record<number, string> = {};
    addresses.forEach((address, i) => {
      const value = address.trim();
      if (value && (value.length > 254 || !EMAIL_ADDRESS.test(value))) found[i] = BAD_ADDRESS;
    });
    setErrors(found);
    setRefusal(null);
    if (Object.keys(found).length > 0) return;
    setSaving(true);
    const answer = await transport.setRouting({ key: group.key, mode, userIds: mode === "chosen" ? ticked : group.userIds, extraEmails: filled });
    setSaving(false);
    if (answer.ok) onSaved(answer.data);
    else setRefusal(answer.error.issues?.[0]?.message ?? answer.error.message);
  };

  return (
    <div className="ainw-card" data-ainw-group={group.key}>
      <fieldset className="ainw-stack">
        <legend className="ainw-kind-label">{group.label}</legend>
        {group.description ? <p className="ainw-note">{group.description}</p> : null}
        {group.emailNote ? <p className="ainw-notice ainw-notice-warn">{group.emailNote}</p> : null}
        {covers ? <p className="ainw-note">{covers}</p> : null}
        <label className="ainw-choice">
          <input type="radio" name={name} value="owner" checked={mode === "owner"} onChange={() => setMode("owner")} />
          {ownerChoice(owner?.name ?? null)}
        </label>
        {mode === "owner" && business && !allInApp ? <p className="ainw-note">{businessEmailLine(business, where)}</p> : null}
        {mode === "owner" && noEmails ? (
          <p className="ainw-note" data-ainw-no-emails="">
            {noEmails}
          </p>
        ) : null}
        <label className="ainw-choice">
          <input type="radio" name={name} value="chosen" checked={mode === "chosen"} onChange={() => setMode("chosen")} />
          {THESE_PEOPLE}
        </label>
        {mode === "chosen" ? (
          <div className="ainw-stack">
            <ul className="ainw-people">
              {group.candidates.map((person) => (
                <li key={person.userId}>
                  <label className="ainw-choice">
                    <input
                      type="checkbox"
                      checked={ticked.includes(person.userId)}
                      onChange={(event) =>
                        setTicked((current) => (event.target.checked ? [...current, person.userId] : current.filter((id) => id !== person.userId)))
                      }
                    />
                    <span>
                      {person.name ?? person.email ?? "A teammate"}
                      {person.name && person.email ? <span className="ainw-person-email"> {person.email}</span> : null}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
            <div className="ainw-stack">
              <p className="ainw-label">{ALSO_EMAIL}</p>
              {addresses.map((address, i) => (
                <div key={i} className="ainw-field">
                  <div className="ainw-row">
                    <input
                      className="ainw-input ainw-input-grow"
                      type="email"
                      inputMode="email"
                      autoComplete="off"
                      aria-label={`Address ${i + 1}`}
                      aria-invalid={errors[i] ? true : undefined}
                      value={address}
                      onChange={(event) => setAddresses((current) => current.map((a, j) => (j === i ? event.target.value : a)))}
                    />
                    <button type="button" className="ainw-btn ainw-btn-link" onClick={() => setAddresses((current) => current.filter((_, j) => j !== i))}>
                      {REMOVE_ADDRESS}
                    </button>
                  </div>
                  {errors[i] ? <p className="ainw-field-error">{errors[i]}</p> : null}
                </div>
              ))}
              {addresses.length < 5 ? (
                <div>
                  <button type="button" className="ainw-btn ainw-btn-secondary" onClick={() => setAddresses((current) => [...current, ""])}>
                    {ADD_ADDRESS}
                  </button>
                </div>
              ) : null}
            </div>
            {ticked.length === 0 ? (
              <p className="ainw-notice ainw-notice-info" data-ainw-nobody="">
                {nobodyTickedLine(group)}
                {noEmails && !allInApp ? ` ${noEmails}` : ""}
                {filled.length > 0 ? ` ${ADDRESSES_STILL}` : ""}
              </p>
            ) : null}
          </div>
        ) : null}
      </fieldset>
      {refusal ? (
        <p className="ainw-notice ainw-notice-error" role="alert">
          {refusal}
        </p>
      ) : null}
      <div>
        <button type="button" className="ainw-btn ainw-btn-primary" disabled={saving} onClick={() => void save()}>
          {SAVE}
        </button>
      </div>
    </div>
  );
}
