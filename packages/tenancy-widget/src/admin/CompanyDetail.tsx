import { useId, useState, type FormEvent } from "react";
import {
  ConfirmDialog,
  describedBy,
  Dialog,
  Field,
  formatDate,
  formatDateTime,
  LiveRegion,
  Loading,
  Notice,
  type ChromeProps,
  type NounProps,
} from "../parts.js";
import { isUnconnected, useAnnouncer, useLoaded } from "../transport.js";
import { zoneLabel } from "../timezones.js";
import type { PersonRefWire } from "../types.js";
import { DETAIL, errorText, nounOf, NOT_CONNECTED_MESSAGE, TEAM, W } from "../words.js";
import type { TenancyAdminTransport } from "./client.js";
import { AdminRoot, useAdminTransport } from "./ui.js";

/**
 * <CompanyDetail> (contract 8.11): one company, for the platform's staff:
 * who's in it, when and by whom it was made, what's happened lately, and the
 * one lever staff hold over it in Tenancy 1: suspend and reactivate.
 *
 * SUSPENDING ASKS WHY. The reason is required and shown only to staff (the
 * company's people see "contact support", never the note), so the next
 * operator who opens this page knows what happened without asking around.
 *
 * Every write re-renders from the server's answer: what the page shows after
 * a suspension is what the database now says, not what the button hoped.
 */

export interface CompanyDetailProps extends ChromeProps, NounProps {
  baseUrl?: string;
  transport?: TenancyAdminTransport;
  tenantId: string;
  /** Default "/admin/companies". */
  backHref?: string;
}

const REASON_MIN = 3;
const REASON_MAX = 500;

function who(person: PersonRefWire | null): string {
  return person?.name ?? person?.email ?? DETAIL.someone;
}

export function CompanyDetail(props: CompanyDetailProps) {
  const { tenantId, backHref = "/admin/companies", locale = "en-US", theme, nonce, className, style } = props;
  const noun = nounOf(props.noun);
  const transport = useAdminTransport(props.transport, props.baseUrl);
  const unconnected = isUnconnected(props.transport, props.baseUrl);
  const detail = useLoaded(() => transport.company(tenantId), undefined, unconnected ? null : tenantId);
  const { status, alert, announce, fail } = useAnnouncer();
  const [dialog, setDialog] = useState<"suspend" | "reactivate" | "owner" | "release" | null>(null);
  const [newOwner, setNewOwner] = useState("");
  const ownerSelectId = useId();
  const [reason, setReason] = useState("");
  const [reasonError, setReasonError] = useState<string | null>(null);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const reasonId = useId();
  const warningId = useId();
  const headingId = useId();
  const chrome = { theme, nonce, className, style };

  if (unconnected) {
    return (
      <AdminRoot {...chrome}>
        <div className="aitw-panel">
          <Notice tone="error">{NOT_CONNECTED_MESSAGE}</Notice>
        </div>
      </AdminRoot>
    );
  }
  const data = detail.data;
  // A button-shaped link: 44px tall, the way every target is below 640px
  // (contract 8.13; the plain link was 22px, review T1-15).
  const back = (
    <a href={backHref} className="aitw-btn aitw-btn-link aitw-back" data-aitw-back="">
      {DETAIL.back(noun)}
    </a>
  );
  if (!data) {
    return (
      <AdminRoot {...chrome}>
        <div className="aitw-panel">
          {back}
          {detail.loading ? <Loading label={DETAIL.loading(noun)} /> : <Notice tone="error">{errorText(detail.error ?? { code: "bad_response", message: "" }, noun)}</Notice>}
        </div>
      </AdminRoot>
    );
  }
  const company = data.company;
  const suspended = company.status === "suspended";

  const suspend = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    const text = reason.trim();
    if (text.length < REASON_MIN || text.length > REASON_MAX) {
      setReasonError(DETAIL.reasonShort);
      return;
    }
    setReasonError(null);
    setDialogError(null);
    setBusy(true);
    const res = await transport.suspend(tenantId, { reason: text });
    setBusy(false);
    if (res.ok) {
      detail.set(res.data);
      setDialog(null);
      setReason("");
      announce(DETAIL.suspendedDone(company.name));
    } else {
      const issue = res.error.issues?.find((i) => i.path[0] === "reason");
      if (issue) setReasonError(issue.message);
      else setDialogError(errorText(res.error, noun));
    }
  };

  const reactivate = async () => {
    if (busy) return;
    setDialogError(null);
    setBusy(true);
    const res = await transport.reactivate(tenantId);
    setBusy(false);
    if (res.ok) {
      detail.set(res.data);
      setDialog(null);
      announce(DETAIL.reactivated(company.name));
    } else setDialogError(errorText(res.error, noun));
  };

  // Who can be made the owner: an active member who isn't the owner already.
  const candidates = data.members.filter((m) => m.status === "active" && !m.isOwner);
  const chosenOwner = candidates.find((m) => m.userId === newOwner) ?? null;

  const assignOwner = async () => {
    if (busy || !chosenOwner) return;
    setDialogError(null);
    setBusy(true);
    const res = await transport.assignOwner(tenantId, { toUserId: chosenOwner.userId });
    setBusy(false);
    if (res.ok) {
      detail.set(res.data);
      setDialog(null);
      setNewOwner("");
      announce(DETAIL.ownerChanged(chosenOwner.name ?? chosenOwner.email ?? DETAIL.someone, company.name));
    } else setDialogError(errorText(res.error, noun));
  };

  const release = async () => {
    if (busy) return;
    setDialogError(null);
    setBusy(true);
    const res = await transport.releaseAddresses(tenantId);
    setBusy(false);
    if (res.ok) {
      detail.set(res.data);
      setDialog(null);
      announce(DETAIL.released);
    } else setDialogError(errorText(res.error, noun));
  };

  const owner = company.owner;
  const fact = (label: string, value: string | null) => (
    <>
      <dt>{label}</dt>
      <dd>{value && value !== "" ? value : <span className="aitw-muted">{DETAIL.notSet}</span>}</dd>
    </>
  );

  return (
    <AdminRoot {...chrome} data={{ "aitw-detail": company.id }}>
      <div className="aitw-page">
        <section className="aitw-panel" aria-labelledby={headingId}>
          {back}
          <div className="aitw-detail-head">
            <h2 className="aitw-title" id={headingId}>
              {company.name}
            </h2>
            {suspended ? <span className="aitw-tag aitw-tag-warn">{W.suspended}</span> : <span className="aitw-tag aitw-tag-ok">{W.active}</span>}
          </div>
          <p className="aitw-sub">{company.publicPath}</p>

          {suspended ? (
            <Notice tone="warn">
              <span data-aitw-suspension="">
                {DETAIL.suspendedLine(formatDate(company.suspendedAt, locale), who(company.suspendedBy), company.suspendedReason ?? "")}
              </span>
            </Notice>
          ) : null}

          {data.can.suspend ? (
            <div className="aitw-actions">
              {suspended ? (
                <button
                  type="button"
                  className="aitw-btn aitw-btn-primary"
                  onClick={() => {
                    setDialogError(null);
                    setDialog("reactivate");
                  }}
                >
                  {DETAIL.reactivate}
                </button>
              ) : (
                <button
                  type="button"
                  className="aitw-btn aitw-btn-danger-outline"
                  onClick={() => {
                    setDialogError(null);
                    setReasonError(null);
                    setDialog("suspend");
                  }}
                >
                  {DETAIL.suspend(noun)}
                </button>
              )}
            </div>
          ) : null}

          <h3 className="aitw-h3">{DETAIL.facts}</h3>
          <dl className="aitw-kv">
            {fact(DETAIL.created, company.createdBy ? DETAIL.createdBy(formatDate(company.createdAt, locale), who(company.createdBy)) : formatDate(company.createdAt, locale))}
            <dt>{DETAIL.owner}</dt>
            <dd data-aitw-owner="">
              {owner ? (owner.email ?? owner.name ?? DETAIL.someone) : <span className="aitw-muted">{DETAIL.notSet}</span>}
              {/* The words never promise a control the page doesn't have (review T1-03). */}
              {company.ownerDeleted ? ` ${data.can.assignOwner ? DETAIL.ownerClosed : DETAIL.ownerClosedNoControl}` : ""}
              {data.can.assignOwner && candidates.length > 0 ? (
                <div className="aitw-actions">
                  <button
                    type="button"
                    className="aitw-btn aitw-btn-secondary aitw-btn-sm"
                    data-aitw-change-owner=""
                    onClick={() => {
                      setDialogError(null);
                      setNewOwner("");
                      setDialog("owner");
                    }}
                  >
                    {DETAIL.changeOwner}
                  </button>
                </div>
              ) : null}
            </dd>
            {fact(DETAIL.timeZone, company.timeZone ? zoneLabel(company.timeZone) : null)}
            {fact(DETAIL.contactEmail, company.contactEmail)}
            {fact(DETAIL.contactPhone, company.contactPhone)}
            <dt>{DETAIL.pending}</dt>
            {/* Who, as what, from whom (review R2 T1BO-09): "I'm Carl and I can't
                get in" needs the address the invitation went to. */}
            <dd data-aitw-invitations="">
              {data.invitations.length === 0 ? (
                <span className="aitw-muted">{DETAIL.noPending}</span>
              ) : (
                <ul className="aitw-plain-list">
                  {data.invitations.map((invitation) => (
                    <li key={`${invitation.email}-${invitation.expiresAt ?? ""}`}>
                      {DETAIL.invitedLine(invitation.email, invitation.roleName, invitation.invitedBy)}
                    </li>
                  ))}
                </ul>
              )}
            </dd>
            {data.retiredAddresses.length > 0 ? (
              <>
                <dt>{DETAIL.oldAddresses}</dt>
                <dd data-aitw-old-addresses="">
                  {data.retiredAddresses.map((slug) => `/t/${slug}`).join(", ")}
                  {data.can.releaseAddresses ? (
                    <div className="aitw-actions">
                      <button
                        type="button"
                        className="aitw-btn aitw-btn-secondary aitw-btn-sm"
                        onClick={() => {
                          setDialogError(null);
                          setDialog("release");
                        }}
                      >
                        {company.status === "suspended" ? DETAIL.releaseAll : DETAIL.release}
                      </button>
                    </div>
                  ) : null}
                </dd>
              </>
            ) : company.status === "suspended" && data.can.releaseAddresses && company.kind === "org" ? (
              // A suspended squatter with no old addresses still holds its
              // current one (review R2 SEC-T1-C): staff can free it here.
              <>
                <dt>{DETAIL.webAddress}</dt>
                <dd data-aitw-current-address="">
                  {`/t/${company.slug}`}
                  <div className="aitw-actions">
                    <button
                      type="button"
                      className="aitw-btn aitw-btn-secondary aitw-btn-sm"
                      onClick={() => {
                        setDialogError(null);
                        setDialog("release");
                      }}
                    >
                      {DETAIL.releaseAll}
                    </button>
                  </div>
                </dd>
              </>
            ) : null}
          </dl>
        </section>

        <section className="aitw-panel" aria-labelledby={`${headingId}-members`}>
          <h2 className="aitw-title" id={`${headingId}-members`}>
            {DETAIL.members}
          </h2>
          <table className="aitw-table" data-stack="768">
            <thead>
              <tr>
                <th scope="col">{TEAM.colName}</th>
                <th scope="col">{DETAIL.colEmail}</th>
                <th scope="col">{TEAM.colRole}</th>
                <th scope="col">{TEAM.colStatus}</th>
                <th scope="col">{TEAM.colJoined}</th>
              </tr>
            </thead>
            <tbody>
              {data.members.map((member) => (
                <tr key={member.userId} data-member={member.userId}>
                  <td data-label={TEAM.colName}>
                    <span className="aitw-row">
                      <span>{member.name ?? member.email ?? DETAIL.someone}</span>
                      {member.isOwner ? <span className="aitw-tag aitw-tag-accent">{W.owner}</span> : null}
                    </span>
                  </td>
                  <td data-label={DETAIL.colEmail}>{member.email ?? ""}</td>
                  <td data-label={TEAM.colRole}>{member.roleName}</td>
                  <td data-label={TEAM.colStatus}>{member.status === "active" ? W.active : W.accountClosed}</td>
                  <td data-label={TEAM.colJoined}>{formatDate(member.joinedAt, locale)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <section className="aitw-panel" aria-labelledby={`${headingId}-activity`}>
          <h2 className="aitw-title" id={`${headingId}-activity`}>
            {DETAIL.activity}
          </h2>
          {data.activity === null ? (
            <p className="aitw-sub" data-aitw-activity="off">
              {DETAIL.activityOff}
            </p>
          ) : data.activity.length === 0 ? (
            <p className="aitw-sub">{DETAIL.activityNone}</p>
          ) : (
            <ul className="aitw-activity" data-aitw-activity="">
              {data.activity.map((line, index) => (
                <li key={`${line.at}-${index}`}>
                  {/* With the time of day, and what it was about (review
                      T1-17): "Changed a member's role" alone can't answer
                      "who removed me, and when?". */}
                  <time dateTime={line.at}>{formatDateTime(line.at, locale)}</time>
                  <span aria-hidden="true">·</span>
                  <span>{line.actor ?? DETAIL.someone}</span>
                  <span aria-hidden="true">·</span>
                  <span>{line.label}</span>
                  {line.detail ? (
                    <span className="aitw-muted" data-aitw-detail="">
                      ({line.detail})
                    </span>
                  ) : null}
                  {/* A change of who holds access, said plainly and not in alarm yellow (review R2 T1BO-10). */}
                  {line.sensitive ? <span className="aitw-tag" data-aitw-access-change="">{W.sensitive}</span> : null}
                </li>
              ))}
            </ul>
          )}
        </section>
        <LiveRegion status={status} alert={alert} />
      </div>

      {dialog === "suspend" ? (
        <Dialog title={DETAIL.suspendTitle(company.name)} onClose={() => setDialog(null)} describedBy={warningId} data={{ "aitw-suspend": "" }}>
          <form className="aitw-form" onSubmit={(event) => void suspend(event)} noValidate>
            <p id={warningId}>{DETAIL.suspendWarning(company.name)}</p>
            <Field id={reasonId} label={DETAIL.reason} hint={DETAIL.reasonHint} error={reasonError}>
              <textarea
                id={reasonId}
                className="aitw-input"
                required
                maxLength={REASON_MAX}
                value={reason}
                aria-invalid={reasonError ? true : undefined}
                aria-describedby={describedBy(reasonId, true, reasonError)}
                onChange={(event) => {
                  setReason(event.target.value);
                  if (reasonError) setReasonError(null);
                }}
              />
            </Field>
            {dialogError ? (
              <p className="aitw-danger-text" role="alert">
                {dialogError}
              </p>
            ) : null}
            <div className="aitw-dialog-actions">
              <button type="button" className="aitw-btn aitw-btn-secondary" onClick={() => setDialog(null)}>
                {W.cancel}
              </button>
              <button type="submit" className="aitw-btn aitw-btn-danger" disabled={busy} aria-busy={busy || undefined}>
                {DETAIL.suspendConfirm}
              </button>
            </div>
          </form>
        </Dialog>
      ) : null}
      {dialog === "owner" ? (
        <ConfirmDialog
          title={DETAIL.changeOwnerTitle(company.name)}
          body={chosenOwner ? DETAIL.changeOwnerBody(chosenOwner.name ?? chosenOwner.email ?? DETAIL.someone) : DETAIL.changeOwnerPick}
          confirmLabel={DETAIL.changeOwnerConfirm}
          tone="primary"
          busy={busy}
          confirmDisabled={chosenOwner === null}
          error={dialogError}
          onConfirm={() => void assignOwner()}
          onCancel={() => setDialog(null)}
        >
          <Field id={ownerSelectId} label={DETAIL.newOwner}>
            <select id={ownerSelectId} className="aitw-input" value={newOwner} onChange={(event) => setNewOwner(event.target.value)}>
              <option value="">{TEAM.chooseNewOwner}</option>
              {candidates.map((m) => (
                <option key={m.userId} value={m.userId}>
                  {m.name ?? m.email ?? DETAIL.someone}
                  {m.name && m.email ? ` (${m.email})` : ""}
                </option>
              ))}
            </select>
          </Field>
        </ConfirmDialog>
      ) : null}
      {dialog === "release" ? (
        <ConfirmDialog
          title={company.status === "suspended" ? DETAIL.releaseAllTitle(company.slug) : DETAIL.releaseTitle(data.retiredAddresses.length)}
          body={company.status === "suspended" ? DETAIL.releaseAllBody(company.name, company.slug) : DETAIL.releaseBody(company.name)}
          confirmLabel={company.status === "suspended" ? DETAIL.releaseAll : DETAIL.release}
          busy={busy}
          error={dialogError}
          onConfirm={() => void release()}
          onCancel={() => setDialog(null)}
        />
      ) : null}
      {dialog === "reactivate" ? (
        <ConfirmDialog
          title={DETAIL.reactivateTitle(company.name)}
          body={DETAIL.reactivateBody(company.name)}
          confirmLabel={DETAIL.reactivate}
          tone="primary"
          busy={busy}
          error={dialogError}
          onConfirm={() => void reactivate()}
          onCancel={() => setDialog(null)}
        />
      ) : null}
    </AdminRoot>
  );
}
