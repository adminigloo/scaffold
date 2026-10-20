import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createFilesClient, type FilesTransport } from "../client.js";
import type { ClientError, Result } from "../http.js";
import type { FileListWire, FileWire } from "../types.js";
import { Root, Spinner, type ChromeProps } from "../ui.js";
import { useFileActions } from "./actions.js";
import { missingTransport, safeHref } from "./RecordFiles.js";
import { Uploader } from "./Uploader.js";
import { MeterBody } from "./UsageMeter.js";
import { formatBytes, formatWhen, kindLabel, logoHint, purposeFilterLabel, WORDS } from "./words.js";

/**
 * The company's Files screen (section 7): what is stored, and how much room
 * is left.
 *
 *   <FilesManager baseUrl={`/api/app/${company.id}/files`} platformName="Igloo Back Office" supportEmail="help@igloo.example" />
 *
 * A page that already has its own heading passes `title={false}` (review
 * BO-11), so "Files" isn't said twice.
 *
 * FILTERS AS AN OWNER THINKS (review BO-22): "All", then each kind of record
 * the reader can see ("Visits", "Estimates", "Invoices"), "Not attached", and
 * the files that are on no record by nature ("Logo"); and a sort, "Newest
 * first" or "Largest first", so a full company can find its big files.
 *
 * A file that is removed where it is used (the logo, an estimate's own
 * photos) shows where to remove it instead of a Remove button. The server
 * drops the files a reader can't open; the usage stays the company's whole
 * usage.
 */

export interface FilesManagerProps extends ChromeProps {
  baseUrl?: string;
  transport?: FilesTransport;
  /** Who to ask for more room, in the full sentence (review BO-07): the platform's name. */
  platformName?: string;
  /** Review BO-6: the address to write to for more room, shown as a link in the full sentence. */
  supportEmail?: string;
  /** The card's heading, default "Files"; false (review BO-11) for a page that has its own. */
  title?: string | false;
  /** Review FH-11: where the logo is changed, in a few words ("company settings"). Absent: "Change it where you set your logo." */
  logoSettings?: string;
  locale?: string;
}

type Filter = { kind: "all" } | { kind: "record"; type: string } | { kind: "none" } | { kind: "purpose"; key: string };

const filterKey = (f: Filter) => (f.kind === "record" ? `record:${f.type}` : f.kind === "purpose" ? `purpose:${f.key}` : f.kind);

/** The purposes that are on no record by nature get a chip; attachments and the company's own uploads are covered by the record chips and "Not attached". */
const COVERED_PURPOSES = new Set(["attachment", "library"]);

async function safely<T>(call: () => Promise<Result<T>>): Promise<Result<T>> {
  try {
    return await call();
  } catch {
    return { ok: false, error: { code: "bad_response", message: "Something went wrong. Please try again.", status: 0 } };
  }
}

export function FilesManager(props: FilesManagerProps) {
  const { baseUrl, transport: given, platformName, supportEmail, title = "Files", logoSettings, locale, ...chrome } = props;
  const transport = useMemo(() => given ?? (baseUrl ? createFilesClient({ baseUrl }) : missingTransport()), [given, baseUrl]);
  const [filter, setFilter] = useState<Filter>({ kind: "all" });
  const [sort, setSort] = useState<"newest" | "size">("newest");
  const [page, setPage] = useState<{ state: "loading" } | { state: "error"; error: ClientError } | { state: "ready"; data: FileListWire }>({ state: "loading" });
  const [more, setMore] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null });
  const [announce, setAnnounce] = useState("");
  // Review BO-10: a file was just refused because storage is full, so the
  // meter says full (not "almost full") until a file is added or removed.
  const [refusedFull, setRefusedFull] = useState(false);
  const alive = useRef(true);
  const generation = useRef(0);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const query = useCallback(
    (cursor?: string) => ({
      ...(filter.kind === "record" ? { record: filter.type } : filter.kind === "none" ? { record: "none" } : {}),
      ...(filter.kind === "purpose" ? { purpose: filter.key } : {}),
      sort,
      ...(cursor ? { cursor } : {}),
    }),
    [filter, sort],
  );

  const refresh = useCallback(async () => {
    const mine = (generation.current += 1);
    const res = await safely(() => transport.files(query()));
    if (!alive.current || mine !== generation.current) return;
    setPage(res.ok ? { state: "ready", data: res.data } : { state: "error", error: res.error });
  }, [transport, query]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const loadMore = async () => {
    if (page.state !== "ready" || !page.data.nextCursor) return;
    setMore({ busy: true, error: null });
    const mine = generation.current;
    const res = await safely(() => transport.files(query(page.data.nextCursor ?? undefined)));
    if (!alive.current || mine !== generation.current) return;
    if (!res.ok) {
      setMore({ busy: false, error: res.error.message });
      return;
    }
    setMore({ busy: false, error: null });
    setPage((current) =>
      current.state === "ready"
        ? { state: "ready", data: { ...res.data, files: [...current.data.files, ...res.data.files.filter((f) => !current.data.files.some((g) => g.id === f.id))] } }
        : current,
    );
  };

  const actions = useFileActions(transport, setAnnounce, () => {
    setRefusedFull(false);
    void refresh();
  });
  const send = useCallback((file: Blob, name: string) => transport.upload(file, name), [transport]);
  const onAdded = useCallback(() => {
    setRefusedFull(false);
    void refresh();
  }, [refresh]);
  const onFailed = useCallback((error: ClientError) => {
    if (error.code === "storage_full") setRefusedFull(true);
  }, []);

  const choose = (next: Filter) => {
    setFilter(next);
    setPage({ state: "loading" });
  };

  let body: React.ReactNode;
  if (page.state === "loading") body = <Spinner label={WORDS.loadingFiles} />;
  else if (page.state === "error") {
    body = (
      <div className="aifw-stack">
        <p className="aifw-notice aifw-notice-error" role="alert">
          {page.error.status === 404 || page.error.code === "not_found" ? WORDS.notAvailable : page.error.message}
        </p>
        <div className="aifw-actions">
          <button
            type="button"
            className="aifw-btn aifw-btn-secondary"
            onClick={() => {
              setPage({ state: "loading" });
              void refresh();
            }}
          >
            {WORDS.retry}
          </button>
        </div>
      </div>
    );
  } else {
    const data = page.data;
    const chips: { filter: Filter; label: string }[] = [
      { filter: { kind: "all" }, label: WORDS.all },
      ...data.recordTypes.map((r) => ({ filter: { kind: "record", type: r.type } as Filter, label: r.label })),
      { filter: { kind: "none" }, label: WORDS.notAttached },
      ...data.purposes.filter((p) => !COVERED_PURPOSES.has(p.key)).map((p) => ({ filter: { kind: "purpose", key: p.key } as Filter, label: purposeFilterLabel(p) })),
    ];
    const whereToRemove = (file: FileWire): string | null => {
      // Only a person who manages files is told where to remove one.
      if (file.canRemove || !data.canUpload) return null;
      if (file.purpose === "company.logo") return logoHint(logoSettings);
      if (file.record && file.purpose !== "attachment") return `Remove it on ${file.record.label}.`;
      return null;
    };
    const attachedTo = (file: FileWire) => {
      if (!file.record) return <span className="aifw-muted">{WORDS.notAttached}</span>;
      const href = safeHref(file.record.href);
      return href ? <a href={href}>{file.record.label}</a> : <span>{file.record.label}</span>;
    };
    const fileLink = (file: FileWire) => (
      <a href={safeHref(file.url) ?? "#"} target="_blank" rel="noopener noreferrer">
        {file.name}
      </a>
    );
    const rowActions = (file: FileWire) => {
      const hint = whereToRemove(file);
      return (
        <div className="aifw-actions">
          {actions.buttons(file)}
          {hint ? <span className="aifw-small">{hint}</span> : null}
        </div>
      );
    };
    body = (
      <>
        <MeterBody
          usage={data.usage}
          platformName={platformName}
          supportEmail={supportEmail}
          // Review BO-9: someone who can't add or remove files is told to ask the owner.
          canMakeRoom={data.canUpload}
          refusedFull={refusedFull}
          locale={locale}
        />
        {data.canUpload ? (
          data.uploads.available ? (
            <Uploader rules={data.uploads} send={send} onAdded={onAdded} onStatus={setAnnounce} onFailed={onFailed} mode="library" />
          ) : (
            <p className="aifw-notice aifw-notice-warn">{data.uploads.offReason ?? "Files can't be added right now."}</p>
          )
        ) : null}
        <div className="aifw-row">
          <div className="aifw-filters aifw-grow" role="group" aria-label="Show">
            {chips.map((chip) => (
              <button
                key={filterKey(chip.filter)}
                type="button"
                className="aifw-chip"
                aria-pressed={filterKey(chip.filter) === filterKey(filter)}
                onClick={() => choose(chip.filter)}
              >
                {chip.label}
              </button>
            ))}
          </div>
          <label className="aifw-row aifw-small">
            <span>Sort</span>
            <select
              className="aifw-select"
              value={sort}
              onChange={(event) => {
                setSort(event.target.value === "size" ? "size" : "newest");
                setPage({ state: "loading" });
              }}
            >
              <option value="newest">{WORDS.newest}</option>
              <option value="size">{WORDS.largest}</option>
            </select>
          </label>
        </div>
        {data.files.length === 0 ? (
          <div className="aifw-empty" data-aifw-empty="">
            <p className="aifw-empty-title">{WORDS.filesEmptyTitle}</p>
            <p className="aifw-empty-text">{WORDS.filesEmptyText}</p>
          </div>
        ) : (
          <>
            <table className="aifw-table">
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Attached to</th>
                  <th scope="col">Size</th>
                  <th scope="col">Added</th>
                  <th scope="col">By</th>
                  <th scope="col">
                    <span className="aifw-sr">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.files.map((file) => (
                  <tr key={file.id} data-aifw-file={file.id}>
                    <td>
                      {fileLink(file)}
                      <div className="aifw-small">{kindLabel(file)}</div>
                    </td>
                    <td>{attachedTo(file)}</td>
                    <td>{formatBytes(file.sizeBytes, locale)}</td>
                    <td>{formatWhen(file.at, locale)}</td>
                    <td>{file.addedBy ?? ""}</td>
                    <td>{rowActions(file)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <ul className="aifw-cards">
              {data.files.map((file) => (
                <li key={file.id} className="aifw-file-card" data-aifw-card={file.id}>
                  <span className="aifw-doc-name">{fileLink(file)}</span>
                  <span className="aifw-small">
                    {kindLabel(file)} · {formatBytes(file.sizeBytes, locale)} · {formatWhen(file.at, locale)}
                    {file.addedBy ? ` · ${file.addedBy}` : ""}
                  </span>
                  <span className="aifw-small">{attachedTo(file)}</span>
                  {rowActions(file)}
                </li>
              ))}
            </ul>
          </>
        )}
        {data.nextCursor ? (
          <div className="aifw-actions">
            <button type="button" className="aifw-btn aifw-btn-secondary" disabled={more.busy} onClick={() => void loadMore()}>
              {WORDS.loadMore}
            </button>
            {more.error ? <span className="aifw-danger-text">{more.error}</span> : null}
          </div>
        ) : null}
      </>
    );
  }

  return (
    <Root {...chrome}>
      <section className="aifw-card" aria-label={title === false ? "Files" : title}>
        {title === false ? null : <h2 className="aifw-h2">{title}</h2>}
        {body}
        <p className="aifw-sr" role="status" aria-live="polite">
          {announce}
        </p>
      </section>
      {actions.dialogs}
    </Root>
  );
}
