import { useMemo, useState, type FormEvent } from "react";
import type { PreferencesResponse } from "../handlers.js";
import type { EmailKind } from "../registry.js";
import { hourLabel } from "../time.js";
import { digestCss } from "./styles.js";

/**
 * THE PREFERENCES SCREEN (digest 0.1): every email the site sends, each with
 * its own box (off until the person ticks it), the hour their digests come
 * and the zone that hour is in — with "use this device's" one click away.
 * Saved with one PUT to the handlers (`endpoint`, default
 * /api/email/v1/preferences). The page that mounts it reads the first state
 * on the server and passes it in, so the screen is right on first paint.
 */

export interface EmailPreferencesProps {
  readonly initial: PreferencesResponse;
  /** Default "/api/email/v1/preferences". */
  readonly endpoint?: string;
  /** Zones to offer. Default: every zone this browser knows, else the person's and the site's. */
  readonly timeZones?: readonly string[];
}

function browserZone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

function allZones(extra: readonly string[]): string[] {
  let zones: string[] = [];
  try {
    const supported = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf;
    if (supported) zones = supported("timeZone");
  } catch {
    zones = [];
  }
  return [...new Set([...extra.filter(Boolean), ...zones])].sort();
}

function KindChoice({ kind, checked, onChange }: { readonly kind: EmailKind; readonly checked: boolean; readonly onChange: (next: boolean) => void }) {
  const id = `aidg-${kind.key}`;
  return (
    <div className="aidg-choice">
      <input id={id} type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <label htmlFor={id}>
        <strong>{kind.title}</strong>
        <span className="aidg-muted">{kind.description}</span>
      </label>
    </div>
  );
}

export function EmailPreferences({ initial, endpoint = "/api/email/v1/preferences", timeZones }: EmailPreferencesProps) {
  const [choices, setChoices] = useState<Record<string, boolean>>({ ...initial.preferences.choices });
  const [deliveryHour, setDeliveryHour] = useState(initial.preferences.deliveryHour);
  const [timeZone, setTimeZone] = useState(initial.preferences.timeZone);
  const [zoneIsSite, setZoneIsSite] = useState(initial.preferences.timeZoneSource === "site");
  const [state, setState] = useState<{ readonly kind: "idle" | "saving" | "saved" | "error"; readonly message?: string }>({ kind: "idle" });
  const here = useMemo(browserZone, []);
  const zones = useMemo(() => [...(timeZones ?? allZones([initial.preferences.timeZone, initial.siteTimeZone]))], [timeZones, initial.preferences.timeZone, initial.siteTimeZone]);

  const digests = initial.kinds.filter((kind) => kind.type === "digest");
  const alerts = initial.kinds.filter((kind) => kind.type === "alert");

  async function save(event: FormEvent) {
    event.preventDefault();
    setState({ kind: "saving" });
    try {
      const response = await fetch(endpoint, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ choices, deliveryHour, timeZone: zoneIsSite ? null : timeZone }),
      });
      const body = (await response.json().catch(() => null)) as (PreferencesResponse & { error?: { message?: string } }) | null;
      if (!response.ok || !body?.preferences) {
        setState({ kind: "error", message: body?.error?.message ?? "That didn't save. Please try again." });
        return;
      }
      setChoices({ ...body.preferences.choices });
      setDeliveryHour(body.preferences.deliveryHour);
      setTimeZone(body.preferences.timeZone);
      setZoneIsSite(body.preferences.timeZoneSource === "site");
      setState({ kind: "saved", message: "Saved." });
    } catch {
      setState({ kind: "error", message: "That didn't save: check your connection and try again." });
    }
  }

  if (initial.kinds.length === 0) {
    return (
      <div className="aidg">
        <style>{digestCss}</style>
        <p className="aidg-muted">This site doesn&apos;t send any emails you can choose yet.</p>
      </div>
    );
  }

  return (
    <form className="aidg aidg-stack" onSubmit={save}>
      <style>{digestCss}</style>
      {digests.length > 0 ? (
        <section className="aidg-card" aria-labelledby="aidg-digests">
          <h2 id="aidg-digests" className="aidg-h2">
            Emails each day
          </h2>
          <p className="aidg-muted">At most one of each a day. Nothing comes until you tick it.</p>
          {digests.map((kind) => (
            <KindChoice key={kind.key} kind={kind} checked={choices[kind.key] === true} onChange={(next) => setChoices((now) => ({ ...now, [kind.key]: next }))} />
          ))}
        </section>
      ) : null}
      {alerts.length > 0 ? (
        <section className="aidg-card" aria-labelledby="aidg-alerts">
          <h2 id="aidg-alerts" className="aidg-h2">
            Alerts
          </h2>
          <p className="aidg-muted">Sent when something happens.</p>
          {alerts.map((kind) => (
            <KindChoice key={kind.key} kind={kind} checked={choices[kind.key] === true} onChange={(next) => setChoices((now) => ({ ...now, [kind.key]: next }))} />
          ))}
        </section>
      ) : null}
      {digests.length > 0 ? (
        <section className="aidg-card aidg-stack" aria-labelledby="aidg-when">
          <div>
            <h2 id="aidg-when" className="aidg-h2">
              When they come
            </h2>
            <p className="aidg-muted">
              At or after {hourLabel(deliveryHour)}, {zoneIsSite ? `${initial.siteTimeZone} (this site's time zone)` : timeZone}.
            </p>
          </div>
          <div className="aidg-row">
            <div className="aidg-field">
              <label htmlFor="aidg-hour">Hour</label>
              <select id="aidg-hour" className="aidg-select" value={deliveryHour} onChange={(event) => setDeliveryHour(Number(event.target.value))}>
                {Array.from({ length: 24 }, (_, hour) => (
                  <option key={hour} value={hour}>
                    {hourLabel(hour)}
                  </option>
                ))}
              </select>
            </div>
            <div className="aidg-field">
              <label htmlFor="aidg-zone">Time zone</label>
              <select
                id="aidg-zone"
                className="aidg-select"
                value={zoneIsSite ? "" : timeZone}
                onChange={(event) => {
                  if (event.target.value === "") {
                    setZoneIsSite(true);
                  } else {
                    setZoneIsSite(false);
                    setTimeZone(event.target.value);
                  }
                }}
              >
                <option value="">This site&apos;s ({initial.siteTimeZone})</option>
                {zones.map((zone) => (
                  <option key={zone} value={zone}>
                    {zone.replace(/_/g, " ")}
                  </option>
                ))}
              </select>
            </div>
          </div>
          {here && (zoneIsSite || here !== timeZone) ? (
            <p className="aidg-muted">
              <button
                type="button"
                className="aidg-link"
                onClick={() => {
                  setZoneIsSite(false);
                  setTimeZone(here);
                }}
              >
                Use this device&apos;s time zone ({here.replace(/_/g, " ")})
              </button>
            </p>
          ) : null}
        </section>
      ) : null}
      <div className="aidg-row">
        <button type="submit" className="aidg-btn" disabled={state.kind === "saving"}>
          {state.kind === "saving" ? "Saving…" : "Save"}
        </button>
        {state.kind === "saved" ? <p className="aidg-ok" role="status">{state.message}</p> : null}
        {state.kind === "error" ? <p className="aidg-error" role="alert">{state.message}</p> : null}
      </div>
    </form>
  );
}
