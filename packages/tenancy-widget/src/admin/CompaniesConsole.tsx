import { useEffect, useId, useState } from "react";
import { formatDate, Loading, Notice, type ChromeProps, type NounProps } from "../parts.js";
import { isUnconnected, useLoaded } from "../transport.js";
import { CONSOLE, errorText, nounOf, NOT_CONNECTED_MESSAGE, W } from "../words.js";
import type { TenancyAdminTransport } from "./client.js";
import { AdminRoot, pageParam, Pager, readSearch, useAdminTransport, writeSearch } from "./ui.js";

/**
 * <CompaniesConsole> (contract 8.10): every company on the platform, for the
 * platform's own staff. Search by name, web address or the owner's email;
 * filter by kind and status; page through.
 *
 * PERSONAL WORKSPACES ARE HIDDEN BY DEFAULT. In a companies-mode project they
 * are leftovers from before 0.22 (decision D6), and listing one per sign-up
 * would bury the real companies. "Show" brings them back.
 *
 * THE VIEW LIVES IN THE ADDRESS BAR. Search, filters and page are mirrored
 * into the URL with `replaceState` and read back on mount, so a refresh, the
 * back button from a company's detail, or a link pasted to a colleague opens
 * the same list.
 */

export type CompanyKindFilter = "org" | "personal" | "all";
export type CompanyStatusFilter = "active" | "suspended" | "all";

export interface CompaniesConsoleProps extends ChromeProps, NounProps {
  baseUrl?: string;
  transport?: TenancyAdminTransport;
  /**
   * Where a company's name links: a function, (id) => `/admin/companies/${id}`,
   * or a pattern with `{id}` in it, "/admin/companies/{id}" (default).
   *
   * CONTRACT: the contract types this as a function only. A Next.js SERVER
   * page can't hand a function to a client component ("Functions cannot be
   * passed directly to Client Components"), and the emitted admin page is a
   * server page, so a pattern string is accepted too, and is the default.
   */
  detailHref?: string | ((tenantId: string) => string);
  /** Default "org"; create-app passes "all" in single-business mode. */
  defaultKind?: CompanyKindFilter;
  /** Default 25. */
  pageSize?: number;
}

/** A company's detail link from `detailHref`: the function's answer, or the pattern with `{id}` filled in (encoded). */
export function companyHref(detailHref: CompaniesConsoleProps["detailHref"], tenantId: string): string {
  if (typeof detailHref === "function") return detailHref(tenantId);
  const pattern = detailHref ?? "/admin/companies/{id}";
  const id = encodeURIComponent(tenantId);
  return pattern.includes("{id}") ? pattern.split("{id}").join(id) : `${pattern.replace(/\/+$/, "")}/${id}`;
}

const KIND_VALUES: readonly CompanyKindFilter[] = ["org", "personal", "all"];
const STATUS_VALUES: readonly CompanyStatusFilter[] = ["all", "active", "suspended"];

export function CompaniesConsole(props: CompaniesConsoleProps) {
  const { detailHref, defaultKind = "org", pageSize = 25, locale = "en-US", theme, nonce, className, style } = props;
  const noun = nounOf(props.noun);
  const transport = useAdminTransport(props.transport, props.baseUrl);
  const unconnected = isUnconnected(props.transport, props.baseUrl);
  const searchId = useId();
  const kindId = useId();
  const statusId = useId();

  // The URL is read AFTER mount (never during render), so the server render
  // and the first client render agree; nothing is fetched until it's read.
  const [hydrated, setHydrated] = useState(false);
  /** What's typed in the box … */
  const [text, setText] = useState("");
  /** … and what's searched: the typing, once it has paused for 300 ms. */
  const [q, setQ] = useState("");
  const [kind, setKind] = useState<CompanyKindFilter>(defaultKind);
  const [status, setStatus] = useState<CompanyStatusFilter>("all");
  const [page, setPage] = useState(1);
  useEffect(() => {
    const params = readSearch();
    if (params) {
      const fromUrl = (params.get("q") ?? "").trim();
      setText(fromUrl);
      setQ(fromUrl);
      const k = params.get("kind");
      if (k && (KIND_VALUES as readonly string[]).includes(k)) setKind(k as CompanyKindFilter);
      const s = params.get("status");
      if (s && (STATUS_VALUES as readonly string[]).includes(s)) setStatus(s as CompanyStatusFilter);
      setPage(pageParam(params.get("page")));
    }
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    const next = text.trim();
    if (next === q) return;
    // A new search starts at the first page.
    const timer = setTimeout(() => {
      setQ(next);
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [text, q, hydrated]);

  const queryKey = hydrated && !unconnected ? JSON.stringify({ q, kind, status, page, pageSize }) : null;
  const list = useLoaded(
    () => transport.companies({ ...(q ? { q } : {}), kind, status, page, pageSize }),
    undefined,
    queryKey,
  );

  useEffect(() => {
    if (!hydrated) return;
    writeSearch({ q, kind, status, page }, { q: "", kind: defaultKind, status: "all", page: 1 });
  }, [hydrated, q, kind, status, page, defaultKind]);

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
  const filtered = q !== "" || status !== "all" || kind !== defaultKind;

  return (
    <AdminRoot {...chrome} data={{ "aitw-console": "" }}>
      <div className="aitw-panel">
        <div className="aitw-toolbar" role="search">
          <div className="aitw-field" data-grow="">
            <label className="aitw-label" htmlFor={searchId}>
              {CONSOLE.search(noun)}
            </label>
            <input id={searchId} className="aitw-input" type="search" autoComplete="off" spellCheck={false} value={text} onChange={(event) => setText(event.target.value)} />
          </div>
          <div className="aitw-field">
            <label className="aitw-label" htmlFor={kindId}>
              {CONSOLE.show}
            </label>
            <select
              id={kindId}
              className="aitw-input"
              value={kind}
              onChange={(event) => {
                setKind(event.target.value as CompanyKindFilter);
                setPage(1);
              }}
            >
              <option value="org">{CONSOLE.kindOrg(noun)}</option>
              <option value="personal">{CONSOLE.kindPersonal}</option>
              <option value="all">{CONSOLE.kindAll}</option>
            </select>
          </div>
          <div className="aitw-field">
            <label className="aitw-label" htmlFor={statusId}>
              {CONSOLE.status}
            </label>
            <select
              id={statusId}
              className="aitw-input"
              value={status}
              onChange={(event) => {
                setStatus(event.target.value as CompanyStatusFilter);
                setPage(1);
              }}
            >
              <option value="all">{CONSOLE.statusAll}</option>
              <option value="active">{CONSOLE.statusActive}</option>
              <option value="suspended">{CONSOLE.statusSuspended}</option>
            </select>
          </div>
        </div>

        {list.error ? <Notice tone="error">{errorText(list.error, noun)}</Notice> : null}
        {!data ? (
          list.error ? null : <Loading label={CONSOLE.loading(noun)} />
        ) : data.companies.length === 0 ? (
          <p className="aitw-empty" data-aitw-empty="">
            {q ? CONSOLE.noMatch(q) : filtered ? CONSOLE.noMatchFilters : CONSOLE.none(noun)}
          </p>
        ) : (
          <>
            <table className="aitw-table" data-stack="768" aria-busy={list.loading || undefined}>
              <thead>
                <tr>
                  <th scope="col">{CONSOLE.colName}</th>
                  <th scope="col">{CONSOLE.colAddress}</th>
                  <th scope="col">{CONSOLE.colPeople}</th>
                  <th scope="col">{CONSOLE.colOwner}</th>
                  <th scope="col">{CONSOLE.colCreated}</th>
                  <th scope="col">{CONSOLE.colStatus}</th>
                </tr>
              </thead>
              <tbody>
                {data.companies.map((row) => (
                  <tr key={row.id} data-company={row.id}>
                    <td data-label={CONSOLE.colName}>
                      {/* 44px tall (contract 8.13; the bare link was 22px, review T1-15). */}
                      <a className="aitw-tap-link" href={companyHref(detailHref, row.id)}>
                        {row.name}
                      </a>
                    </td>
                    <td data-label={CONSOLE.colAddress}>{`/t/${row.slug}`}</td>
                    <td data-label={CONSOLE.colPeople}>{row.members}</td>
                    <td data-label={CONSOLE.colOwner}>{row.owner?.email ?? row.owner?.name ?? ""}</td>
                    <td data-label={CONSOLE.colCreated}>{formatDate(row.createdAt, locale)}</td>
                    <td data-label={CONSOLE.colStatus}>
                      {row.status === "suspended" ? <span className="aitw-tag aitw-tag-warn">{W.suspended}</span> : W.active}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <Pager page={data.page} pageSize={data.pageSize} total={data.total} busy={list.loading} onPage={setPage} />
          </>
        )}
      </div>
    </AdminRoot>
  );
}
