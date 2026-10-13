import { useEffect, useId, useState } from "react";
import { ConfirmDialog, formatDate, LiveRegion, Loading, Notice, type ChromeProps, type NounProps } from "../parts.js";
import { isUnconnected, useAnnouncer, useLoaded } from "../transport.js";
import type { AdminPeopleWire, AdminPersonWire, StaffRoleWire } from "../types.js";
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
        {person.name ?? person.email ?? ""}
        {person.isYou ? ` ${W.you}` : ""}
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
