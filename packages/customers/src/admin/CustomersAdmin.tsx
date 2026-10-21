import { useCallback, useEffect, useState, type ChangeEvent, type FormEvent } from "react";
import { pageActionChannel } from "./page-actions.js";
import type {
  CustomerLinkKind,
  CustomerListResponse,
  CustomerResponse,
  CustomerSummaryWire,
  CustomerWire,
  ImportApplyResponse,
  ImportPreviewResponse,
  MergeResponse,
  TimelineEntryWire,
  TimelineResponse,
} from "../wire.js";
import { decodeCsvBytes } from "../csv.js";
import { customersCss } from "./styles.js";

/**
 * THE CUSTOMER SCREENS (customers 0.1): the list with search, one customer
 * with everything that is theirs (quotes, visits, invoices, calls, orders,
 * messages) in one timeline, their details and notes to edit, merging two
 * that are the same person, and importing or exporting the list. Everything
 * goes through `baseUrl` (the app's mount of `createCustomersAdminHandlers`),
 * which checks the person's permission on every call; this screen only asks.
 */
export interface CustomersAdminProps {
  /** e.g. "/api/app/{company id}/customers". */
  readonly baseUrl: string;
  /** This page's own address, e.g. "/app/customers": a customer opens at `?customer={id}`. */
  readonly pageHref: string;
  /** The customer to open (the page's `?customer=`), or null for the list. */
  readonly customerId?: string | null;
  /** Where each kind of record opens; "{id}" is replaced with the record's id. A kind left out isn't a link. */
  readonly recordHrefs?: Partial<Record<CustomerLinkKind, string>>;
  /** Can this person change things (customers.manage)? The server checks again. */
  readonly canManage?: boolean;
  /** The heading. Default "Customers"; `false` draws none (and no description), for a host page whose own header says it. */
  readonly title?: string | false;
  /** Dates in the company's locale. Default "en-US". */
  readonly locale?: string;
  /**
   * polish 3: the host page's header carries Add customer, Import and Export
   * — render <CustomersActions> there — so the list draws none of its own.
   * Default false.
   */
  readonly actionsInHeader?: boolean;
}

export function CustomersStyles() {
  return <style data-adminigloo-customers="">{customersCss}</style>;
}

/** A refusal's own words, or a fixed sentence (never a stack trace). */
export async function request<T>(url: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { cache: "no-store", ...init, headers: { ...(init?.body ? { "content-type": "application/json" } : {}), ...init?.headers } });
  } catch {
    throw new Error("We couldn't reach the server. Check your connection and try again.");
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (!res.ok) {
    const message = (body as { error?: { message?: unknown } } | null)?.error?.message;
    throw new Error(typeof message === "string" && message ? message : statusWords(res.status));
  }
  return body as T;
}

function ErrorNote(props: { readonly message: string | null }) {
  return props.message ? (
    <p role="alert" className="aicu-error">
      {props.message}
    </p>
  ) : null;
}

const KIND_WORDS: Readonly<Record<CustomerLinkKind, string>> = {
  estimate: "Quote",
  visit: "Visit",
  invoice: "Invoice",
  booking: "Call",
  order: "Order",
  message: "Message",
};

/** "Quote", "Visit", … — the word a timeline row starts with. */
export function kindWords(kind: CustomerLinkKind): string {
  return KIND_WORDS[kind] ?? kind;
}

/** Where a timeline row opens, or null. */
export function recordHref(hrefs: CustomersAdminProps["recordHrefs"], entry: Pick<TimelineEntryWire, "kind" | "refId">): string | null {
  const template = hrefs?.[entry.kind];
  return template ? template.replace("{id}", encodeURIComponent(entry.refId)) : null;
}

function when(iso: string | null, locale = "en-US"): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  try {
    return date.toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" });
  } catch {
    return date.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
  }
}

function customerHref(pageHref: string, id: string): string {
  return `${pageHref}?customer=${encodeURIComponent(id)}`;
}

/** The list's header buttons, pressed in the host page's header (<CustomersActions>). */
const listActions = pageActionChannel<"add" | "import">("aicu-list");

export interface CustomersActionsProps {
  /** The same `baseUrl` as the <CustomersAdmin> below: Export downloads from it. */
  readonly baseUrl: string;
  /** The host's button classes (its page header's primary and secondary buttons). Default the widget's own. */
  readonly primaryClassName?: string;
  readonly secondaryClassName?: string;
}

/**
 * Add customer, Import and Export for the host page's header (polish 3),
 * beside its title like every other page's primary action. Add and Import
 * open the list's own panels below. Render it only for someone who may
 * change customers (`customers.manage`), on the list (not one customer's
 * page), with `actionsInHeader` on the <CustomersAdmin>.
 */
export function CustomersActions(props: CustomersActionsProps) {
  const { press } = listActions.useHeader();
  const secondary = props.secondaryClassName ?? "aicu-btn aicu-btn-quiet";
  return (
    <>
      <button type="button" className={props.primaryClassName ?? "aicu-btn"} data-aicu-header-action="add" onClick={() => press("add")}>
        Add customer
      </button>
      <button type="button" className={secondary} data-aicu-header-action="import" onClick={() => press("import")}>
        Import
      </button>
      <a className={secondary} href={`${props.baseUrl}/v1/admin/export`} download>
        Export
      </a>
    </>
  );
}

export function CustomersAdmin(props: CustomersAdminProps) {
  const canManage = props.canManage ?? true;
  return (
    <section className="aicu aicu-stack" data-customers-admin="">
      <CustomersStyles />
      {props.customerId ? (
        <CustomerDetail {...props} customerId={props.customerId} canManage={canManage} />
      ) : (
        <CustomerList {...props} canManage={canManage} />
      )}
    </section>
  );
}

// --- The list ---------------------------------------------------------------------

function CustomerList(props: CustomersAdminProps & { readonly canManage: boolean }) {
  const [q, setQ] = useState("");
  const [page, setPage] = useState<CustomerListResponse | null>(null);
  const [rows, setRows] = useState<CustomerSummaryWire[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [panel, setPanel] = useState<"none" | "add" | "import">("none");
  const inHeader = props.actionsInHeader === true;
  // Pressed in the page header: the same toggles as the buttons here.
  listActions.useScreen(inHeader && props.canManage, (action) => setPanel((open) => (open === action ? "none" : action)), {});
  const load = useCallback(
    (query: string, cursor: string | null) => {
      const params = new URLSearchParams();
      if (query.trim()) params.set("q", query.trim());
      if (cursor) params.set("cursor", cursor);
      request<CustomerListResponse>(`${props.baseUrl}/v1/admin/customers${params.size > 0 ? `?${params}` : ""}`)
        .then((next) => {
          setPage(next);
          setRows((before) => (cursor ? [...before, ...next.customers] : [...next.customers]));
          setError(null);
        })
        .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
    },
    [props.baseUrl],
  );
  useEffect(() => {
    const timer = setTimeout(() => load(q, null), q ? 250 : 0);
    return () => clearTimeout(timer);
  }, [q, load]);
  return (
    <>
      {props.title === false && (inHeader || !props.canManage) ? null : (
      <header className="aicu-row" style={{ justifyContent: props.title === false ? "flex-end" : "space-between" }}>
        {props.title === false ? null : (
          <div>
            <h1 className="aicu-h1">{props.title ?? "Customers"}</h1>
            <p className="aicu-muted">Everyone who has asked for a quote, booked, been invoiced or bought from you, each with everything that is theirs.</p>
          </div>
        )}
        {props.canManage && !inHeader ? (
          <div className="aicu-row">
            <button type="button" className="aicu-btn" onClick={() => setPanel(panel === "add" ? "none" : "add")}>
              Add customer
            </button>
            <button type="button" className="aicu-btn aicu-btn-quiet" onClick={() => setPanel(panel === "import" ? "none" : "import")}>
              Import
            </button>
            <a className="aicu-btn aicu-btn-quiet" href={`${props.baseUrl}/v1/admin/export`} download>
              Export
            </a>
          </div>
        ) : null}
      </header>
      )}
      {panel === "add" ? <AddCustomer baseUrl={props.baseUrl} pageHref={props.pageHref} /> : null}
      {panel === "import" ? <ImportPanel baseUrl={props.baseUrl} onDone={() => load(q, null)} /> : null}
      <label className="aicu-label">
        Search
        <input className="aicu-input" type="search" value={q} placeholder="Name, email, phone or address" onChange={(e: ChangeEvent<HTMLInputElement>) => setQ(e.target.value)} />
      </label>
      <ErrorNote message={error} />
      {page && rows.length === 0 ? (
        q ? (
          <p className="aicu-muted">Nobody matches that.</p>
        ) : (
          <div className="aicu-card aicu-empty" data-customers-empty="">
            <p className="aicu-empty-title">No customers yet</p>
            <p className="aicu-muted">
              Once work comes in, everyone who asks for a quote, books, is invoiced or buys from you lands here by themselves, each with their
              whole history in one place. Bring the ones you already have with Import.
            </p>
            {props.canManage ? (
              <div className="aicu-row" style={{ justifyContent: "center" }}>
                <button type="button" className="aicu-btn" onClick={() => setPanel("import")}>
                  Import your customers
                </button>
                <button type="button" className="aicu-btn aicu-btn-quiet" onClick={() => setPanel("add")}>
                  Add one
                </button>
              </div>
            ) : null}
          </div>
        )
      ) : null}
      {rows.length > 0 ? (
        // On a phone: one card per customer (name, email, phone), no wide table.
        <ul className="aicu-list aicu-cards" data-customer-cards="">
          {rows.map((row) => (
            <li key={row.id} className="aicu-card">
              <a href={customerHref(props.pageHref, row.id)}>
                <strong>{row.name}</strong>
              </a>
              {row.companyName ? <div className="aicu-muted">{row.companyName}</div> : null}
              {row.email ? <div>{row.email}</div> : null}
              {row.phone ? <div>{row.phone}</div> : null}
            </li>
          ))}
        </ul>
      ) : null}
      {rows.length > 0 ? (
        <div className="aicu-scroll aicu-wide">
          <table className="aicu-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Email</th>
                <th>Phone</th>
                <th>Last activity</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td>
                    <a href={customerHref(props.pageHref, row.id)}>{row.name}</a>
                    {row.companyName ? <div className="aicu-muted">{row.companyName}</div> : null}
                  </td>
                  <td>{row.email ?? ""}</td>
                  <td>{row.phone ?? ""}</td>
                  <td className="aicu-when">{when(row.lastActivityAt ?? row.createdAt, props.locale)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {page?.nextCursor ? (
        <button type="button" className="aicu-btn aicu-btn-quiet" onClick={() => load(q, page.nextCursor)}>
          Show more
        </button>
      ) : null}
    </>
  );
}

function AddCustomer(props: { readonly baseUrl: string; readonly pageHref: string }) {
  const [draft, setDraft] = useState({ name: "", email: "", phone: "", address: "" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    request<CustomerResponse>(`${props.baseUrl}/v1/admin/customers`, { method: "POST", body: JSON.stringify(draft) })
      .then((res) => {
        window.location.href = customerHref(props.pageHref, res.customer.id);
      })
      .catch((e2: unknown) => setError(e2 instanceof Error ? e2.message : String(e2)))
      .finally(() => setBusy(false));
  };
  const field = (key: keyof typeof draft, label: string, type = "text") => (
    <label className="aicu-label">
      {label}
      <input className="aicu-input" type={type} value={draft[key]} onChange={(e: ChangeEvent<HTMLInputElement>) => setDraft({ ...draft, [key]: e.target.value })} />
    </label>
  );
  return (
    <form className="aicu-card aicu-stack" onSubmit={submit}>
      <h2 className="aicu-h2">Add a customer</h2>
      {field("name", "Name")}
      {field("email", "Email", "email")}
      {field("phone", "Phone", "tel")}
      {field("address", "Address")}
      <ErrorNote message={error} />
      <div className="aicu-row">
        <button type="submit" className="aicu-btn" disabled={busy}>
          Add customer
        </button>
      </div>
    </form>
  );
}

/** Read a chosen file as text: UTF-8, else Windows-1252 (Excel's plain "CSV"), so accents survive. */
async function readFile(file: File): Promise<string> {
  return decodeCsvBytes(new Uint8Array(await file.arrayBuffer()));
}

/** "1,500 of 5,000 done". */
export function importProgressWords(done: number, total: number): string {
  return `${done.toLocaleString("en-US")} of ${total.toLocaleString("en-US")} done`;
}

export function ImportPanel(props: { readonly baseUrl: string; readonly onDone: () => void }) {
  const [csv, setCsv] = useState<string | null>(null);
  const [preview, setPreview] = useState<ImportPreviewResponse | null>(null);
  const [result, setResult] = useState<ImportApplyResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const choose = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    setPreview(null);
    setResult(null);
    if (!file) return;
    setBusy(true);
    readFile(file)
      .then((text) => {
        setCsv(text);
        return request<ImportPreviewResponse>(`${props.baseUrl}/v1/admin/import/preview`, { method: "POST", body: JSON.stringify({ csv: text }) });
      })
      .then((next) => {
        setPreview(next);
        setError(null);
      })
      .catch((e2: unknown) => setError(e2 instanceof Error ? e2.message : String(e2)))
      .finally(() => setBusy(false));
  };
  const [progress, setProgress] = useState<string | null>(null);
  const [resumeAt, setResumeAt] = useState<number | null>(null);
  // Big files go a few thousand rows a call; each call carries on from where the last stopped.
  const apply = async (fromRow = 0) => {
    if (!csv) return;
    setBusy(true);
    setError(null);
    let at: number | null = fromRow;
    const totals = { created: result?.created ?? 0, updated: result?.updated ?? 0, skipped: result?.skipped ?? 0 };
    if (fromRow === 0) Object.assign(totals, { created: 0, updated: 0, skipped: 0 });
    try {
      while (at !== null) {
        const done: ImportApplyResponse = await request<ImportApplyResponse>(`${props.baseUrl}/v1/admin/import/apply`, { method: "POST", body: JSON.stringify({ csv, fromRow: at }) });
        totals.created += done.created;
        totals.updated += done.updated;
        totals.skipped += done.skipped;
        setResult({ ...done, ...totals });
        setProgress(importProgressWords(done.done, done.total));
        if (done.problem) {
          setError(done.problem);
          setResumeAt(done.nextRow);
          return;
        }
        at = done.nextRow;
      }
      setResumeAt(null);
      setPreview(null);
      props.onDone();
    } catch (e2: unknown) {
      setResumeAt(at);
      setError(`${e2 instanceof Error ? e2.message : String(e2)} Rows before row ${((at ?? 0) + 2).toLocaleString("en-US")} were saved; press Continue to carry on.`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="aicu-card aicu-stack">
      <h2 className="aicu-h2">Import customers</h2>
      <p className="aicu-muted">
        A CSV file with a heading row — Name, Email, Phone, Address, Company, Notes, Tags (any you have) — and up to 5,000 customers. You see what will happen before anything is saved. Someone you already have gets the new details; their name stays.
      </p>
      <input type="file" accept=".csv,text/csv" onChange={choose} disabled={busy} />
      <ErrorNote message={error} />
      {preview ? (
        <>
          <p>
            {preview.counts.create} new, {preview.counts.update} already customers, {preview.counts["same-as-row"]} repeated in the file, {preview.counts.error} with a problem
            {preview.ignoredColumns.length > 0 ? ` · Not imported: ${preview.ignoredColumns.join(", ")}` : ""}
          </p>
          <div className="aicu-scroll">
            <table className="aicu-table">
              <thead>
                <tr>
                  <th>Row</th>
                  <th>Name</th>
                  <th>What happens</th>
                </tr>
              </thead>
              <tbody>
                {preview.rows.slice(0, 200).map((row) => (
                  <tr key={row.row}>
                    <td>{row.row}</td>
                    <td>{row.name}</td>
                    <td>
                      <span className={row.action === "error" ? "aicu-tag aicu-tag-bad" : row.action === "create" ? "aicu-tag aicu-tag-good" : "aicu-tag"}>{row.action === "error" ? "Problem" : row.action === "create" ? "New" : "Matched"}</span> {row.message}
                      {row.adds.length > 0 && row.action !== "create" ? <div className="aicu-muted">Adds {row.adds.join(", ")}</div> : null}
                      {row.conflicts.map((conflict) => (
                        <div key={conflict} className="aicu-muted">
                          {conflict}
                        </div>
                      ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {preview.rows.length > 200 ? <p className="aicu-muted">Showing the first 200 rows.</p> : null}
          <div className="aicu-row">
            <button type="button" className="aicu-btn" onClick={() => void apply(0)} disabled={busy || preview.counts.create + preview.counts.update + preview.counts["same-as-row"] === 0}>
              Import {preview.counts.create + preview.counts.update + preview.counts["same-as-row"]} rows
            </button>
            {resumeAt !== null && !busy ? (
              <button type="button" className="aicu-btn aicu-btn-quiet" onClick={() => void apply(resumeAt)}>
                Continue from row {(resumeAt + 2).toLocaleString("en-US")}
              </button>
            ) : null}
          </div>
        </>
      ) : null}
      {busy && progress ? <p className="aicu-muted">{progress}…</p> : null}
      {result && resumeAt === null && !busy ? (
        <p className="aicu-ok">
          Done: {result.created} new customers, {result.updated} updated{result.skipped > 0 ? `, ${result.skipped} rows left out` : ""}.
        </p>
      ) : null}
    </div>
  );
}

// --- One customer -------------------------------------------------------------------

function CustomerDetail(props: CustomersAdminProps & { readonly customerId: string; readonly canManage: boolean }) {
  const asked = `${props.baseUrl}/v1/admin/customers/${encodeURIComponent(props.customerId)}`;
  const [customer, setCustomer] = useState<CustomerWire | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    request<CustomerResponse>(asked)
      .then((res) => {
        setCustomer(res.customer);
        // An old link to a customer merged into another: show the kept one, at its own address.
        if (res.mergedFrom && typeof window !== "undefined") window.history.replaceState(null, "", customerHref(props.pageHref, res.customer.id));
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [asked, props.pageHref]);
  // Every call after the first is about the customer shown (the kept one, after a merge).
  const base = customer ? `${props.baseUrl}/v1/admin/customers/${encodeURIComponent(customer.id)}` : asked;
  return (
    <>
      <p>
        <a href={props.pageHref}>← All customers</a>
      </p>
      <ErrorNote message={error} />
      {customer ? (
        <>
          <header className="aicu-row" style={{ justifyContent: "space-between" }}>
            <div>
              <h1 className="aicu-h1">{customer.name}</h1>
              {customer.companyName ? <p className="aicu-muted">{customer.companyName}</p> : null}
            </div>
            {props.canManage && !editing ? (
              <button type="button" className="aicu-btn aicu-btn-quiet" onClick={() => setEditing(true)}>
                Edit
              </button>
            ) : null}
          </header>
          {editing ? (
            <EditCustomer base={base} customer={customer} onSaved={(next) => { setCustomer(next); setEditing(false); }} onCancel={() => setEditing(false)} />
          ) : (
            <CustomerCard customer={customer} />
          )}
          {customer.notices.length > 0 ? <Notices baseUrl={props.baseUrl} base={base} customer={customer} pageHref={props.pageHref} canManage={props.canManage} onChange={setCustomer} /> : null}
          <Addresses base={base} customer={customer} canManage={props.canManage} onChange={setCustomer} />
          {/* Keyed on the customer's last change: after a merge the moved entries load. */}
          <Timeline key={`${customer.id}:${customer.updatedAt}`} base={base} recordHrefs={props.recordHrefs} locale={props.locale} />
          {props.canManage ? <MergePanel baseUrl={props.baseUrl} base={base} customer={customer} pageHref={props.pageHref} onMerged={setCustomer} /> : null}
        </>
      ) : null}
    </>
  );
}

function CustomerCard(props: { readonly customer: CustomerWire }) {
  const c = props.customer;
  return (
    <div className="aicu-card aicu-stack">
      <div className="aicu-row">
        <div>
          <div className="aicu-muted">Email</div>
          {c.emails.length > 0 ? c.emails.map((email) => <div key={email}><a href={`mailto:${email}`}>{email}</a></div>) : <div className="aicu-muted">None</div>}
        </div>
        <div>
          <div className="aicu-muted">Phone</div>
          {c.phones.length > 0 ? c.phones.map((phone) => <div key={phone}><a href={`tel:${phone}`}>{phone}</a></div>) : <div className="aicu-muted">None</div>}
        </div>
      </div>
      {c.tags.length > 0 ? (
        <div className="aicu-row">
          {c.tags.map((tag) => (
            <span key={tag} className="aicu-tag">
              {tag}
            </span>
          ))}
        </div>
      ) : null}
      <div>
        <div className="aicu-muted">Notes</div>
        <p style={{ whiteSpace: "pre-wrap", margin: 0 }}>{c.notes ?? "No notes yet."}</p>
      </div>
    </div>
  );
}

/** The editor's fields as the route's body. */
export function customerBody(draft: { name: string; companyName: string; emails: string; phones: string; tags: string; notes: string }): Record<string, unknown> {
  const list = (value: string) => value.split(/[\n,;]/).map((item) => item.trim()).filter(Boolean);
  return { name: draft.name, companyName: draft.companyName, emails: list(draft.emails), phones: list(draft.phones), tags: list(draft.tags), notes: draft.notes };
}

function EditCustomer(props: { readonly base: string; readonly customer: CustomerWire; readonly onSaved: (customer: CustomerWire) => void; readonly onCancel: () => void }) {
  const c = props.customer;
  const [draft, setDraft] = useState({ name: c.name, companyName: c.companyName ?? "", emails: c.emails.join("\n"), phones: c.phones.join("\n"), tags: c.tags.join(", "), notes: c.notes ?? "" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const save = (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    request<CustomerResponse>(props.base, { method: "POST", body: JSON.stringify(customerBody(draft)) })
      .then((res) => props.onSaved(res.customer))
      .catch((e2: unknown) => setError(e2 instanceof Error ? e2.message : String(e2)))
      .finally(() => setBusy(false));
  };
  const set = (key: keyof typeof draft) => (e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setDraft({ ...draft, [key]: e.target.value });
  return (
    <form className="aicu-card aicu-stack" onSubmit={save}>
      <label className="aicu-label">
        Name
        <input className="aicu-input" value={draft.name} onChange={set("name")} />
      </label>
      <label className="aicu-label">
        Company
        <input className="aicu-input" value={draft.companyName} onChange={set("companyName")} />
      </label>
      <label className="aicu-label">
        Emails (one a line)
        <textarea className="aicu-textarea" value={draft.emails} onChange={set("emails")} />
      </label>
      <label className="aicu-label">
        Phones (one a line)
        <textarea className="aicu-textarea" value={draft.phones} onChange={set("phones")} />
      </label>
      <label className="aicu-label">
        Tags (commas between)
        <input className="aicu-input" value={draft.tags} onChange={set("tags")} />
      </label>
      <label className="aicu-label">
        Notes
        <textarea className="aicu-textarea" value={draft.notes} onChange={set("notes")} />
      </label>
      <ErrorNote message={error} />
      <div className="aicu-row">
        <button type="submit" className="aicu-btn" disabled={busy}>
          Save
        </button>
        <button type="button" className="aicu-btn aicu-btn-quiet" onClick={props.onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function Addresses(props: { readonly base: string; readonly customer: CustomerWire; readonly canManage: boolean; readonly onChange: (customer: CustomerWire) => void }) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const act = (url: string, body: unknown) =>
    request<CustomerResponse>(url, { method: "POST", body: JSON.stringify(body) })
      .then((res) => {
        props.onChange(res.customer);
        setError(null);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  return (
    <div className="aicu-card aicu-stack">
      <h2 className="aicu-h2">Addresses</h2>
      {props.customer.addresses.length === 0 ? <p className="aicu-muted">No addresses yet.</p> : null}
      <ul className="aicu-list">
        {props.customer.addresses.map((address) => (
          <li key={address.id} className="aicu-row" style={{ justifyContent: "space-between" }}>
            <span>
              {address.label ? <strong>{address.label}: </strong> : null}
              {address.text}
            </span>
            {props.canManage ? (
              <button type="button" className="aicu-btn aicu-btn-quiet" onClick={() => void act(`${props.base}/addresses/${encodeURIComponent(address.id)}/remove`, {})}>
                Remove
              </button>
            ) : null}
          </li>
        ))}
      </ul>
      {props.canManage ? (
        <form
          className="aicu-row"
          onSubmit={(e) => {
            e.preventDefault();
            void act(`${props.base}/addresses`, { text }).then(() => setText(""));
          }}
        >
          <input className="aicu-input" style={{ flex: 1 }} value={text} placeholder="Add an address" onChange={(e: ChangeEvent<HTMLInputElement>) => setText(e.target.value)} />
          <button type="submit" className="aicu-btn aicu-btn-quiet" disabled={!text.trim()}>
            Add
          </button>
        </form>
      ) : null}
      <ErrorNote message={error} />
    </div>
  );
}

function Timeline(props: { readonly base: string; readonly recordHrefs: CustomersAdminProps["recordHrefs"]; readonly locale?: string }) {
  const [entries, setEntries] = useState<TimelineEntryWire[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(
    (cursor: string | null) => {
      request<TimelineResponse>(`${props.base}/timeline${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`)
        .then((page) => {
          setEntries((before) => (cursor ? [...before, ...page.entries] : [...page.entries]));
          setNext(page.nextCursor);
          setLoaded(true);
        })
        .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
    },
    [props.base],
  );
  useEffect(() => load(null), [load]);
  return (
    <div className="aicu-card aicu-stack">
      <h2 className="aicu-h2">Everything with this customer</h2>
      <ErrorNote message={error} />
      {loaded && entries.length === 0 ? <p className="aicu-muted">Nothing yet. Their quotes, visits, invoices, calls, orders and messages show here.</p> : null}
      <ul className="aicu-list">
        {entries.map((entry) => {
          const href = recordHref(props.recordHrefs, entry);
          return (
            <li key={entry.id} className="aicu-row">
              <span className="aicu-tag aicu-kind">{kindWords(entry.kind)}</span>
              {href ? <a href={href}>{entry.summary}</a> : <span>{entry.summary}</span>}
              <span className="aicu-when">{when(entry.occurredAt, props.locale)}</span>
            </li>
          );
        })}
      </ul>
      {next ? (
        <button type="button" className="aicu-btn aicu-btn-quiet" onClick={() => load(next)}>
          Show older
        </button>
      ) : null}
    </div>
  );
}

function MergePanel(props: { readonly baseUrl: string; readonly base: string; readonly customer: CustomerWire; readonly pageHref: string; readonly onMerged: (customer: CustomerWire) => void }) {
  const [q, setQ] = useState("");
  const [found, setFound] = useState<CustomerSummaryWire[]>([]);
  const [chosen, setChosen] = useState<CustomerSummaryWire | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  useEffect(() => {
    if (!q.trim()) {
      setFound([]);
      return;
    }
    const timer = setTimeout(() => {
      request<CustomerListResponse>(`${props.baseUrl}/v1/admin/customers?q=${encodeURIComponent(q.trim())}`)
        .then((res) => setFound(res.customers.filter((row) => row.id !== props.customer.id)))
        .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
    }, 250);
    return () => clearTimeout(timer);
  }, [q, props.baseUrl, props.customer.id]);
  const merge = () => {
    if (!chosen) return;
    request<MergeResponse>(`${props.base}/merge`, { method: "POST", body: JSON.stringify({ mergeId: chosen.id }) })
      .then((res) => {
        props.onMerged(res.customer);
        setDone(`${chosen.name} is now part of ${res.customer.name}: ${res.linksMoved} timeline ${res.linksMoved === 1 ? "entry" : "entries"} moved.`);
        setChosen(null);
        setQ("");
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  };
  return (
    <details className="aicu-card">
      <summary>Merge a duplicate into {props.customer.name}</summary>
      <div className="aicu-stack" style={{ marginTop: "0.75rem" }}>
        <p className="aicu-muted">When the same person was saved twice: their quotes, visits, invoices, calls, orders, messages, emails, phones and addresses all move here. The duplicate is kept in the record of merges, and never matched again.</p>
        <input className="aicu-input" type="search" value={q} placeholder="Find the duplicate" onChange={(e: ChangeEvent<HTMLInputElement>) => setQ(e.target.value)} />
        <ul className="aicu-list">
          {found.map((row) => (
            <li key={row.id}>
              <label className="aicu-row">
                <input type="radio" name="merge" checked={chosen?.id === row.id} onChange={() => setChosen(row)} />
                {row.name} {row.email ? <span className="aicu-muted">{row.email}</span> : null} {row.phone ? <span className="aicu-muted">{row.phone}</span> : null}
              </label>
            </li>
          ))}
        </ul>
        <ErrorNote message={error} />
        {done ? <p className="aicu-ok">{done}</p> : null}
        <div className="aicu-row">
          <button type="button" className="aicu-btn" disabled={!chosen} onClick={merge}>
            {chosen ? `Merge ${chosen.name} into ${props.customer.name}` : "Merge"}
          </button>
        </div>
      </div>
    </details>
  );
}

/**
 * What waits for staff on this record: new details a form brought ("Add" /
 * "Ignore"), a possible duplicate ("Merge" / "Not the same person"), a detail
 * another customer has ("OK"). Nothing a form sends changes a customer until
 * someone here says so.
 */
function Notices(props: {
  readonly baseUrl: string;
  readonly base: string;
  readonly customer: CustomerWire;
  readonly pageHref: string;
  readonly canManage: boolean;
  readonly onChange: (customer: CustomerWire) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const decide = (noticeId: string, action: "add" | "ignore" | "dismiss") =>
    request<CustomerResponse>(`${props.base}/notices/${encodeURIComponent(noticeId)}`, { method: "POST", body: JSON.stringify({ action }) })
      .then((res) => {
        props.onChange(res.customer);
        setError(null);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  const merge = (otherId: string) =>
    request<MergeResponse>(`${props.base}/merge`, { method: "POST", body: JSON.stringify({ mergeId: otherId }) })
      .then((res) => {
        props.onChange(res.customer);
        setError(null);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  return (
    <div className="aicu-stack" data-customer-notices="">
      {props.customer.notices.map((notice) => (
        <div key={notice.id} className="aicu-notice aicu-stack">
          <span>{notice.message}</span>
          {props.canManage ? (
            <div className="aicu-row">
              {notice.kind === "new-details" ? (
                <>
                  <button type="button" className="aicu-btn" onClick={() => void decide(notice.id, "add")}>
                    Add
                  </button>
                  <button type="button" className="aicu-btn aicu-btn-quiet" onClick={() => void decide(notice.id, "ignore")}>
                    Ignore
                  </button>
                </>
              ) : null}
              {notice.kind === "possible-duplicate" && notice.other ? (
                <>
                  <button type="button" className="aicu-btn" onClick={() => void merge(notice.other!.id)}>
                    Merge {notice.other.name} into {props.customer.name}
                  </button>
                  <button type="button" className="aicu-btn aicu-btn-quiet" onClick={() => void decide(notice.id, "dismiss")}>
                    Not the same person
                  </button>
                </>
              ) : null}
              {notice.kind === "shared-key" ? (
                <button type="button" className="aicu-btn aicu-btn-quiet" onClick={() => void decide(notice.id, "dismiss")}>
                  OK
                </button>
              ) : null}
              {notice.other ? <a href={customerHref(props.pageHref, notice.other.id)}>Open {notice.other.name}</a> : null}
            </div>
          ) : null}
        </div>
      ))}
      <ErrorNote message={error} />
    </div>
  );
}

/**
 * An answer that wasn't the package's own (a platform's error page, a proxy,
 * a timeout): what its HTTP status says, in plain words. The generic sentence
 * only when the status says nothing more (polish 3: no "Something went wrong"
 * where the cause is knowable).
 */
function statusWords(status: number, fallback = "Something went wrong. Please try again."): string {
  switch (status) {
    case 401:
      return "You've been signed out. Sign in again to keep working.";
    case 403:
      return "You don't have permission to do that.";
    case 404:
      return "That isn't here any more. Reload the page.";
    case 408:
    case 504:
      return "The site took too long to answer. Please try again in a minute.";
    case 413:
      return "That's too big to send.";
    case 429:
      return "That's a lot of tries in a short time. Wait a minute, then try again.";
    case 502:
    case 503:
      return "The site isn't answering right now. Please try again in a minute.";
    default:
      return fallback;
  }
}
