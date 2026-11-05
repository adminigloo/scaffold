import { useEffect, useId, useState } from "react";
import { ConfirmDialog, formatDate, LiveRegion, Loading, Notice, type ChromeProps, type NounProps } from "../parts.js";
import { isUnconnected, useAnnouncer, useLoaded } from "../transport.js";
import type { AdminPeopleWire, AdminPersonWire, StaffInvitationWire, StaffRoleWire } from "../types.js";
import { CONSOLE, errorText, nounOf, NOT_CONNECTED_MESSAGE, PEOPLE, W, type Noun } from "../words.js";
import type { TenancyAdminTransport } from "./client.js";
import { AdminRoot, pageParam, Pager, readSearch, useAdminTransport, writeSearch } from "./ui.js";

/**
 * <StaffPeople> (contract 8.12): everyone with an account, and who is staff
 * at what level. This is where the platform's first administrator hires the
 * rest (PC-04: before 0.22 a staff role needed SQL).
 *
 * THE SERVER SAYS WHO MAY CHANGE WHOM. Each row's `canChange` and each role's
 * `assignable` come from the caller's own rank (contract 6.11); the select is
 * disabled with the reason in words ("You can't change your own role."), not
 * a silent grey box. The server checks again, and refuses removing the last
 * administrator.
 *
 * GIVING A ROLE ASKS FIRST. A staff role opens staff screens; the dialog says
 * so before it's given.
 *
 * INVITING AND NAMES (tenancy 0.9). Invite gives an address a staff role it
 * takes up at its first sign-in (an address with an account gets it at once);
 * the invitations still waiting are listed with Withdraw. When no email went,
 * the screen shows the sign-up link to pass on. Edit name changes your own
 * name, or anyone's for someone who can manage roles.
 */

export interface StaffPeopleProps extends ChromeProps, NounProps {
  baseUrl?: string;
  transport?: TenancyAdminTransport;
  /**
   * The companies console's address (default "/admin/companies"). A person's
   * company count links there, searched by their email (review R2 T1BO-09),
   * which finds the companies they're a member of, not only the ones they own.
   * null leaves the count as plain text.
   */
  companiesHref?: string | null;
  /** Default 25. */
  pageSize?: number;
}

type Pending = { person: AdminPersonWire; templateKey: string | null; roleName: string | null } | null;

function label(person: AdminPersonWire): string {
  return person.email ?? person.name ?? PEOPLE.thisPerson;
}

export function StaffPeople(props: StaffPeopleProps) {
  const { pageSize = 25, companiesHref = "/admin/companies", locale = "en-US", theme, nonce, className, style } = props;
  // CONTRACT: the contract's props omit `noun`, but the "{plural} count"
  // column needs it; an optional `noun` (default company / companies) is added.
  const noun = nounOf(props.noun);
  const transport = useAdminTransport(props.transport, props.baseUrl);
  const unconnected = isUnconnected(props.transport, props.baseUrl);
  const searchId = useId();
  const { status, alert, announce, fail } = useAnnouncer();

  const [hydrated, setHydrated] = useState(false);
  const [text, setText] = useState("");
  const [q, setQ] = useState("");
  const [staffOnly, setStaffOnly] = useState(false);
  const [page, setPage] = useState(1);
  const [pending, setPending] = useState<Pending>(null);
  const [busy, setBusy] = useState(false);
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    const params = readSearch();
    if (params) {
      const fromUrl = (params.get("q") ?? "").trim();
      setText(fromUrl);
      setQ(fromUrl);
      setStaffOnly(params.get("staffOnly") === "true");
      setPage(pageParam(params.get("page")));
    }
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    const next = text.trim();
    if (next === q) return;
    const timer = setTimeout(() => {
      setQ(next);
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [text, q, hydrated]);

  useEffect(() => {
    if (!hydrated) return;
    writeSearch({ q, staffOnly: staffOnly ? "true" : "", page }, { q: "", staffOnly: "", page: 1 });
  }, [hydrated, q, staffOnly, page]);

  const key = hydrated && !unconnected ? JSON.stringify({ q, staffOnly, page, pageSize }) : null;
  const list = useLoaded(() => transport.people({ ...(q ? { q } : {}), ...(staffOnly ? { staffOnly } : {}), page, pageSize }), undefined, key);
  const invitations = useLoaded(() => transport.staffInvitations(), undefined, hydrated && !unconnected ? "staff-invitations" : null);
  const inviteEmailId = useId();
  const inviteRoleId = useId();
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState("");
  const [inviting, setInviting] = useState(false);
  const [inviteNote, setInviteNote] = useState<{ tone: "ok" | "warn" | "error"; text: string; link?: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [naming, setNaming] = useState<{ userId: string; first: string; last: string } | null>(null);
  const [renaming, setRenaming] = useState(false);

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
  const data = list.data;
  const assignable = data ? data.roles.filter((r) => r.assignable) : [];
  // The lowest role by default: the least a slip of the hand can give.
  const chosenRole = inviteRole || assignable[assignable.length - 1]?.key || "";

  const sendInvite = async () => {
    const email = inviteEmail.trim();
    if (inviting || !email || !chosenRole) return;
    setInviting(true);
    setInviteNote(null);
    setCopied(false);
    const res = await transport.inviteStaff({ email, templateKey: chosenRole });
    setInviting(false);
    if (!res.ok) {
      const text = errorText(res.error, noun);
      setInviteNote({ tone: "error", text });
      fail(text);
      return;
    }
    setInviteEmail("");
    const result = res.data;
    if (result.result === "granted") {
      const person = result.person;
      if (data) list.set({ ...data, people: data.people.map((p) => (p.userId === person.userId ? person : p)) });
      const text = PEOPLE.granted(email, person.staffRole?.name ?? "");
      setInviteNote({ tone: "ok", text });
      announce(text);
      return;
    }
    void invitations.reload();
    const role = result.invitation.role.name;
    const text =
      result.email === "sent"
        ? PEOPLE.inviteSent(email, role)
        : result.email === "cooldown"
          ? PEOPLE.inviteCooldown(email, role)
          : PEOPLE.inviteUnsent(email, role, result.email === "failed");
    const link = result.email === "skipped" || result.email === "failed" ? result.signUpUrl : null;
    setInviteNote({ tone: result.email === "sent" ? "ok" : "warn", text, ...(link ? { link } : {}) });
    announce(text);
  };

  const copyLink = async (link: string) => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  const withdraw = async (invitation: StaffInvitationWire) => {
    const res = await transport.revokeStaffInvitation(invitation.id);
    if (res.ok) {
      if (invitations.data) invitations.set({ invitations: invitations.data.invitations.filter((i) => i.id !== invitation.id) });
      announce(PEOPLE.withdrawn(invitation.email));
    } else {
      fail(errorText(res.error, noun));
    }
  };

  const saveName = async () => {
    if (!naming || renaming || !data) return;
    if (!naming.first.trim() && !naming.last.trim()) {
      setRowErrors((all) => ({ ...all, [naming.userId]: PEOPLE.needName }));
      fail(PEOPLE.needName);
      return;
    }
    setRenaming(true);
    const res = await transport.setPersonName(naming.userId, { firstName: naming.first, lastName: naming.last });
    setRenaming(false);
    if (res.ok) {
      const person = res.data.person;
      list.set({ ...data, people: data.people.map((p) => (p.userId === person.userId ? person : p)) });
      setNaming(null);
      setRowErrors((all) => {
        const next = { ...all };
        delete next[person.userId];
        return next;
      });
      announce(PEOPLE.renamed(person.name ?? ""));
    } else {
      const text = errorText(res.error, noun);
      setRowErrors((all) => ({ ...all, [naming.userId]: text }));
      fail(text);
    }
  };

  const choose = (person: AdminPersonWire, value: string, roles: readonly StaffRoleWire[]) => {
    const templateKey = value === "" ? null : value;
    if (templateKey === (person.staffRole?.key ?? null)) return;
    setRowErrors((all) => {
      const next = { ...all };
      delete next[person.userId];
      return next;
    });
    setPending({ person, templateKey, roleName: templateKey ? (roles.find((r) => r.key === templateKey)?.name ?? templateKey) : null });
  };

  const confirm = async () => {
    if (!pending || busy || !data) return;
    setBusy(true);
    const res = await transport.setStaffRole(pending.person.userId, { templateKey: pending.templateKey });
    setBusy(false);
    const person = pending.person;
    setPending(null);
    if (res.ok) {
      const updated: AdminPeopleWire = { ...data, people: data.people.map((p) => (p.userId === person.userId ? res.data.person : p)) };
      list.set(updated);
      announce(PEOPLE.changed(label(res.data.person)));
    } else {
      const text = errorText(res.error, noun);
      setRowErrors((all) => ({ ...all, [person.userId]: text }));
      fail(text);
    }
  };

  return (
    <AdminRoot {...chrome} data={{ "aitw-people": "" }}>
      {data && assignable.length > 0 ? (
        <section className="aitw-panel" data-aitw-invite="" aria-labelledby={`${inviteEmailId}-title`}>
          <h2 className="aitw-title" id={`${inviteEmailId}-title`}>
            {PEOPLE.inviteTitle}
          </h2>
          <p className="aitw-hint">{PEOPLE.inviteHint}</p>
          <form
            className="aitw-toolbar"
            onSubmit={(event) => {
              event.preventDefault();
              void sendInvite();
            }}
          >
            <div className="aitw-field" data-grow="">
              <label className="aitw-label" htmlFor={inviteEmailId}>
                {PEOPLE.inviteEmail}
              </label>
              <input
                id={inviteEmailId}
                className="aitw-input"
                type="email"
                autoComplete="off"
                spellCheck={false}
                required
                value={inviteEmail}
                onChange={(event) => setInviteEmail(event.target.value)}
              />
            </div>
            <div className="aitw-field">
              <label className="aitw-label" htmlFor={inviteRoleId}>
                {PEOPLE.inviteRole}
              </label>
              <select id={inviteRoleId} className="aitw-input" value={chosenRole} onChange={(event) => setInviteRole(event.target.value)}>
                {assignable.map((role) => (
                  <option key={role.key} value={role.key}>
                    {role.name}
                  </option>
                ))}
              </select>
            </div>
            <button type="submit" className="aitw-btn aitw-btn-primary" disabled={inviting || !inviteEmail.trim()}>
              {inviting ? PEOPLE.inviting : PEOPLE.invite}
            </button>
          </form>
          {inviteNote ? (
            <Notice tone={inviteNote.tone}>
              {inviteNote.text}
              {inviteNote.link ? (
                <span className="aitw-row" data-aitw-invite-link="">
                  <code>{inviteNote.link}</code>
                  <button type="button" className="aitw-btn aitw-btn-secondary aitw-btn-sm" onClick={() => void copyLink(inviteNote.link!)}>
                    {copied ? PEOPLE.copied : PEOPLE.copyLink}
                  </button>
                </span>
              ) : null}
            </Notice>
          ) : null}
        </section>
      ) : null}

      {invitations.data && invitations.data.invitations.length > 0 ? (
        <section className="aitw-panel" data-aitw-invitations="">
          <h2 className="aitw-title">{PEOPLE.waitingTitle}</h2>
          <p className="aitw-hint">{PEOPLE.waitingHint}</p>
          <table className="aitw-table" data-stack="768">
            <thead>
              <tr>
                <th scope="col">{PEOPLE.colEmail}</th>
                <th scope="col">{PEOPLE.colRole}</th>
                <th scope="col">{PEOPLE.colWaitsUntil}</th>
                <th scope="col">
                  <span className="aitw-sr">{PEOPLE.withdraw}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {invitations.data.invitations.map((invitation) => (
                <tr key={invitation.id} data-invitation={invitation.id}>
                  <td data-label={PEOPLE.colEmail}>{invitation.email}</td>
                  <td data-label={PEOPLE.colRole}>{invitation.role.name}</td>
                  <td data-label={PEOPLE.colWaitsUntil}>
                    {invitation.expired ? PEOPLE.expired(formatDate(invitation.expiresAt, locale)) : formatDate(invitation.expiresAt, locale)}
                  </td>
                  <td>
                    {invitation.canRevoke ? (
                      <button type="button" className="aitw-btn aitw-btn-danger-outline aitw-btn-sm" onClick={() => void withdraw(invitation)}>
                        {PEOPLE.withdraw}
                        <span className="aitw-sr">{` ${invitation.email}`}</span>
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}

      <div className="aitw-panel">
        <div className="aitw-toolbar" role="search">
          <div className="aitw-field" data-grow="">
            <label className="aitw-label" htmlFor={searchId}>
              {PEOPLE.search}
            </label>
            <input id={searchId} className="aitw-input" type="search" autoComplete="off" spellCheck={false} value={text} onChange={(event) => setText(event.target.value)} />
          </div>
          <label className="aitw-check">
            <input
              type="checkbox"
              checked={staffOnly}
              onChange={(event) => {
                setStaffOnly(event.target.checked);
                setPage(1);
              }}
            />
            <span>{PEOPLE.staffOnly}</span>
          </label>
        </div>

        {list.error ? <Notice tone="error">{errorText(list.error, noun)}</Notice> : null}
        {!data ? (
          list.error ? null : <Loading label={PEOPLE.loading} />
        ) : data.people.length === 0 ? (
          <p className="aitw-empty" data-aitw-empty="">
            {q ? CONSOLE.noMatch(q) : PEOPLE.none}
          </p>
        ) : (
          <>
            <table className="aitw-table" data-stack="768" aria-busy={list.loading || undefined}>
              <thead>
                <tr>
                  <th scope="col">{PEOPLE.colName}</th>
                  <th scope="col">{PEOPLE.colEmail}</th>
                  <th scope="col">{PEOPLE.colJoined}</th>
                  <th scope="col">{PEOPLE.colCompanies(noun)}</th>
                  <th scope="col">{PEOPLE.colStaffRole}</th>
                </tr>
              </thead>
              <tbody>
                {data.people.map((person) => (
                  <PersonRow
                    key={person.userId}
                    person={person}
                    roles={data.roles}
                    locale={locale}
                    nounPlural={PEOPLE.colCompanies(noun)}
                    noun={noun}
                    companiesHref={companiesHref}
                    error={rowErrors[person.userId] ?? null}
                    busy={busy && pending?.person.userId === person.userId}
                    onChoose={(value) => choose(person, value, data.roles)}
                    naming={naming?.userId === person.userId ? naming : null}
                    renaming={renaming}
                    onEditName={() => {
                      const [first = "", ...rest] = (person.name ?? "").split(" ");
                      setNaming({ userId: person.userId, first, last: rest.join(" ") });
                    }}
                    onNameChange={setNaming}
                    onSaveName={() => void saveName()}
                    onCancelName={() => setNaming(null)}
                  />
                ))}
              </tbody>
            </table>
            <Pager page={data.page} pageSize={data.pageSize} total={data.total} busy={list.loading} onPage={setPage} />
          </>
        )}
        <LiveRegion status={status} alert={alert} srOnly />
      </div>

      {pending ? (
        pending.templateKey ? (
          <ConfirmDialog
            title={PEOPLE.giveTitle}
            body={
              // The top role says what it really means (review T1-09): an
              // administrator can make or unmake other administrators.
              pending.templateKey === data?.roles[0]?.key
                ? PEOPLE.giveTop(label(pending.person), pending.roleName ?? "")
                : PEOPLE.give(label(pending.person), pending.roleName ?? "")
            }
            confirmLabel={PEOPLE.giveConfirm}
            tone="primary"
            busy={busy}
            onConfirm={() => void confirm()}
            onCancel={() => setPending(null)}
          />
        ) : (
          <ConfirmDialog
            title={PEOPLE.removeTitle}
            body={PEOPLE.remove(label(pending.person))}
            confirmLabel={PEOPLE.removeConfirm}
            busy={busy}
            onConfirm={() => void confirm()}
            onCancel={() => setPending(null)}
          />
        )
      ) : null}
    </AdminRoot>
  );
}

function PersonRow({
  person,
  roles,
  locale,
  nounPlural,
  noun,
  companiesHref,
  error,
  busy,
  onChoose,
  naming,
  renaming,
  onEditName,
  onNameChange,
  onSaveName,
  onCancelName,
}: {
  person: AdminPersonWire;
  roles: readonly StaffRoleWire[];
  locale: string;
  nounPlural: string;
  noun: Noun;
  companiesHref: string | null;
  error: string | null;
  busy: boolean;
  onChoose: (value: string) => void;
  naming: { userId: string; first: string; last: string } | null;
  renaming: boolean;
  onEditName: () => void;
  onNameChange: (next: { userId: string; first: string; last: string }) => void;
  onSaveName: () => void;
  onCancelName: () => void;
}) {
  const selectId = useId();
  const reason = person.canChange ? null : person.isYou ? PEOPLE.ownRow : PEOPLE.aboveYou;
  const current = person.staffRole?.key ?? "";
  // The person's current role is always an option, even one the caller can't give.
  const options = person.staffRole && !roles.some((r) => r.key === person.staffRole?.key)
    ? [{ key: person.staffRole.key, name: person.staffRole.name, rank: person.staffRole.rank, assignable: false }, ...roles]
    : roles;
  const describe = [reason ? `${selectId}-reason` : null, error ? `${selectId}-error` : null].filter(Boolean).join(" ") || undefined;
  return (
    <tr data-person={person.userId}>
      <td data-label={PEOPLE.colName}>
        {naming ? (
          <form
            className="aitw-row"
            onSubmit={(event) => {
              event.preventDefault();
              onSaveName();
            }}
          >
            <label className="aitw-sr" htmlFor={`${selectId}-first`}>
              {PEOPLE.firstName}
            </label>
            <input
              id={`${selectId}-first`}
              className="aitw-input"
              placeholder={PEOPLE.firstName}
              autoComplete="off"
              autoFocus
              value={naming.first}
              onChange={(event) => onNameChange({ ...naming, first: event.target.value })}
            />
            <label className="aitw-sr" htmlFor={`${selectId}-last`}>
              {PEOPLE.lastName}
            </label>
            <input
              id={`${selectId}-last`}
              className="aitw-input"
              placeholder={PEOPLE.lastName}
              autoComplete="off"
              value={naming.last}
              onChange={(event) => onNameChange({ ...naming, last: event.target.value })}
            />
            <button type="submit" className="aitw-btn aitw-btn-primary aitw-btn-sm" disabled={renaming}>
              {PEOPLE.saveName}
            </button>
            <button type="button" className="aitw-btn aitw-btn-secondary aitw-btn-sm" onClick={onCancelName}>
              {PEOPLE.cancel}
            </button>
          </form>
        ) : (
          <>
            {person.name ?? person.email ?? ""}
            {person.isYou ? ` ${W.you}` : ""}
            {person.canRename ? (
              <>
                {" "}
                <button type="button" className="aitw-btn aitw-btn-link aitw-btn-sm" data-aitw-rename="" onClick={onEditName}>
                  {person.name ? PEOPLE.editName : PEOPLE.addName}
                  <span className="aitw-sr">{`: ${PEOPLE.nameFor(person.email ?? person.name ?? PEOPLE.thisPerson)}`}</span>
                </button>
              </>
            ) : null}
          </>
        )}
      </td>
      <td data-label={PEOPLE.colEmail}>{person.email ?? ""}</td>
      <td data-label={PEOPLE.colJoined}>{formatDate(person.createdAt, locale)}</td>
      <td data-label={nounPlural}>
        {companiesHref && person.email && person.companies > 0 ? (
          <a href={`${companiesHref}?q=${encodeURIComponent(person.email)}`} data-aitw-companies-of="">
            {person.companies}
            <span className="aitw-sr">{PEOPLE.companiesOf(person.email, noun)}</span>
          </a>
        ) : (
          person.companies
        )}
      </td>
      <td data-label={PEOPLE.colStaffRole}>
        <label className="aitw-sr" htmlFor={selectId}>
          {PEOPLE.staffRoleFor(person.email ?? person.name ?? "")}
        </label>
        <select
          id={selectId}
          className="aitw-input"
          value={current}
          disabled={!person.canChange || busy}
          aria-describedby={describe}
          aria-invalid={error ? true : undefined}
          onChange={(event) => onChoose(event.target.value)}
        >
          <option value="">{PEOPLE.noStaffRole}</option>
          {options.map((role) => (
            <option key={role.key} value={role.key} disabled={!role.assignable}>
              {role.name}
            </option>
          ))}
        </select>
        {reason ? (
          <span className="aitw-row-note" id={`${selectId}-reason`}>
            {reason}
          </span>
        ) : null}
        {error ? (
          <span className="aitw-row-error" id={`${selectId}-error`}>
            {error}
          </span>
        ) : null}
      </td>
    </tr>
  );
}
