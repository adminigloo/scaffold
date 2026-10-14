import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { humanizeRoleKey, type TenancyTransport } from "./client.js";
import type { ClientError } from "./http.js";
import {
  ConfirmDialog,
  CopyField,
  describedBy,
  Field,
  formatDate,
  LiveRegion,
  Loading,
  navigate,
  Notice,
  useDateZone,
  WidgetRoot,
  type ChromeProps,
  type NounProps,
} from "./parts.js";
import { normaliseCompanyName } from "./slug.js";
import { isUnconnected, useAnnouncer, useLoaded, useTenancyTransport } from "./transport.js";
import type { InvitationWire, IssuedWire, MemberWire, RoleKey, TeamWire } from "./types.js";
import { errorText, nounOf, NOT_CONNECTED_MESSAGE, TEAM, W, type Noun } from "./words.js";

/**
 * <TeamManager> (contract 8.6): who's in the company, who's been invited, and
 * everything an owner or admin does about it: invite, resend, revoke, change
 * a role, remove, leave, and hand over ownership.
 *
 * THE SERVER DECIDES WHAT MAY BE DONE. Every row carries `actions` computed
 * on the server from the CALLER's role (contract 6.8): which roles they may
 * give this person, whether they may remove them, whether ownership may go to
 * them. The widget renders exactly those and never works out a rank itself,
 * and after every write it asks for the team again, so a control that just
 * stopped being allowed disappears. The server checks again under a lock
 * anyway (decision D7): a page left open across a demotion is refused, and
 * says so in a full-panel notice.
 *
 * EVERY WRITE TOUCHES ONE CONTROL. Only the control pressed is disabled while
 * it saves, the outcome is announced in the one status region, and nothing
 * throws.
 *
 * AND EVERY OUTCOME IS ON SCREEN (review R2 T1BO-04). Removing someone,
 * changing a role, withdrawing an invitation and handing over ownership used
 * to announce only to screen readers: on a phone the card just vanished, and
 * an owner couldn't tell "it worked" from "the page reloaded". Each now leaves
 * a visible line at the top of Members (`data-aitw-done`); focus stays where
 * it was.
 */

export interface TeamManagerProps extends ChromeProps, NounProps {
  baseUrl?: string;
  transport?: TenancyTransport;
  tenantId: string;
  /** Server-rendered, so there is no loading flash. */
  initial?: TeamWire;
  /** Where to go after leaving. Default "/dashboard" (which finds the next company, or onboarding). */
  afterLeaveHref?: string;
}

/** Codes that mean "this page no longer reflects what you may do here": the whole panel says so. */
const BLOCKING = new Set(["not_a_member", "forbidden", "company_suspended", "signed_out"]);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Whitespace-normalised and case-folded: what "matches the name" means for the typed confirmation. */
function sameName(a: string, b: string): boolean {
  return normaliseCompanyName(a).toLowerCase() === normaliseCompanyName(b).toLowerCase();
}

function displayName(member: Pick<MemberWire, "name" | "email">): string {
  return member.name ?? member.email ?? TEAM.someone;
}

type Issued = {
  where: "invite" | string;
  email: string;
  delivery: IssuedWire["delivery"];
  link: string | null;
  replaced: boolean;
  note: string | null;
};
type Confirm =
  | { kind: "remove"; member: MemberWire }
  | { kind: "revoke"; invitation: InvitationWire }
  | { kind: "role"; member: MemberWire; roleKey: RoleKey; promotion: boolean }
  | { kind: "leave" }
  | null;

export function TeamManager(props: TeamManagerProps) {
  const { tenantId, afterLeaveHref = "/dashboard", locale = "en-US", theme, nonce, className, style } = props;
  const noun = nounOf(props.noun);
  const transport = useTenancyTransport(props.transport, props.baseUrl);
  const unconnected = isUnconnected(props.transport, props.baseUrl);
  const team = useLoaded(() => transport.team(tenantId), props.initial, unconnected ? null : tenantId);
  const canInvite = team.data?.you.canInvite === true;
  const invitations = useLoaded(() => transport.invitations(tenantId), undefined, canInvite && !unconnected ? tenantId : null);
  const { status, alert, announce, fail } = useAnnouncer();
  const [blocked, setBlocked] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [pendingRole, setPendingRole] = useState<Record<string, RoleKey>>({});
  const [issued, setIssued] = useState<Issued | null>(null);
  const [seatsFull, setSeatsFull] = useState<{ message: string; upgradeHref: string | null } | null>(null);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  /** The last change that worked, shown on screen (review R2 T1BO-04). */
  const [done, setDone] = useState<string | null>(null);
  const membersHeadingRef = useRef<HTMLHeadingElement | null>(null);
  const dateZone = useDateZone();
  const chrome = { theme, nonce, className, style };

  const loadError = team.error;
  useEffect(() => {
    if (loadError && BLOCKING.has(loadError.code)) setBlocked(errorText(loadError, noun));
  }, [loadError, noun]);

  /** A refusal: the whole panel when the page no longer applies, else one alert. */
  const refuse = (error: ClientError) => {
    const text = errorText(error, noun);
    if (BLOCKING.has(error.code)) setBlocked(text);
    else fail(text);
    return text;
  };

  const refresh = async () => {
    const res = await team.reload();
    if (res && !res.ok && BLOCKING.has(res.error.code)) setBlocked(errorText(res.error, noun));
    if (res?.ok && res.data.you.canInvite) await invitations.reload();
  };

  if (unconnected) {
    return (
      <WidgetRoot {...chrome}>
        <div className="aitw-panel">
          <Notice tone="error">{NOT_CONNECTED_MESSAGE}</Notice>
        </div>
      </WidgetRoot>
    );
  }
  if (blocked) {
    return (
      <WidgetRoot {...chrome} data={{ "aitw-team": "blocked" }}>
        <div className="aitw-panel">
          <Notice tone="error">{blocked}</Notice>
        </div>
      </WidgetRoot>
    );
  }
  const data = team.data;
  if (!data) {
    return (
      <WidgetRoot {...chrome}>
        <div className="aitw-panel">
          {team.loading ? <Loading label={W.loading} /> : <Notice tone="error">{errorText(team.error ?? { code: "bad_response", message: "" }, noun)}</Notice>}
        </div>
      </WidgetRoot>
    );
  }

  const roleName = (key: RoleKey | null): string => {
    if (!key) return W.noRole;
    return data.roles.find((r) => r.key === key)?.name ?? humanizeRoleKey(key);
  };
  const companyName = data.company.name;

  const showIssued = (where: string, result: IssuedWire) => {
    const email = result.invitation.email;
    setIssued({
      where,
      email,
      delivery: result.delivery,
      link: result.delivery === "sent" ? null : result.link,
      replaced: result.replaced,
      note: result.delivery === "held" ? result.note : null,
    });
    if (result.delivery === "held") {
      // Saved, not emailed (review R3 SEC-T1-B): the server's sentence says why and when.
      announce(result.note ?? TEAM.held(email));
      return;
    }
    if (result.delivery === "sent") {
      announce(result.replaced ? `${TEAM.sent(email)} ${TEAM.replaced(email)}` : TEAM.sent(email));
      return;
    }
    announce(result.replaced ? `${TEAM.notEmailed(email)} ${TEAM.earlierLinksWork}` : TEAM.notEmailed(email));
  };

  const rankOf = (key: RoleKey | null): number => (key ? (data.roles.find((r) => r.key === key)?.rank ?? 0) : 0);

  /**
   * A role change from the select. Promoting someone to Admin and every
   * demotion ask first (review T1-08): on a phone a scroll-flick on the select
   * would otherwise hand out invite-and-remove powers, or take them away, in
   * one touch — and the person's own per-person access is cleared either way.
   * A step up below Admin saves at once, as before.
   */
  const pickRole = (member: MemberWire, roleKey: RoleKey) => {
    const from = rankOf(member.roleKey);
    const to = rankOf(roleKey);
    const toAdmin = roleKey === "admin" || to >= rankOf("admin");
    if (to < from || toAdmin) {
      setPendingRole((all) => ({ ...all, [member.userId]: roleKey }));
      setConfirmError(null);
      setConfirm({ kind: "role", member, roleKey, promotion: to > from });
      return;
    }
    void changeRole(member, roleKey);
  };

  const dropPending = (userId: string) =>
    setPendingRole((all) => {
      const next = { ...all };
      delete next[userId];
      return next;
    });

  const issueRefusal = (error: ClientError) => {
    if (error.code === "seats_full") {
      setSeatsFull({ message: errorText(error, noun), upgradeHref: error.upgradeHref ?? null });
      fail(errorText(error, noun));
      return;
    }
    refuse(error);
  };

  const changeRole = async (member: MemberWire, roleKey: RoleKey) => {
    setDone(null);
    setPendingRole((all) => ({ ...all, [member.userId]: roleKey }));
    setBusy(`role:${member.userId}`);
    const res = await transport.changeRole(tenantId, member.userId, { roleKey });
    setBusy(null);
    if (res.ok) {
      const line = TEAM.roleChanged(displayName(member), roleName(res.data.member.roleKey ?? roleKey));
      announce(line);
      setDone(line);
      await refresh();
    } else {
      refuse(res.error);
    }
    // Either way the select shows what the server now says (reverting a refusal).
    dropPending(member.userId);
    return res;
  };

  const resend = async (invitation: InvitationWire) => {
    setDone(null);
    setBusy(`resend:${invitation.id}`);
    setSeatsFull(null);
    const res = await transport.resendInvitation(tenantId, invitation.id);
    setBusy(null);
    if (res.ok) {
      showIssued(`resend:${invitation.id}`, res.data);
      await refresh();
    } else {
      issueRefusal(res.error);
    }
  };

  const runConfirm = async () => {
    if (!confirm) return;
    setConfirmError(null);
    setDone(null);
    if (confirm.kind === "role") {
      const res = await changeRole(confirm.member, confirm.roleKey);
      if (res.ok || BLOCKING.has(res.error.code)) setConfirm(null);
      else setConfirmError(errorText(res.error, noun));
      return;
    }
    if (confirm.kind === "remove") {
      const member = confirm.member;
      setBusy(`remove:${member.userId}`);
      const res = await transport.removeMember(tenantId, member.userId);
      setBusy(null);
      if (!res.ok) {
        if (BLOCKING.has(res.error.code)) {
          setConfirm(null);
          refuse(res.error);
        } else setConfirmError(errorText(res.error, noun));
        return;
      }
      setConfirm(null);
      announce(TEAM.removed(displayName(member)));
      setDone(TEAM.removed(displayName(member)));
      await refresh();
      // The Remove button that opened the dialog is gone with its row: put
      // focus somewhere that still exists, not on the page body.
      setTimeout(() => {
        const active = typeof document !== "undefined" ? document.activeElement : null;
        if (!active || active === document.body || !active.isConnected) membersHeadingRef.current?.focus();
      }, 0);
      return;
    }
    if (confirm.kind === "revoke") {
      const invitation = confirm.invitation;
      setBusy(`revoke:${invitation.id}`);
      const res = await transport.revokeInvitation(tenantId, invitation.id);
      setBusy(null);
      if (!res.ok) {
        if (BLOCKING.has(res.error.code)) {
          setConfirm(null);
          refuse(res.error);
        } else setConfirmError(errorText(res.error, noun));
        return;
      }
      setConfirm(null);
      if (issued?.email === invitation.email) setIssued(null);
      announce(TEAM.revoked(invitation.email));
      setDone(TEAM.revoked(invitation.email));
      await refresh();
      return;
    }
    setBusy("leave");
    const res = await transport.leave(tenantId);
    if (res.ok) {
      announce(TEAM.leaving);
      navigate(afterLeaveHref);
      return;
    }
    setBusy(null);
    if (BLOCKING.has(res.error.code)) {
      setConfirm(null);
      refuse(res.error);
    } else setConfirmError(errorText(res.error, noun));
  };

  const pending = invitations.data?.invitations ?? [];
  const eligible = data.members.filter((m) => m.actions.transferTo);
  const showDanger = data.you.canLeave || data.you.leaveBlocked !== null || data.you.canTransfer;

  return (
    <WidgetRoot {...chrome} data={{ "aitw-team": data.company.id }}>
      <div className="aitw-page">
        {canInvite && data.invitableRoles.length > 0 ? (
          <InviteSection
            data={data}
            roleName={roleName}
            busy={busy === "invite"}
            issued={issued?.where === "invite" ? issued : null}
            seatsFull={seatsFull}
            onInvite={async (email, roleKey) => {
              setDone(null);
              setBusy("invite");
              setSeatsFull(null);
              setIssued(null);
              const res = await transport.invite(tenantId, { email, roleKey });
              setBusy(null);
              if (res.ok) {
                showIssued("invite", res.data);
                await refresh();
                return true;
              }
              if (res.error.code === "invalid" || res.error.code === "already_member") {
                fail(errorText(res.error, noun));
                return errorText(res.error, noun);
              }
              issueRefusal(res.error);
              return false;
            }}
          />
        ) : null}

        <section className="aitw-panel" aria-labelledby={`${data.company.id}-members`}>
          <h2 className="aitw-title" id={`${data.company.id}-members`} ref={membersHeadingRef} tabIndex={-1}>
            {TEAM.membersHeading}
          </h2>
          {done ? (
            <div data-aitw-done="">
              <Notice tone="ok">{done}</Notice>
            </div>
          ) : null}
          <table className="aitw-table" data-stack="640">
            <thead>
              <tr>
                <th scope="col">{TEAM.colName}</th>
                <th scope="col">{TEAM.colRole}</th>
                <th scope="col">{TEAM.colStatus}</th>
                <th scope="col">{TEAM.colJoined}</th>
                <th scope="col">
                  <span className="aitw-sr">{TEAM.colActions}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {data.members.map((member) => (
                <MemberRow
                  key={member.userId}
                  member={member}
                  locale={locale}
                  dateZone={dateZone}
                  roleName={roleName}
                  value={pendingRole[member.userId] ?? member.roleKey}
                  busy={busy === `role:${member.userId}` || busy === `remove:${member.userId}`}
                  onRole={(key) => pickRole(member, key)}
                  onRemove={() => {
                    setConfirmError(null);
                    setConfirm({ kind: "remove", member });
                  }}
                />
              ))}
            </tbody>
          </table>
        </section>

        {canInvite && pending.length > 0 ? (
          <section className="aitw-panel" aria-labelledby={`${data.company.id}-pending`}>
            <h2 className="aitw-title" id={`${data.company.id}-pending`}>
              {TEAM.pendingHeading}
            </h2>
            {issued && issued.where !== "invite" ? <IssuedOutcome issued={issued} /> : null}
            <table className="aitw-table" data-stack="640">
              <thead>
                <tr>
                  <th scope="col">{TEAM.email}</th>
                  <th scope="col">{TEAM.colRole}</th>
                  <th scope="col">{TEAM.colStatus}</th>
                  <th scope="col">
                    <span className="aitw-sr">{TEAM.colActions}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {pending.map((invitation) => (
                  <tr key={invitation.id} data-invitation={invitation.id}>
                    <td data-label={TEAM.email}>
                      {invitation.email}
                      {invitation.wrongAccount ? (
                        // Review R3 T1BO-07: "it doesn't work" is usually "they used their Gmail".
                        <p className="aitw-hint" data-aitw-wrong-account="">
                          {TEAM.wrongAccount(invitation.wrongAccount.signedInAs, formatDate(invitation.wrongAccount.at, locale, dateZone))}
                        </p>
                      ) : null}
                    </td>
                    <td data-label={TEAM.colRole}>{invitation.roleName}</td>
                    <td data-label={TEAM.colStatus}>
                      {invitation.state === "expired" ? (
                        <span className="aitw-tag aitw-tag-warn">{TEAM.expired}</span>
                      ) : (
                        TEAM.expires(formatDate(invitation.expiresAt, locale, dateZone))
                      )}
                    </td>
                    <td data-label="">
                      <div className="aitw-actions">
                        {invitation.canResend ? (
                          <button
                            type="button"
                            className="aitw-btn aitw-btn-secondary aitw-btn-sm"
                            disabled={busy === `resend:${invitation.id}`}
                            aria-busy={busy === `resend:${invitation.id}` || undefined}
                            aria-label={TEAM.resendFor(invitation.email)}
                            onClick={() => void resend(invitation)}
                          >
                            {TEAM.resend}
                          </button>
                        ) : null}
                        {invitation.canRevoke ? (
                          <button
                            type="button"
                            className="aitw-btn aitw-btn-danger-outline aitw-btn-sm"
                            disabled={busy === `revoke:${invitation.id}`}
                            aria-label={TEAM.revokeFor(invitation.email)}
                            onClick={() => {
                              setConfirmError(null);
                              setConfirm({ kind: "revoke", invitation });
                            }}
                          >
                            {TEAM.revoke}
                          </button>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        ) : null}

        {showDanger ? (
          <section className="aitw-panel" aria-labelledby={`${data.company.id}-danger`}>
            <h2 className="aitw-title" id={`${data.company.id}-danger`}>
              {TEAM.dangerHeading}
            </h2>
            {data.you.canLeave ? (
              <div className="aitw-actions">
                <button
                  type="button"
                  className="aitw-btn aitw-btn-danger-outline"
                  disabled={busy === "leave"}
                  onClick={() => {
                    setConfirmError(null);
                    setConfirm({ kind: "leave" });
                  }}
                >
                  {TEAM.leave(companyName)}
                </button>
              </div>
            ) : data.you.leaveBlocked ? (
              <p className="aitw-sub" data-aitw-leave-blocked="">
                {data.you.leaveBlocked}
              </p>
            ) : null}
            {data.you.canTransfer && eligible.length > 0 ? (
              <TransferForm
                companyName={companyName}
                eligible={eligible}
                busy={busy === "transfer"}
                onTransfer={async (toUserId, confirmName) => {
                  setDone(null);
                  setBusy("transfer");
                  const res = await transport.transfer(tenantId, { toUserId, confirmName });
                  setBusy(null);
                  if (res.ok) {
                    team.set(res.data);
                    const newOwner = eligible.find((m) => m.userId === toUserId);
                    announce(TEAM.transferred(newOwner ? displayName(newOwner) : TEAM.someone));
                    setDone(TEAM.transferred(newOwner ? displayName(newOwner) : TEAM.someone));
                    await refresh();
                    return null;
                  }
                  if (res.error.code === "confirmation_mismatch") return errorText(res.error, noun);
                  refuse(res.error);
                  return null;
                }}
              />
            ) : data.you.canTransfer ? (
              // An owner alone on the team is told to hand ownership over
              // before leaving; say how, instead of showing no control at all
              // (review T1-16).
              <p className="aitw-sub" data-aitw-transfer-hint="">
                {TEAM.transferNeedsSomeone(companyName)}
              </p>
            ) : null}
          </section>
        ) : null}

        <LiveRegion status={status} alert={alert} srOnly="status" />
      </div>

      {confirm?.kind === "remove" ? (
        <ConfirmDialog
          title={TEAM.removeTitle(displayName(confirm.member), companyName)}
          body={TEAM.removeBody}
          confirmLabel={TEAM.removeFor(displayName(confirm.member))}
          busy={busy === `remove:${confirm.member.userId}`}
          error={confirmError}
          onConfirm={() => void runConfirm()}
          onCancel={() => setConfirm(null)}
        />
      ) : null}
      {confirm?.kind === "role" ? (
        <ConfirmDialog
          title={TEAM.roleTitle(displayName(confirm.member), roleName(confirm.roleKey))}
          body={TEAM.roleBody(
            displayName(confirm.member),
            data.roles.find((r) => r.key === confirm.roleKey)?.description ?? "",
          )}
          confirmLabel={TEAM.roleConfirm(roleName(confirm.roleKey))}
          tone={confirm.promotion ? "primary" : "danger"}
          busy={busy === `role:${confirm.member.userId}`}
          error={confirmError}
          onConfirm={() => void runConfirm()}
          onCancel={() => {
            dropPending(confirm.member.userId);
            setConfirm(null);
          }}
        />
      ) : null}
      {confirm?.kind === "revoke" ? (
        <ConfirmDialog
          title={TEAM.revokeTitle(confirm.invitation.email)}
          body={TEAM.revokeBody}
          confirmLabel={TEAM.revokeConfirm}
          busy={busy === `revoke:${confirm.invitation.id}`}
          error={confirmError}
          onConfirm={() => void runConfirm()}
          onCancel={() => setConfirm(null)}
        />
      ) : null}
      {confirm?.kind === "leave" ? (
        <ConfirmDialog
          title={TEAM.leaveTitle(companyName)}
          body={TEAM.leaveBody}
          confirmLabel={TEAM.leave(companyName)}
          busy={busy === "leave"}
          error={confirmError}
          onConfirm={() => void runConfirm()}
          onCancel={() => setConfirm(null)}
        />
      ) : null}
    </WidgetRoot>
  );
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

function IssuedOutcome({ issued }: { issued: Issued }) {
  // Re-sending (or re-inviting at a different role) replaces the open
  // invitation; say so, so nobody wonders which email to use (review T1-06).
  if (issued.delivery === "sent") {
    return (
      <div className="aitw-stack-sm" data-aitw-issued="sent">
        <Notice tone="ok">{TEAM.sent(issued.email)}</Notice>
        {issued.replaced ? <p className="aitw-hint" data-aitw-replaced="">{TEAM.replaced(issued.email)}</p> : null}
      </div>
    );
  }
  if (issued.delivery === "held") {
    // Saved, but this address was emailed too recently or too often (review
    // R3 SEC-T1-B). Never "We couldn't email": nothing failed, and the
    // server's sentence says when it can be emailed again.
    return (
      <div className="aitw-stack-sm" data-aitw-issued="held">
        <Notice tone="info">{issued.note ?? TEAM.held(issued.email)}</Notice>
        {issued.link ? <CopyField label={TEAM.linkLabel} value={issued.link} /> : null}
      </div>
    );
  }
  // Not emailed: "a new email went" would be untrue, so only the earlier links' half is said.
  return (
    <div className="aitw-stack-sm" data-aitw-issued="">
      <Notice tone="info">{TEAM.notEmailed(issued.email)}</Notice>
      {issued.link ? <CopyField label={TEAM.linkLabel} value={issued.link} /> : null}
      {issued.replaced ? <p className="aitw-hint" data-aitw-replaced="">{TEAM.earlierLinksWork}</p> : null}
    </div>
  );
}

function InviteSection({
  data,
  roleName,
  busy,
  issued,
  seatsFull,
  onInvite,
}: {
  data: TeamWire;
  roleName: (key: RoleKey | null) => string;
  busy: boolean;
  issued: Issued | null;
  seatsFull: { message: string; upgradeHref: string | null } | null;
  onInvite: (email: string, roleKey: RoleKey) => Promise<boolean | string>;
}) {
  const emailId = useId();
  const roleId = useId();
  const headingId = useId();
  const [email, setEmail] = useState("");
  const [roleKey, setRoleKey] = useState<RoleKey>(
    data.invitableRoles.includes("member") ? "member" : (data.invitableRoles[0] as RoleKey),
  );
  const [emailError, setEmailError] = useState<string | null>(null);
  const role = data.invitableRoles.includes(roleKey) ? roleKey : (data.invitableRoles[0] as RoleKey);
  const description = data.roles.find((r) => r.key === role)?.description ?? "";

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    const address = email.trim();
    if (!EMAIL_RE.test(address)) {
      setEmailError(TEAM.emailInvalid);
      return;
    }
    setEmailError(null);
    const result = await onInvite(address, role);
    if (result === true) setEmail("");
    else if (typeof result === "string") setEmailError(result);
  };

  return (
    <section className="aitw-panel" aria-labelledby={headingId} data-aitw-invite="">
      <div className="aitw-head">
        <h2 className="aitw-title" id={headingId}>
          {TEAM.inviteHeading}
        </h2>
        {data.seats ? (
          <p className="aitw-sub" data-aitw-seats="">
            {TEAM.seats(data.seats.used + data.seats.pending, data.seats.limit)}
          </p>
        ) : null}
      </div>
      <form className="aitw-form" onSubmit={(event) => void submit(event)} noValidate>
        <div className="aitw-fields">
          <Field id={emailId} label={TEAM.email} error={emailError} width="half">
            <input
              id={emailId}
              className="aitw-input"
              type="email"
              autoComplete="off"
              inputMode="email"
              spellCheck={false}
              maxLength={254}
              value={email}
              aria-invalid={emailError ? true : undefined}
              aria-describedby={describedBy(emailId, false, emailError)}
              onChange={(event) => {
                setEmail(event.target.value);
                if (emailError) setEmailError(null);
              }}
            />
          </Field>
          <Field id={roleId} label={TEAM.role} hint={description || undefined} width="half">
            <select
              id={roleId}
              className="aitw-input"
              value={role}
              aria-describedby={describedBy(roleId, Boolean(description), null)}
              onChange={(event) => setRoleKey(event.target.value as RoleKey)}
            >
              {data.invitableRoles.map((key) => (
                <option key={key} value={key}>
                  {roleName(key)}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <div className="aitw-actions">
          <button type="submit" className="aitw-btn aitw-btn-primary" disabled={busy} aria-busy={busy || undefined}>
            {busy ? TEAM.sending : TEAM.send}
          </button>
        </div>
      </form>
      {issued ? <IssuedOutcome issued={issued} /> : null}
      {seatsFull ? (
        <Notice tone="warn">
          {seatsFull.message}{" "}
          {seatsFull.upgradeHref ? (
            <a href={seatsFull.upgradeHref} data-aitw-upgrade="">
              {TEAM.upgrade}
            </a>
          ) : null}
        </Notice>
      ) : null}
    </section>
  );
}

function MemberRow({
  member,
  locale,
  dateZone,
  roleName,
  value,
  busy,
  onRole,
  onRemove,
}: {
  member: MemberWire;
  locale: string;
  dateZone: string | undefined;
  roleName: (key: RoleKey | null) => string;
  value: RoleKey | null;
  busy: boolean;
  onRole: (key: RoleKey) => void;
  onRemove: () => void;
}) {
  const selectId = useId();
  const name = displayName(member);
  const options: (RoleKey | null)[] = [member.roleKey, ...member.actions.roles.filter((k) => k !== member.roleKey)];
  return (
    <tr data-member={member.userId} data-busy={busy ? "" : undefined}>
      <td data-label={TEAM.colName}>
        <div className="aitw-cell-main">
          <span className="aitw-row">
            <span>
              {name}
              {member.isYou ? ` ${W.you}` : ""}
            </span>
            {member.isOwner ? <span className="aitw-tag aitw-tag-accent">{W.owner}</span> : null}
          </span>
          {member.name && member.email ? <span className="aitw-cell-sub">{member.email}</span> : null}
        </div>
      </td>
      <td data-label={TEAM.colRole}>
        {member.actions.roles.length > 0 ? (
          <>
            <label className="aitw-sr" htmlFor={selectId}>
              {TEAM.roleFor(name)}
            </label>
            <select
              id={selectId}
              className="aitw-input"
              value={value ?? ""}
              disabled={busy}
              aria-busy={busy || undefined}
              onChange={(event) => {
                const next = event.target.value as RoleKey;
                if (next && next !== member.roleKey) onRole(next);
              }}
            >
              {options.map((key) => (
                <option key={key ?? "none"} value={key ?? ""} disabled={key === null}>
                  {member.roleKey === key ? member.roleName : roleName(key)}
                </option>
              ))}
            </select>
          </>
        ) : (
          member.roleName
        )}
      </td>
      <td data-label={TEAM.colStatus}>{member.status === "active" ? W.active : W.accountClosed}</td>
      <td data-label={TEAM.colJoined}>{formatDate(member.joinedAt, locale, dateZone)}</td>
      <td data-label="">
        {member.actions.remove ? (
          <button type="button" className="aitw-btn aitw-btn-danger-outline aitw-btn-sm" disabled={busy} onClick={onRemove}>
            {TEAM.remove}
            <span className="aitw-sr"> {name}</span>
          </button>
        ) : null}
      </td>
    </tr>
  );
}

function TransferForm({
  companyName,
  eligible,
  busy,
  onTransfer,
}: {
  companyName: string;
  eligible: MemberWire[];
  busy: boolean;
  onTransfer: (toUserId: string, confirmName: string) => Promise<string | null>;
}) {
  const ownerId = useId();
  const confirmId = useId();
  const headingId = useId();
  const [to, setTo] = useState("");
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<string | null>(null);
  const chosen = eligible.find((m) => m.userId === to) ?? null;
  const matches = sameName(typed, companyName);
  const ready = chosen !== null && matches && !busy;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!ready || !chosen) return;
    setError(null);
    const problem = await onTransfer(chosen.userId, typed);
    if (problem) setError(problem);
    else {
      setTo("");
      setTyped("");
    }
  };

  return (
    <form className="aitw-form" onSubmit={(event) => void submit(event)} aria-labelledby={headingId} noValidate data-aitw-transfer="">
      <h3 className="aitw-h3" id={headingId}>
        {TEAM.transferHeading}
      </h3>
      <div className="aitw-fields">
        <Field id={ownerId} label={TEAM.newOwner} width="half">
          <select id={ownerId} className="aitw-input" value={to} onChange={(event) => setTo(event.target.value)}>
            <option value="">{TEAM.chooseNewOwner}</option>
            {eligible.map((m) => (
              <option key={m.userId} value={m.userId}>
                {displayName(m)}
              </option>
            ))}
          </select>
        </Field>
        <Field id={confirmId} label={TEAM.typeToConfirm(companyName)} error={error} width="half">
          <input
            id={confirmId}
            className="aitw-input"
            type="text"
            autoComplete="off"
            spellCheck={false}
            value={typed}
            aria-invalid={error ? true : undefined}
            aria-describedby={describedBy(confirmId, false, error)}
            onChange={(event) => {
              setTyped(event.target.value);
              if (error) setError(null);
            }}
          />
        </Field>
      </div>
      {chosen ? <p className="aitw-sub">{TEAM.transferExplain(displayName(chosen))}</p> : null}
      <div className="aitw-actions">
        <button type="submit" className="aitw-btn aitw-btn-danger" disabled={!ready} aria-busy={busy || undefined}>
          {busy ? TEAM.transferring : TEAM.transfer}
        </button>
      </div>
    </form>
  );
}
