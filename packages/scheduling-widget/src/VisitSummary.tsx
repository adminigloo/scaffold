import { formatDuration, googleCalendarUrl, describeVisitWhen } from "./time.js";
import type { PublicVisit } from "./types.js";

/**
 * A visit, described the same way on the confirmation and on the manage page:
 * when (on the business's clock, with the zone's name for that date), where,
 * and what — plus the two calendar exports.
 */

export function VisitFacts({ visit, locale }: { visit: PublicVisit; locale: string }) {
  return (
    <dl className="aisw-facts">
      <div className="aisw-fact">
        <dt>When</dt>
        <dd>
          <strong>{describeVisitWhen(visit, locale)}</strong>
          {visit.durationMinutes > 0 ? (
            <>
              <br />
              <span className="aisw-hint">{formatDuration(visit.durationMinutes)}</span>
            </>
          ) : null}
        </dd>
      </div>
      <div className="aisw-fact">
        <dt>Where</dt>
        <dd>{visit.address ?? "The address you gave us"}</dd>
      </div>
      <div className="aisw-fact">
        <dt>What</dt>
        <dd>
          {visit.serviceName}
          {visit.businessName ? ` with ${visit.businessName}` : ""}
        </dd>
      </div>
    </dl>
  );
}

/**
 * "Add to Google Calendar" and "Download .ics". The confirmation builds the
 * Google link in the browser from the instants and the address (contract 8.3,
 * `clientCalendarUrl`); the manage page uses the server's, which is null once
 * the visit no longer stands. The .ics comes from the server's route, so a
 * moved visit's download carries the bumped SEQUENCE and calendars update the
 * entry in place.
 */
export function clientCalendarUrl(visit: PublicVisit, manageUrl?: string | null): string | null {
  return googleCalendarUrl({
    title: `${visit.serviceName}${visit.businessName ? ` — ${visit.businessName}` : ""}`,
    startsAt: visit.startsAt,
    endsAt: visit.endsAt,
    location: visit.address,
    details: manageUrl ? `Change or cancel: ${manageUrl}` : null,
    timeZone: visit.timeZone,
  });
}

export function CalendarActions({ google, icsHref }: { google: string | null; icsHref: string | null }) {
  if (!google && !icsHref) return null;
  return (
    <div className="aisw-actions">
      {google ? (
        <a className="aisw-btn aisw-btn-secondary" href={google} target="_blank" rel="noopener noreferrer">
          Add to Google Calendar
          <span className="aisw-sr"> (opens in a new tab)</span>
        </a>
      ) : null}
      {icsHref ? (
        <a className="aisw-btn aisw-btn-secondary" href={icsHref} download="visit.ics">
          Download .ics
        </a>
      ) : null}
    </div>
  );
}
