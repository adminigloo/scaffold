import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { cleanInputs, CustomerFields, Stepper } from "../fields.js";
import { formatDate, formatDateTime, formatMoney, formatPercent, formatRange } from "../format.js";
import type { ClientError, Result } from "../http.js";
import { CameraIcon, ChevronIcon, copyText, CopyField, Dialog, Field, Loading, Notice, SparkIcon, useMounted } from "../parts.js";
import { resizePhoto } from "../photo.js";
import type { CustomerInputs } from "../types.js";
import type { EstimatorAdminTransport } from "./client.js";
import { adminErrorText, bpToInput, centsToInput, parseMoneyInput, parsePercentInput, SOURCE_LABEL, statusLabel } from "./helpers.js";
import type { AdminProduct, EstimateAction, EstimateDetail, EstimateLineWire, EstimateMutationResponse, EstimatePhoto, LinkedInvoice } from "./types.js";
import { AdminFrame, Check, LoadError, Panel, ToastRegion, useAdminBasics, useAdminTransport, useToasts, type AdminChromeProps } from "./ui.js";

/**
 * <EstimateEditor> — one lead or quote, worked by staff (contract 9.7).
 *
 *   header     number, where it stands, where it came from, the actions it
 *              offers right now (from the server's `actions`, never guessed)
 *   customer   who and where (editable in a draft), what they wrote, and
 *              the office's own notes (always editable)
 *   photos     the customer's photos, opened large; staff can add their own
 *   lines      each line's questions (the product's own fields), quantity,
 *              options, "Set the price myself", the working the customer saw,
 *              and — when a photo was read — what the AI counted beside what
 *              the customer finally said ("The customer changed: steps 3 → 4")
 *   totals     subtotal, discount, tax, total; what the customer was shown;
 *              cost and margin for those who may see them
 *   actions    send the quote (and say exactly what the customer gets),
 *              resend, revise, record a yes or a no, copy the link, archive,
 *              duplicate, make an invoice, book the visit
 *
 * Every change is one request whose answer is the WHOLE estimate again, so
 * the screen re-renders from what the server saved — totals included — and
 * never adds anything up itself.
 */

export interface EstimateEditorProps extends AdminChromeProps {
  estimateId: string;
  /** "Back to estimates" as a link. */
  backHref?: string;
  /** "Back to estimates" as a button (in-place navigation). */
  onBack?: () => void;
  /** After every saved change. */
  onChange?: (estimate: EstimateDetail) => void;
  /** Open another estimate (after "Duplicate"). */
  onOpenEstimate?: (id: string) => void;
}

type DialogKind = null | "send" | "revise" | "yes" | "no" | "convert";

const ACTION_ORDER: readonly EstimateAction[] = [
  "send",
  "resend",
  "mark_accepted",
  "mark_declined",
  "revise",
  "reopen",
  "convert",
  "book_visit",
  "copy_link",
  "duplicate",
  "archive",
  "unarchive",
];

export function EstimateEditor(props: EstimateEditorProps) {
  const transport = useAdminTransport(props.transport, props.baseUrl);
  const basics = useAdminBasics(transport);
  const mounted = useMounted();
  const locale = props.locale ?? basics.settings?.locale ?? "en-US";
  const [estimate, setEstimate] = useState<EstimateDetail | null>(null);
  const [error, setError] = useState<ClientError | null>(null);
  const [reload, setReload] = useState(0);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [dialog, setDialog] = useState<DialogKind>(null);
  const [link, setLink] = useState<string | null>(null);
  const [invoice, setInvoice] = useState<LinkedInvoice | null>(null);
  const { toasts, push, dismiss } = useToasts();
  const [products, setProducts] = useState<Record<string, AdminProduct>>({});
  const [catalog, setCatalog] = useState<AdminProduct[] | null>(null);
  const asked = useRef(new Set<string>());

  useEffect(() => {
    let alive = true;
    setError(null);
    void transport.getEstimate(props.estimateId).then((res) => {
      if (!alive) return;
      if (res.ok) setEstimate(res.data.estimate);
      else setError(res.error);
    });
    return () => {
      alive = false;
    };
  }, [transport, props.estimateId, reload]);

  // The products behind the lines, each asked once (their fields are what the line asks).
  const productIds = useMemo(() => [...new Set((estimate?.lines ?? []).map((l) => l.productId).filter((id): id is string => Boolean(id)))], [estimate]);
  useEffect(() => {
    for (const id of productIds) {
      if (asked.current.has(id)) continue;
      asked.current.add(id);
      void transport.getProduct(id).then((res) => {
        if (res.ok && mounted.current) setProducts((map) => ({ ...map, [id]: res.data.product }));
      });
    }
  }, [productIds, transport, mounted]);

  const loadCatalog = useCallback(() => {
    if (catalog) return;
    void transport.listProducts().then((res) => {
      if (!mounted.current) return;
      if (res.ok) {
        setCatalog(res.data.products.filter((p) => p.isActive));
        setProducts((map) => {
          const next = { ...map };
          for (const p of res.data.products) next[p.id] = p;
          return next;
        });
      } else setCatalog([]);
    });
  }, [catalog, transport, mounted]);

  /** Run one change; the answer is the whole estimate, shown as saved. */
  const mutate = useCallback(
    async (label: string, run: () => Promise<Result<EstimateMutationResponse>>, ok?: string): Promise<boolean> => {
      setBusy(label);
      const res = await run();
      if (!mounted.current) return false;
      setBusy(null);
      if (!res.ok) {
        push("error", adminErrorText(res.error));
        return false;
      }
      setEstimate(res.data.estimate);
      setWarnings(res.data.warnings);
      props.onChange?.(res.data.estimate);
      if (ok) push("ok", ok);
      return true;
    },
    [mounted, push, props],
  );

  const back = props.backHref ? (
    <a className="aiew-btn aiew-btn-link" href={props.backHref}>
      <ChevronIcon direction="left" />
      Back to estimates
    </a>
  ) : props.onBack ? (
    <button type="button" className="aiew-btn aiew-btn-link" onClick={props.onBack}>
      <ChevronIcon direction="left" />
      Back to estimates
    </button>
  ) : null;

  if (!estimate) {
    return (
      <AdminFrame chrome={props} basics={basics} data={{ "aiew-editor": error ? "error" : "loading" }}>
        {back}
        {error ? <LoadError error={error} onRetry={() => setReload((n) => n + 1)} /> : <Loading label="Loading the estimate…" />}
      </AdminFrame>
    );
  }

  const money = (cents: number) => formatMoney(cents, estimate.currency, locale);
  const editable = estimate.actions.includes("edit");
  const status = statusLabel(estimate);
  const id = estimate.id;
  const has = (action: EstimateAction) => estimate.actions.includes(action);
  const sendBlock = !estimate.customerEmail ? "Add the customer's email address to send the quote." : estimate.lines.length === 0 ? "Add at least one line before sending." : null;
  const emailsOff = basics.status ? !basics.status.delivery.emails : false;

  const copyLink = async () => {
    setBusy("link");
    const res = await transport.quoteLink(id);
    setBusy(null);
    if (!res.ok) return push("error", adminErrorText(res.error));
    setLink(res.data.url);
    const copied = await copyText(res.data.url);
    push("ok", copied ? "Quote link copied." : "Here's the quote link. Copy it from the box.");
  };

  const duplicate = async () => {
    setBusy("duplicate");
    const res = await transport.duplicate(id);
    setBusy(null);
    if (!res.ok) return push("error", adminErrorText(res.error));
    push("ok", `Made a copy: ${res.data.estimate.number}.`);
    props.onOpenEstimate?.(res.data.estimate.id);
  };

  const convert = async () => {
    setBusy("convert");
    const res = await transport.convert(id);
    setBusy(null);
    setDialog(null);
    if (!res.ok) return push("error", adminErrorText(res.error));
    setEstimate(res.data.estimate);
    setInvoice(res.data.invoice);
    props.onChange?.(res.data.estimate);
    push("ok", `Invoice ${res.data.invoice.number} made.`);
  };

  const actionButton = (action: EstimateAction): ReactNode => {
    const disabled = busy !== null;
    switch (action) {
      case "send":
        return (
          <span key={action} className="aiew-row">
            <button type="button" className="aiew-btn aiew-btn-primary" disabled={disabled || Boolean(sendBlock)} onClick={() => setDialog("send")} data-action="send" aria-describedby={sendBlock ? `${id}-send-why` : undefined}>
              Send quote
            </button>
            {sendBlock ? (
              <span className="aiew-hint" id={`${id}-send-why`}>
                {sendBlock}
              </span>
            ) : null}
          </span>
        );
      case "resend":
        return (
          <button key={action} type="button" className="aiew-btn aiew-btn-secondary" disabled={disabled} data-action="resend" onClick={() => void mutate("resend", () => transport.resendQuote(id), `Sent again to ${estimate.customerEmail ?? "the customer"}.`)}>
            Send again
          </button>
        );
      case "revise":
        return (
          <button key={action} type="button" className="aiew-btn aiew-btn-secondary" disabled={disabled} data-action="revise" onClick={() => setDialog("revise")}>
            Revise
          </button>
        );
      case "mark_accepted":
        return (
          <button key={action} type="button" className="aiew-btn aiew-btn-secondary" disabled={disabled} data-action="mark_accepted" onClick={() => setDialog("yes")}>
            Customer said yes
          </button>
        );
      case "mark_declined":
        return (
          <button key={action} type="button" className="aiew-btn aiew-btn-secondary" disabled={disabled} data-action="mark_declined" onClick={() => setDialog("no")}>
            Customer said no
          </button>
        );
      case "reopen":
        return (
          <button key={action} type="button" className="aiew-btn aiew-btn-secondary" disabled={disabled} data-action="reopen" onClick={() => void mutate("reopen", () => transport.setStatus(id, { status: "draft" }), "Reopened as a draft.")}>
            Reopen
          </button>
        );
      case "copy_link":
        return (
          <button key={action} type="button" className="aiew-btn aiew-btn-secondary" disabled={disabled} data-action="copy_link" onClick={() => void copyLink()}>
            Copy quote link
          </button>
        );
      case "archive":
        return (
          <button key={action} type="button" className="aiew-btn aiew-btn-secondary" disabled={disabled} data-action="archive" onClick={() => void mutate("archive", () => transport.archive(id), "Archived.")}>
            Archive
          </button>
        );
      case "unarchive":
        return (
          <button key={action} type="button" className="aiew-btn aiew-btn-secondary" disabled={disabled} data-action="unarchive" onClick={() => void mutate("unarchive", () => transport.unarchive(id), "Back in the list.")}>
            Unarchive
          </button>
        );
      case "duplicate":
        return (
          <button key={action} type="button" className="aiew-btn aiew-btn-secondary" disabled={disabled} data-action="duplicate" onClick={() => void duplicate()}>
            Duplicate
          </button>
        );
      case "convert":
        return (
          <button key={action} type="button" className="aiew-btn aiew-btn-primary" disabled={disabled} data-action="convert" onClick={() => setDialog("convert")}>
            Make an invoice
          </button>
        );
      case "book_visit":
        return estimate.links.bookVisitUrl ? (
          <a key={action} className="aiew-btn aiew-btn-secondary" href={estimate.links.bookVisitUrl} target="_blank" rel="noopener noreferrer" data-action="book_visit">
            Book the visit
          </a>
        ) : null;
      default:
        return null;
    }
  };

  const shownDiffers = estimate.rangeLow !== estimate.rangeHigh || estimate.rangeLow !== estimate.subtotal;
  const linkedInvoice = invoice ?? estimate.links.invoice;

  return (
    <AdminFrame chrome={props} basics={basics} data={{ "aiew-editor": "ready", "aiew-status": estimate.status }}>
      {back}
      <header className="aiew-stack-sm">
        <div className="aiew-admin-head">
          <h2 className="aiew-admin-title">
            {estimate.customerName || "New estimate"} <span className="aiew-muted">· {estimate.number}</span>
          </h2>
          <span className={`aiew-tag aiew-tag-${status.tone}`} data-aiew-status-tag="">
            {status.label}
          </span>
        </div>
        <p className="aiew-muted">
          {SOURCE_LABEL[estimate.source]} · Made {formatDateTime(estimate.createdAt, locale, basics.settings?.timeZone ?? "UTC")}
          {estimate.validUntil && (estimate.status === "sent" || estimate.status === "viewed") ? ` · Good until ${formatDate(estimate.validUntil, locale, basics.settings?.timeZone ?? "UTC")}` : ""}
          {estimate.archivedAt ? " · Archived" : ""}
        </p>
        <div className="aiew-actionbar" data-aiew-actions="">
          {ACTION_ORDER.filter(has).map(actionButton)}
        </div>
        {!editable && (estimate.status === "sent" || estimate.status === "viewed") ? (
          <p className="aiew-hint">This quote has been sent. Revise it to make changes.</p>
        ) : null}
        {link ? <CopyField label="Quote link" value={link} buttonLabel="Copy link" hint="Anyone with this link can see and answer the quote." /> : null}
        {warnings.length > 0 ? (
          <Notice tone="warn" data="warnings">
            {warnings.map((w, i) => (
              <span key={i} style={{ display: "block" }}>
                {w}
              </span>
            ))}
          </Notice>
        ) : null}
        {estimate.responseNote ? (
          <Notice tone="info" data="response-note">
            {estimate.responseName ? `${estimate.responseName} wrote` : "The customer wrote"}: “{estimate.responseNote}”
          </Notice>
        ) : null}
      </header>

      <CustomerPanel estimate={estimate} editable={editable} mutate={mutate} transport={transport} />

      <PhotosPanel estimate={estimate} mutate={mutate} transport={transport} push={push} />

      <Panel id="lines" title="Lines">
        {estimate.lines.length === 0 ? <p className="aiew-muted">No lines yet. Add one below.</p> : null}
        {estimate.lines.map((line, i) => (
          <LineCard
            key={line.id}
            n={i + 1}
            line={line}
            product={line.productId ? (products[line.productId] ?? null) : null}
            photos={estimate.photos}
            fromCustomer={estimate.source !== "staff"}
            editable={editable}
            money={money}
            onPatch={(patch, ok) => mutate(`line:${line.id}`, () => transport.updateLine(id, line.id, patch), ok)}
            onRemove={() => mutate(`remove:${line.id}`, () => transport.removeLine(id, line.id), "Line removed.")}
          />
        ))}
        {editable ? <AddLine catalog={catalog} onOpen={loadCatalog} money={money} onAdd={(body) => mutate("add", () => transport.addLine(id, body), "Line added.")} /> : null}
      </Panel>

      <TotalsPanel estimate={estimate} editable={editable} money={money} locale={locale} shownDiffers={shownDiffers} mutate={mutate} transport={transport} />

      {estimate.links.visits.length > 0 || linkedInvoice ? (
        <Panel id="linked" title="Linked">
          <ul className="aiew-stack-sm" style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {estimate.links.visits.map((visit) => (
              <li key={visit.id}>
                Visit: {visit.url ? <a href={visit.url}>{visit.when}</a> : visit.when} ({visit.status})
              </li>
            ))}
            {linkedInvoice ? (
              <li data-aiew-invoice="">
                Invoice: {linkedInvoice.url ? <a href={linkedInvoice.url}>{linkedInvoice.number}</a> : linkedInvoice.number} ({linkedInvoice.status})
              </li>
            ) : null}
          </ul>
        </Panel>
      ) : null}

      {estimate.timeline.length > 0 ? (
        <Panel id="timeline" title="What's happened">
          <ol className="aiew-timeline">
            {estimate.timeline.map((entry, i) => (
              <li key={`${i}:${entry.at}`}>
                <time dateTime={entry.at}>{formatDateTime(entry.at, locale, basics.settings?.timeZone ?? "UTC")}</time>
                <span>{entry.label}</span>
              </li>
            ))}
          </ol>
        </Panel>
      ) : null}

      {dialog === "send" ? (
        <SendDialog
          estimate={estimate}
          money={money}
          defaultDays={basics.settings?.quoteValidDays ?? 30}
          emailsOff={emailsOff}
          busy={busy === "send"}
          onClose={() => setDialog(null)}
          onSend={async (body) => {
            const ok = await mutate("send", () => transport.sendQuote(id, body), `Quote sent to ${estimate.customerEmail ?? "the customer"}.`);
            if (ok) setDialog(null);
          }}
        />
      ) : null}
      {dialog === "revise" ? (
        <Dialog title="Revise this quote?" onClose={() => setDialog(null)}>
          <p>It goes back to a draft so you can change it. Their link will say the quote is being updated until you send it again, and the follow-up email is cancelled.</p>
          <div className="aiew-actions">
            <button
              type="button"
              className="aiew-btn aiew-btn-primary"
              data-autofocus=""
              disabled={busy !== null}
              onClick={() => void mutate("revise", () => transport.reviseQuote(id), "Back to a draft. Send it again when it's ready.").then((ok) => ok && setDialog(null))}
            >
              Revise it
            </button>
            <button type="button" className="aiew-btn aiew-btn-secondary" onClick={() => setDialog(null)}>
              Cancel
            </button>
          </div>
        </Dialog>
      ) : null}
      {dialog === "yes" || dialog === "no" ? (
        <AnswerDialog
          kind={dialog}
          hasEmail={Boolean(estimate.customerEmail)}
          busy={busy !== null}
          onClose={() => setDialog(null)}
          onConfirm={async (note, notify) => {
            const ok = await mutate(
              dialog,
              () => transport.setStatus(id, { status: dialog === "yes" ? "approved" : "rejected", note: note || null, ...(dialog === "yes" ? { notify } : {}) }),
              dialog === "yes" ? "Marked accepted." : "Marked declined.",
            );
            if (ok) setDialog(null);
          }}
        />
      ) : null}
      {dialog === "convert" ? (
        <Dialog title="Make an invoice from this quote?" onClose={() => setDialog(null)}>
          <p>The invoice gets these lines and the total of {money(estimate.total)}. The quote is marked invoiced.</p>
          <div className="aiew-actions">
            <button type="button" className="aiew-btn aiew-btn-primary" data-autofocus="" disabled={busy !== null} onClick={() => void convert()}>
              Make the invoice
            </button>
            <button type="button" className="aiew-btn aiew-btn-secondary" onClick={() => setDialog(null)}>
              Cancel
            </button>
          </div>
        </Dialog>
      ) : null}
      <ToastRegion toasts={toasts} onDismiss={dismiss} />
    </AdminFrame>
  );
}

type Mutate = (label: string, run: () => Promise<Result<EstimateMutationResponse>>, ok?: string) => Promise<boolean>;

// ---------------------------------------------------------------------------
// Customer
// ---------------------------------------------------------------------------

/** A text field that saves when it loses focus (and only when it changed). */
function BlurField({
  id,
  label,
  value,
  onSave,
  disabled,
  type = "text",
  multiline,
  hint,
  optional,
}: {
  id: string;
  label: string;
  value: string;
  onSave: (value: string) => void;
  disabled?: boolean;
  type?: string;
  multiline?: boolean;
  hint?: string;
  optional?: boolean;
}) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const commit = () => {
    if (text.trim() !== value.trim()) onSave(text.trim());
  };
  return (
    <Field id={id} label={label} hint={hint} optional={optional}>
      {multiline ? (
        <textarea id={id} className="aiew-input" rows={3} value={text} disabled={disabled} aria-describedby={hint ? `${id}-hint` : undefined} onChange={(e) => setText(e.target.value)} onBlur={commit} />
      ) : (
        <input id={id} className="aiew-input" type={type} value={text} disabled={disabled} aria-describedby={hint ? `${id}-hint` : undefined} onChange={(e) => setText(e.target.value)} onBlur={commit} />
      )}
    </Field>
  );
}

function CustomerPanel({ estimate, editable, mutate, transport }: { estimate: EstimateDetail; editable: boolean; mutate: Mutate; transport: EstimatorAdminTransport }) {
  const ids = useId();
  const save = (patch: Parameters<EstimatorAdminTransport["updateEstimate"]>[1]) => void mutate("customer", () => transport.updateEstimate(estimate.id, patch), "Saved.");
  return (
    <Panel id="customer" title="Customer">
      <div className="aiew-grid2">
        <BlurField id={`${ids}-name`} label="Name" value={estimate.customerName ?? ""} disabled={!editable} onSave={(v) => save({ customerName: v || null })} />
        <BlurField id={`${ids}-email`} label="Email" type="email" value={estimate.customerEmail ?? ""} disabled={!editable} onSave={(v) => save({ customerEmail: v || null })} />
        <BlurField id={`${ids}-phone`} label="Phone" type="tel" value={estimate.customerPhone ?? ""} disabled={!editable} onSave={(v) => save({ customerPhone: v || null })} />
        <BlurField id={`${ids}-address`} label="Address of the job" value={estimate.jobAddress ?? ""} disabled={!editable} onSave={(v) => save({ jobAddress: v || null })} />
      </div>
      {estimate.notes ? (
        <div className="aiew-sub-box">
          <strong>What they wrote</strong>
          <p style={{ whiteSpace: "pre-wrap" }}>{estimate.notes}</p>
        </div>
      ) : null}
      <BlurField
        id={`${ids}-internal`}
        label="Notes for the office"
        optional
        multiline
        hint="Only staff see these. You can change them any time."
        value={estimate.internalNotes ?? ""}
        onSave={(v) => save({ internalNotes: v || null })}
      />
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// Photos
// ---------------------------------------------------------------------------

function PhotosPanel({
  estimate,
  mutate,
  transport,
  push,
}: {
  estimate: EstimateDetail;
  mutate: Mutate;
  transport: EstimatorAdminTransport;
  push: (tone: "ok" | "warn" | "error", text: string) => void;
}) {
  const ids = useId();
  const [open, setOpen] = useState<number | null>(null);
  const [adding, setAdding] = useState(false);
  const photos = estimate.photos;
  const add = async (file: File) => {
    setAdding(true);
    try {
      const resized = await resizePhoto(file, { maxEdgePx: 768, quality: 0.8 });
      await mutate("photo", () => transport.addPhoto(estimate.id, { imageBase64: resized.base64, mediaType: "image/jpeg" }), "Photo added.");
    } catch (error) {
      push("error", error instanceof Error && error.message ? error.message : "That file isn't a photo we can read.");
    }
    setAdding(false);
  };
  const current = open !== null ? photos[open] : undefined;
  return (
    <Panel id="photos" title={`Photos (${photos.length})`}>
      {photos.length === 0 ? <p className="aiew-muted">No photos.</p> : null}
      {photos.length > 0 ? (
        <ul className="aiew-photo-grid">
          {photos.map((photo, i) => (
            <li key={photo.id} className="aiew-photo-tile">
              <button type="button" className="aiew-photo-open" aria-label={`Open photo ${i + 1} of ${photos.length}`} onClick={() => setOpen(i)} data-aiew-photo={photo.id}>
                <img src={photo.url} alt="" />
              </button>
              <span className="aiew-hint">{photo.source === "staff" ? "Added by staff" : "From the customer"}</span>
              <button
                type="button"
                className="aiew-btn aiew-btn-secondary aiew-btn-sm"
                onClick={() => void mutate("photo-remove", () => transport.removePhoto(estimate.id, photo.id), "Photo removed.")}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="aiew-photo-actions">
        <input
          id={`${ids}-file`}
          className="aiew-file"
          type="file"
          accept="image/*"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file) void add(file);
          }}
        />
        <label htmlFor={`${ids}-file`} className="aiew-btn aiew-btn-secondary" aria-busy={adding || undefined}>
          <CameraIcon />
          {adding ? "Adding…" : "Add photo"}
        </label>
      </div>
      {current && open !== null ? (
        <Lightbox photos={photos} index={open} onIndex={setOpen} onClose={() => setOpen(null)} />
      ) : null}
    </Panel>
  );
}

function Lightbox({ photos, index, onIndex, onClose }: { photos: EstimatePhoto[]; index: number; onIndex: (i: number) => void; onClose: () => void }) {
  const photo = photos[index]!;
  const prev = () => onIndex((index - 1 + photos.length) % photos.length);
  const next = () => onIndex((index + 1) % photos.length);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "ArrowLeft") prev();
      else if (event.key === "ArrowRight") next();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });
  return (
    <Dialog title={`Photo ${index + 1} of ${photos.length}`} onClose={onClose} wide data={{ "aiew-lightbox": photo.id }}>
      <img className="aiew-lightbox-img" src={photo.url} alt={`Photo ${index + 1} of ${photos.length}`} />
      {photos.length > 1 ? (
        <div className="aiew-actions">
          <button type="button" className="aiew-btn aiew-btn-secondary" onClick={prev}>
            <ChevronIcon direction="left" />
            Previous
          </button>
          <button type="button" className="aiew-btn aiew-btn-secondary" onClick={next}>
            Next
            <ChevronIcon direction="right" />
          </button>
        </div>
      ) : null}
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// A line
// ---------------------------------------------------------------------------

/** "steps 3 → 4, step height — → 7.25": what the customer changed from the photo's reading. */
export function correctionText(corrections: EstimateLineWire["corrections"]): string {
  return corrections.map((c) => `${c.label.toLowerCase()} ${c.from} → ${c.to ?? "—"}`).join(", ");
}

function LineCard({
  n,
  line,
  product,
  photos,
  fromCustomer,
  editable,
  money,
  onPatch,
  onRemove,
}: {
  n: number;
  line: EstimateLineWire;
  product: AdminProduct | null;
  photos: EstimatePhoto[];
  /** A website or photo lead: a customer was shown its range. Not on one staff made (review EST-R11). */
  fromCustomer: boolean;
  editable: boolean;
  money: (cents: number) => string;
  onPatch: (patch: Parameters<EstimatorAdminTransport["updateLine"]>[2], ok?: string) => Promise<boolean>;
  onRemove: () => void;
}) {
  const ids = useId();
  const [values, setValues] = useState<CustomerInputs>(line.inputs ?? {});
  const pending = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputsKey = JSON.stringify(line.inputs ?? {});
  useEffect(() => {
    if (!pending.current) setValues(line.inputs ?? {});
  }, [inputsKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const flushRef = useRef<() => void>(() => {});
  useEffect(
    () => () => {
      // Leaving with a change not yet sent: send it now rather than lose it.
      if (timer.current) clearTimeout(timer.current);
      if (pending.current) flushRef.current();
    },
    [],
  );

  const [override, setOverride] = useState(line.priceOverridden);
  const [price, setPrice] = useState(centsToInput(line.unitPrice));
  useEffect(() => {
    setOverride(line.priceOverridden);
    setPrice(centsToInput(line.unitPrice));
  }, [line.priceOverridden, line.unitPrice]);

  const saveInputs = (next: CustomerInputs) => {
    if (!product) return;
    pending.current = false;
    void onPatch({ inputs: cleanInputs(product.fields, next) });
  };
  flushRef.current = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (pending.current) saveInputs(values);
  };
  const onFields = (next: CustomerInputs) => {
    setValues(next);
    pending.current = true;
    if (timer.current) clearTimeout(timer.current);
    // Saved half a second after the last change (a stepper tap, a typed number):
    // each save answers with the whole estimate, re-priced.
    timer.current = setTimeout(() => saveInputs(next), 500);
  };

  const reading = line.reading;
  const readingPhoto = reading ? photos.find((p) => p.takeoffId === reading.takeoffId) : undefined;
  const ranged = line.lowTotal !== line.highTotal;
  const selected = new Map(line.options.map((o) => [o.optionId, o.valueId]));
  const countRecipe = product?.recipe === "count";

  return (
    <article className="aiew-line" data-aiew-line={line.id} aria-labelledby={`${ids}-title`}>
      <div className="aiew-line-head">
        <div className="aiew-stack-sm aiew-grow">
          <h4 className="aiew-h3" id={`${ids}-title`}>
            {n}. {line.description}
          </h4>
          {line.inputsSummary ? <p className="aiew-muted">{line.inputsSummary}</p> : null}
        </div>
        <span className="aiew-line-total" data-aiew-line-total="">
          {money(line.total)}
        </span>
      </div>

      {editable ? (
        <BlurField id={`${ids}-desc`} label="Description" value={line.description} onSave={(v) => v && void onPatch({ description: v })} />
      ) : null}

      {product ? (
        <div className="aiew-stack" data-aiew-line-fields="">
          <div
            onBlur={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) flushRef.current();
            }}
          >
            <CustomerFields fields={product.fields} values={values} onChange={onFields} disabled={!editable || override} />
          </div>
          {product.allowMultiple && !countRecipe ? (
            <div className="aiew-field">
              <label className="aiew-label" htmlFor={`${ids}-qty`}>
                {product.multipleLabel ?? "How many?"}
              </label>
              <Stepper id={`${ids}-qty`} label={product.multipleLabel ?? "How many?"} value={line.quantity} min={1} max={product.maxQuantity} disabled={!editable} onValue={(q) => q && q !== line.quantity && void onPatch({ quantity: q })} />
            </div>
          ) : null}
          {product.options.length > 0 ? (
            <div className="aiew-grid2">
              {product.options.map((option) => (
                <Field key={option.id} id={`${ids}-opt-${option.id}`} label={option.name}>
                  <select
                    id={`${ids}-opt-${option.id}`}
                    className="aiew-input"
                    disabled={!editable}
                    value={selected.get(option.id) ?? ""}
                    onChange={(event) => {
                      const next = new Map(selected);
                      if (event.target.value) next.set(option.id, event.target.value);
                      else next.delete(option.id);
                      void onPatch({ optionValueIds: [...next.values()] });
                    }}
                  >
                    {option.values.map((value) => (
                      <option key={value.id} value={value.id}>
                        {value.label}
                        {value.priceModifier ? ` (+${money(value.priceModifier)})` : ""}
                      </option>
                    ))}
                  </select>
                </Field>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      {editable ? (
        <div className="aiew-stack-sm">
          <Check
            checked={override}
            label="Set the price myself"
            onChange={(next) => {
              setOverride(next);
              if (!next && line.priceOverridden) void onPatch({ unitPrice: null }, "Back to the price book's price.");
            }}
          />
          {override ? (
            <div className="aiew-inline">
              <label className="aiew-label" htmlFor={`${ids}-price`}>
                Price each ($)
              </label>
              <input
                id={`${ids}-price`}
                className="aiew-input aiew-number"
                inputMode="decimal"
                value={price}
                onChange={(event) => setPrice(event.target.value)}
                onBlur={() => {
                  const cents = parseMoneyInput(price);
                  if (cents !== null && !Number.isNaN(cents) && cents >= 0 && (cents !== line.unitPrice || !line.priceOverridden)) void onPatch({ unitPrice: cents });
                }}
              />
            </div>
          ) : null}
        </div>
      ) : line.priceOverridden ? (
        <p className="aiew-hint">Price set by staff.</p>
      ) : null}

      {line.explanation.length > 0 ? (
        <ol className="aiew-explain" aria-label="How it was worked out">
          {line.explanation.map((text, i) => (
            <li key={`${i}:${text}`}>{text}</li>
          ))}
        </ol>
      ) : null}
      {line.assumption ? <p className="aiew-note">{line.assumption}</p> : null}
      {ranged ? (
        <p className="aiew-why" data-aiew-shown="">
          {fromCustomer ? "Customer was shown" : "Range"} {money(line.lowTotal)} – {money(line.highTotal)}
          {line.reasons.length > 0 ? `: ${line.reasons.join("; ")}` : ""}
        </p>
      ) : null}

      {reading ? (
        <div className="aiew-reading-box" data-aiew-line-reading="">
          {readingPhoto ? <img src={readingPhoto.url} alt="The photo that was read" /> : <span aria-hidden="true" />}
          <div className="aiew-stack-sm">
            <div className="aiew-row">
              <strong>
                <SparkIcon /> From the photo
              </strong>
              <span className={`aiew-tag ${reading.confidence === "low" ? "aiew-tag-warn" : "aiew-tag-accent"}`}>{reading.confidence} confidence</span>
            </div>
            <ul className="aiew-reading-lines">
              {reading.lines.map((text, i) => (
                <li key={`${i}:${text}`}>{text}</li>
              ))}
            </ul>
            {line.corrections.length > 0 ? (
              <p data-aiew-corrections="">
                <strong>The customer changed:</strong> {correctionText(line.corrections)}
              </p>
            ) : (
              <p className="aiew-hint">The customer kept what the photo showed.</p>
            )}
          </div>
        </div>
      ) : null}

      {editable ? (
        <BlurField id={`${ids}-notes`} label="Line notes" optional value={line.notes ?? ""} onSave={(v) => void onPatch({ notes: v || null })} />
      ) : line.notes ? (
        <p className="aiew-hint">Notes: {line.notes}</p>
      ) : null}

      <div className="aiew-row">
        {/* CONTRACT: 9.7 asks for each line's "cost and margin". The wire
            carries a line's cost but not its margin, and the widget works no
            number out, so a line shows its cost; the estimate's margin (the
            server's `marginBp`) is under Totals. */}
        {line.cost !== null ? <span className="aiew-muted" data-aiew-line-cost="">Cost {money(line.cost)}</span> : null}
        <span className="aiew-grow" />
        {editable ? (
          <button type="button" className="aiew-btn aiew-btn-danger-outline aiew-btn-sm" onClick={onRemove}>
            Remove line
          </button>
        ) : null}
      </div>
    </article>
  );
}

// ---------------------------------------------------------------------------
// Adding a line
// ---------------------------------------------------------------------------

function AddLine({
  catalog,
  onOpen,
  money,
  onAdd,
}: {
  catalog: AdminProduct[] | null;
  onOpen: () => void;
  money: (cents: number) => string;
  onAdd: (body: Parameters<EstimatorAdminTransport["addLine"]>[1]) => Promise<boolean>;
}) {
  const ids = useId();
  const [mode, setMode] = useState<null | "product" | "own">(null);
  const [productId, setProductId] = useState("");
  const [values, setValues] = useState<CustomerInputs>({});
  const [quantity, setQuantity] = useState<number | null>(1);
  const [choices, setChoices] = useState<Record<string, string>>({});
  const [description, setDescription] = useState("");
  const [ownQty, setOwnQty] = useState("1");
  const [ownPrice, setOwnPrice] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const product = catalog?.find((p) => p.id === productId) ?? null;

  useEffect(() => {
    setValues({});
    setQuantity(1);
    const defaults: Record<string, string> = {};
    for (const option of product?.options ?? []) {
      const value = option.values.find((v) => v.isDefault) ?? option.values[0];
      if (value) defaults[option.id] = value.id;
    }
    setChoices(defaults);
  }, [product]);

  const reset = () => {
    setMode(null);
    setProductId("");
    setDescription("");
    setOwnQty("1");
    setOwnPrice("");
    setProblem(null);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setProblem(null);
    if (mode === "product") {
      if (!product) return setProblem("Pick a product.");
      const ok = await onAdd({
        productId: product.id,
        inputs: cleanInputs(product.fields, values),
        ...(product.allowMultiple && product.recipe !== "count" ? { quantity: quantity ?? 1 } : {}),
        optionValueIds: Object.values(choices),
      });
      if (ok) reset();
    } else if (mode === "own") {
      const qty = Number(ownQty);
      const cents = parseMoneyInput(ownPrice);
      if (!description.trim()) return setProblem("Describe the line.");
      if (!Number.isInteger(qty) || qty < 1) return setProblem("Enter how many, 1 or more.");
      if (cents === null || Number.isNaN(cents) || cents < 0) return setProblem("Enter the price, like 150.00.");
      const ok = await onAdd({ description: description.trim(), quantity: qty, unitPrice: cents });
      if (ok) reset();
    }
  };

  if (mode === null) {
    return (
      <div className="aiew-row" data-aiew-add-line="">
        <button
          type="button"
          className="aiew-btn aiew-btn-secondary"
          onClick={() => {
            onOpen();
            setMode("product");
          }}
        >
          Add a line from the price book
        </button>
        <button type="button" className="aiew-btn aiew-btn-secondary" onClick={() => setMode("own")}>
          A line of my own
        </button>
      </div>
    );
  }

  return (
    <form className="aiew-sub-box" onSubmit={(event) => void submit(event)} noValidate data-aiew-add-line={mode}>
      <strong>{mode === "product" ? "Add a line from the price book" : "A line of my own"}</strong>
      {mode === "product" ? (
        <>
          {catalog === null ? <Loading label="Loading products…" /> : null}
          {catalog ? (
            <Field id={`${ids}-product`} label="Product">
              <select id={`${ids}-product`} className="aiew-input" value={productId} onChange={(event) => setProductId(event.target.value)}>
                <option value="">Pick a product…</option>
                {catalog.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </Field>
          ) : null}
          {product ? (
            <>
              <CustomerFields fields={product.fields} values={values} onChange={(next) => setValues(next)} />
              {product.allowMultiple && product.recipe !== "count" ? (
                <div className="aiew-field">
                  <label className="aiew-label" htmlFor={`${ids}-qty`}>
                    {product.multipleLabel ?? "How many?"}
                  </label>
                  <Stepper id={`${ids}-qty`} label={product.multipleLabel ?? "How many?"} value={quantity} min={1} max={product.maxQuantity} onValue={setQuantity} />
                </div>
              ) : null}
              {product.options.map((option) => (
                <Field key={option.id} id={`${ids}-o-${option.id}`} label={option.name}>
                  <select
                    id={`${ids}-o-${option.id}`}
                    className="aiew-input"
                    value={choices[option.id] ?? ""}
                    onChange={(event) => setChoices((c) => ({ ...c, [option.id]: event.target.value }))}
                  >
                    {option.values.map((value) => (
                      <option key={value.id} value={value.id}>
                        {value.label}
                        {value.priceModifier ? ` (+${money(value.priceModifier)})` : ""}
                      </option>
                    ))}
                  </select>
                </Field>
              ))}
            </>
          ) : null}
        </>
      ) : (
        <div className="aiew-grid3">
          <Field id={`${ids}-desc`} label="Description">
            <input id={`${ids}-desc`} className="aiew-input" value={description} maxLength={500} onChange={(event) => setDescription(event.target.value)} />
          </Field>
          <Field id={`${ids}-oq`} label="How many">
            <input id={`${ids}-oq`} className="aiew-input aiew-number" inputMode="numeric" value={ownQty} onChange={(event) => setOwnQty(event.target.value)} />
          </Field>
          <Field id={`${ids}-op`} label="Price each ($)">
            <input id={`${ids}-op`} className="aiew-input aiew-number" inputMode="decimal" value={ownPrice} onChange={(event) => setOwnPrice(event.target.value)} />
          </Field>
        </div>
      )}
      {problem ? <p className="aiew-danger-text" role="alert">{problem}</p> : null}
      <div className="aiew-row">
        <button type="submit" className="aiew-btn aiew-btn-primary">
          Add line
        </button>
        <button type="button" className="aiew-btn aiew-btn-secondary" onClick={reset}>
          Cancel
        </button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Totals
// ---------------------------------------------------------------------------

function TotalsPanel({
  estimate,
  editable,
  money,
  locale,
  shownDiffers,
  mutate,
  transport,
}: {
  estimate: EstimateDetail;
  editable: boolean;
  money: (cents: number) => string;
  locale: string;
  shownDiffers: boolean;
  mutate: Mutate;
  transport: EstimatorAdminTransport;
}) {
  const ids = useId();
  const [discount, setDiscount] = useState(centsToInput(estimate.discount));
  const [tax, setTax] = useState(bpToInput(estimate.taxRateBp));
  useEffect(() => setDiscount(centsToInput(estimate.discount)), [estimate.discount]);
  useEffect(() => setTax(bpToInput(estimate.taxRateBp)), [estimate.taxRateBp]);
  return (
    <Panel id="totals" title="Totals">
      <table className="aiew-table" data-aiew-totals="">
        <tbody>
          <tr>
            <td>Subtotal</td>
            <td className="aiew-num">{money(estimate.subtotal)}</td>
          </tr>
          <tr>
            <td>
              {editable ? (
                <span className="aiew-inline">
                  <label htmlFor={`${ids}-discount`}>Discount ($)</label>
                  <input
                    id={`${ids}-discount`}
                    className="aiew-input aiew-number"
                    inputMode="decimal"
                    value={discount}
                    onChange={(event) => setDiscount(event.target.value)}
                    onBlur={() => {
                      const cents = parseMoneyInput(discount) ?? 0;
                      if (!Number.isNaN(cents) && cents !== estimate.discount) void mutate("discount", () => transport.updateEstimate(estimate.id, { discount: cents }), "Saved.");
                    }}
                  />
                </span>
              ) : (
                "Discount"
              )}
            </td>
            <td className="aiew-num">{estimate.discount > 0 ? `−${money(estimate.discount)}` : money(0)}</td>
          </tr>
          <tr>
            <td>
              {editable ? (
                <span className="aiew-inline">
                  <label htmlFor={`${ids}-tax`}>Sales tax (%)</label>
                  <input
                    id={`${ids}-tax`}
                    className="aiew-input aiew-number"
                    inputMode="decimal"
                    value={tax}
                    onChange={(event) => setTax(event.target.value)}
                    onBlur={() => {
                      const bp = parsePercentInput(tax);
                      if (bp !== null && !Number.isNaN(bp) && bp !== estimate.taxRateBp) void mutate("tax", () => transport.updateEstimate(estimate.id, { taxRateBp: bp }), "Saved.");
                    }}
                  />
                </span>
              ) : (
                `Sales tax (${formatPercent(estimate.taxRateBp)})`
              )}
            </td>
            <td className="aiew-num">{money(estimate.taxAmount)}</td>
          </tr>
        </tbody>
        <tfoot>
          <tr>
            <td>Total</td>
            <td className="aiew-num" data-aiew-total="">
              {money(estimate.total)}
            </td>
          </tr>
        </tfoot>
      </table>
      {shownDiffers ? (
        <p className="aiew-hint" data-aiew-range-shown="">
          {estimate.source !== "staff" ? "Customer was shown" : "The range is"} {formatRange(estimate.rangeLow, estimate.rangeHigh, estimate.currency, locale)} before tax
          {estimate.rangeReasons.length > 0 ? ` (${estimate.rangeReasons.join("; ")})` : ""}.
        </p>
      ) : null}
      {estimate.cost !== null ? (
        <p data-aiew-cost="">
          Cost {money(estimate.cost)}
          {estimate.marginBp !== null ? ` · Margin ${formatPercent(estimate.marginBp)}` : ""}
        </p>
      ) : null}
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// Dialogs
// ---------------------------------------------------------------------------

function SendDialog({
  estimate,
  money,
  defaultDays,
  emailsOff,
  busy,
  onClose,
  onSend,
}: {
  estimate: EstimateDetail;
  money: (cents: number) => string;
  defaultDays: number;
  emailsOff: boolean;
  busy: boolean;
  onClose: () => void;
  onSend: (body: { validDays: number; message: string | null }) => Promise<void>;
}) {
  const ids = useId();
  const [days, setDays] = useState(String(defaultDays));
  const [message, setMessage] = useState(estimate.quoteMessage ?? "");
  const n = Number(days);
  const daysOk = Number.isInteger(n) && n >= 1 && n <= 365;
  const email = estimate.customerEmail;
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!daysOk || !email) return;
    await onSend({ validDays: n, message: message.trim() || null });
  };
  return (
    <Dialog title="Send the quote" onClose={onClose} data={{ "aiew-send": "" }}>
      <form className="aiew-stack" onSubmit={(event) => void submit(event)} noValidate>
        <Field id={`${ids}-days`} label="Good for (days)" error={daysOk ? null : "Enter 1 to 365 days."}>
          <input id={`${ids}-days`} className="aiew-input aiew-number" inputMode="numeric" value={days} data-autofocus="" onChange={(event) => setDays(event.target.value)} />
        </Field>
        <Field id={`${ids}-message`} label="A message at the top" optional hint="Shown on the quote and in the email.">
          <textarea id={`${ids}-message`} className="aiew-input" rows={3} maxLength={1000} value={message} aria-describedby={`${ids}-message-hint`} onChange={(event) => setMessage(event.target.value)} />
        </Field>
        <div className="aiew-sub-box" data-aiew-send-summary="">
          <strong>What the customer gets</strong>
          <p>
            An email with a link to the quote: {estimate.lines.length} line{estimate.lines.length === 1 ? "" : "s"}, {money(estimate.total)} with tax, good for{" "}
            {daysOk ? n : "…"} day{n === 1 ? "" : "s"}. They can accept or decline it online, no account needed.
          </p>
        </div>
        {/* What an unmeasured line is priced at, before it goes: the quote binds
            the business to that basis (review EST-R05). The server's words. */}
        {estimate.sendWarnings.length > 0 ? (
          <Notice tone="warn" data="send-warnings">
            {estimate.sendWarnings.map((warning, i) => (
              <p key={i}>{warning}</p>
            ))}
          </Notice>
        ) : null}
        {emailsOff ? (
          <Notice tone="warn">Email isn&apos;t set up, so nothing will be emailed. After sending, copy the quote link and send it yourself.</Notice>
        ) : null}
        <div className="aiew-actions">
          <button type="submit" className="aiew-btn aiew-btn-primary" disabled={!daysOk || !email || busy} aria-busy={busy || undefined}>
            {busy ? "Sending…" : `Send to ${email ?? "the customer"}`}
          </button>
          <button type="button" className="aiew-btn aiew-btn-secondary" onClick={onClose}>
            Cancel
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function AnswerDialog({
  kind,
  hasEmail,
  busy,
  onClose,
  onConfirm,
}: {
  kind: "yes" | "no";
  hasEmail: boolean;
  busy: boolean;
  onClose: () => void;
  onConfirm: (note: string, notify: boolean) => Promise<void>;
}) {
  const ids = useId();
  const [note, setNote] = useState("");
  const [notify, setNotify] = useState(false);
  return (
    <Dialog title={kind === "yes" ? "The customer said yes" : "The customer said no"} onClose={onClose}>
      <form
        className="aiew-stack"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void onConfirm(note.trim(), notify);
        }}
      >
        <p>{kind === "yes" ? "Record that they accepted (on the phone, say). The quote is marked accepted." : "Record that they declined. The quote is marked declined and the follow-up is cancelled."}</p>
        <Field id={`${ids}-note`} label="Note" optional>
          <textarea id={`${ids}-note`} className="aiew-input" rows={2} maxLength={1000} value={note} data-autofocus="" onChange={(event) => setNote(event.target.value)} />
        </Field>
        {kind === "yes" && hasEmail ? <Check checked={notify} onChange={setNotify} label="Email the customer a thank-you with the next step" /> : null}
        <div className="aiew-actions">
          <button type="submit" className="aiew-btn aiew-btn-primary" disabled={busy}>
            {kind === "yes" ? "Mark accepted" : "Mark declined"}
          </button>
          <button type="button" className="aiew-btn aiew-btn-secondary" onClick={onClose}>
            Cancel
          </button>
        </div>
      </form>
    </Dialog>
  );
}
