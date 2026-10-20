import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";
import { createCommsClient, type CommsTransport } from "../client.js";
import type { ClientError, Result } from "../http.js";
import type { CommsStatusWire, MessageWire, TemplateWire, WireIssue } from "../types.js";
import { Dialog, Root, type ChromeProps } from "../ui.js";
import {
  behindSentence,
  formatWhen,
  lateSentence,
  previewSubject,
  runDueSentence,
  STATUS_TONE,
  STATUS_WORDS,
  TEMPLATE_GROUPS,
  templateGroup,
  templateLabel,
  templateWhen,
} from "./words.js";

/**
 * The Messages screen (Tenancy 2a, 9.7): how a business's emails go out, the
 * wording of each one (read, edit, switch off), what went out to whom, and
 * "Send what's due now". It replaces the page create-app used to copy into
 * every project, so a fix reaches every project by `npm update`.
 *
 * Mount it with the company's messages API:
 *
 *   <MessagesConsole baseUrl={`/api/app/${company.id}/messages`} canManage={can.includes("comms.manage")} />
 *
 * Never throws: every failure is a sentence on the screen. Outcomes are
 * announced in one `role="status"` region.
 */

export interface MessagesConsoleProps extends ChromeProps {
  /** Where @adminigloo/comms's `createCommsAdminHandlers` is mounted. */
  baseUrl?: string;
  /** Your own transport (wins over `baseUrl`). */
  transport?: CommsTransport;
  /** Show the Edit and Send-due-now controls. The server still refuses; this only avoids offering them. Default true. */
  canManage?: boolean;
  /** Dates in the log use this locale (the company's). Default "en-US". */
  locale?: string;
  /** Staff of the SITE: also show the technical reason email is off. An owner reads one plain sentence. */
  showTechnical?: boolean;
}

const MISSING: Result<never> = {
  ok: false,
  error: { code: "bad_response", message: "This screen isn't connected to the messages server yet.", status: 0 },
};

function missingTransport(): CommsTransport {
  const fail = () => Promise.resolve(MISSING);
  return { status: fail, templates: fail, saveTemplate: fail, setActive: fail, messages: fail, runDue: fail };
}

type Load<T> = { state: "loading" } | { state: "ready"; data: T } | { state: "error"; error: ClientError };

/** A promise that never rejects: a host transport that throws still becomes an error value. */
async function safely<T>(call: () => Promise<Result<T>>): Promise<Result<T>> {
  try {
    return await call();
  } catch {
    return { ok: false, error: { code: "bad_response", message: "Something went wrong. Please try again.", status: 0 } };
  }
}

export function MessagesConsole(props: MessagesConsoleProps) {
  const { baseUrl, transport: given, canManage = true, locale = "en-US", showTechnical = false, ...chrome } = props;
  const transport = useMemo(() => given ?? (baseUrl ? createCommsClient({ baseUrl }) : missingTransport()), [given, baseUrl]);

  const [status, setStatus] = useState<Load<CommsStatusWire>>({ state: "loading" });
  const [templates, setTemplates] = useState<Load<TemplateWire[]>>({ state: "loading" });
  const [messages, setMessages] = useState<Load<MessageWire[]>>({ state: "loading" });
  const [announce, setAnnounce] = useState("");
  const [editing, setEditing] = useState<TemplateWire | null>(null);
  const [confirmOff, setConfirmOff] = useState<TemplateWire | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [toggleError, setToggleError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [runOutcome, setRunOutcome] = useState<{ tone: "ok" | "warn" | "error"; text: string } | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const loadStatus = useCallback(async () => {
    const res = await safely(() => transport.status());
    if (alive.current) setStatus(res.ok ? { state: "ready", data: res.data } : { state: "error", error: res.error });
  }, [transport]);
  const loadTemplates = useCallback(async () => {
    const res = await safely(() => transport.templates());
    if (alive.current) setTemplates(res.ok ? { state: "ready", data: res.data.templates } : { state: "error", error: res.error });
  }, [transport]);
  const loadMessages = useCallback(async () => {
    const res = await safely(() => transport.messages({ limit: 100 }));
    if (alive.current) setMessages(res.ok ? { state: "ready", data: res.data.messages } : { state: "error", error: res.error });
  }, [transport]);

  useEffect(() => {
    void loadStatus();
    void loadTemplates();
    void loadMessages();
  }, [loadStatus, loadTemplates, loadMessages]);

  const replaceTemplate = (next: TemplateWire) =>
    setTemplates((current) =>
      current.state === "ready" ? { state: "ready", data: current.data.map((t) => (t.key === next.key ? next : t)) } : current,
    );

  const setActive = async (template: TemplateWire, active: boolean) => {
    setBusyKey(template.key);
    setToggleError(null);
    const res = await safely(() => transport.setActive(template.key, { active }));
    if (!alive.current) return;
    setBusyKey(null);
    if (res.ok) {
      replaceTemplate(res.data.template);
      setAnnounce(`${templateLabel(template.key)} is ${active ? "on" : "off"}.`);
    } else {
      setToggleError(res.error.message);
      setAnnounce(res.error.message);
    }
  };

  const runDue = async () => {
    setRunning(true);
    setRunOutcome(null);
    const res = await safely(() => transport.runDue());
    if (!alive.current) return;
    setRunning(false);
    if (res.ok) {
      const text = runDueSentence(res.data);
      const tone = res.data.failed > 0 ? "warn" : "ok";
      setRunOutcome({ tone, text });
      setAnnounce(text);
      void loadMessages();
      void loadStatus();
    } else {
      setRunOutcome({ tone: "error", text: res.error.message });
      setAnnounce(res.error.message);
    }
  };

  return (
    <Root {...chrome}>
      <div className="aicw-inner" data-aicw-console="">
        <div className="aicw-sr" role="status" aria-live="polite" data-aicw-announce="">
          {announce}
        </div>

        <section className="aicw-card" aria-labelledby="aicw-how" data-aicw-section="how">
          <h2 className="aicw-h2" id="aicw-how">
            How your emails go out
          </h2>
          {status.state === "loading" ? (
            <Loading text="Checking how emails go out…" />
          ) : status.state === "error" ? (
            <ErrorNotice error={status.error} onRetry={() => void loadStatus()} />
          ) : (
            <StatusLines status={status.data} showTechnical={showTechnical} />
          )}
        </section>

        <section className="aicw-card" aria-labelledby="aicw-templates" data-aicw-section="templates">
          <h2 className="aicw-h2" id="aicw-templates">
            Messages your customers get
          </h2>
          {toggleError ? (
            <div className="aicw-notice aicw-notice-error" role="alert">
              {toggleError}
            </div>
          ) : null}
          {templates.state === "loading" ? (
            <Loading text="Loading your messages…" />
          ) : templates.state === "error" ? (
            <ErrorNotice error={templates.error} onRetry={() => void loadTemplates()} />
          ) : templates.data.length === 0 ? (
            <p className="aicw-muted">No messages yet. They appear here once a feature that sends email is set up.</p>
          ) : (
            <TemplateGroups
              templates={templates.data}
              businessName={status.state === "ready" ? status.data.fromName : null}
              canManage={canManage}
              busyKey={busyKey}
              onEdit={setEditing}
              onToggle={(template) => (template.active ? setConfirmOff(template) : void setActive(template, true))}
            />
          )}
        </section>

        <section className="aicw-card" aria-labelledby="aicw-log" data-aicw-section="log">
          <div className="aicw-card-head">
            <h2 className="aicw-h2" id="aicw-log">
              What went out
            </h2>
            <button type="button" className="aicw-btn aicw-btn-secondary" onClick={() => void loadMessages()}>
              Refresh
            </button>
          </div>
          {messages.state === "loading" ? (
            <Loading text="Loading what went out…" />
          ) : messages.state === "error" ? (
            <ErrorNotice error={messages.error} onRetry={() => void loadMessages()} />
          ) : (
            <DeliveryLog messages={messages.data} locale={locale} />
          )}
        </section>

        {canManage ? (
          <section className="aicw-card" aria-labelledby="aicw-run" data-aicw-section="run">
            <h2 className="aicw-h2" id="aicw-run">
              Send what's due now
            </h2>
            <p className="aicw-small">
              Reminders and follow-ups go out by themselves every day. Use this if one is late, or to check that sending works.
            </p>
            <div className="aicw-actions">
              <button type="button" className="aicw-btn aicw-btn-primary" disabled={running} onClick={() => void runDue()}>
                {running ? "Sending…" : "Send what's due now"}
              </button>
            </div>
            {runOutcome ? (
              <div className={`aicw-notice aicw-notice-${runOutcome.tone}`} data-aicw-run-outcome="">
                {runOutcome.text}
              </div>
            ) : null}
          </section>
        ) : null}
      </div>

      {editing ? (
        <EditTemplate
          template={editing}
          transport={transport}
          onClose={() => setEditing(null)}
          onSaved={(template) => {
            replaceTemplate(template);
            setEditing(null);
            setAnnounce(`${templateLabel(template.key)} saved.`);
          }}
        />
      ) : null}

      {confirmOff ? (
        <Dialog title="Turn this message off?" onClose={() => setConfirmOff(null)}>
          <p data-aicw-confirm="">{`Turn off "${templateLabel(confirmOff.key)}"? Customers won't get it until you turn it back on.`}</p>
          <div className="aicw-actions">
            <button
              type="button"
              className="aicw-btn aicw-btn-danger"
              data-autofocus=""
              onClick={() => {
                const target = confirmOff;
                setConfirmOff(null);
                void setActive(target, false);
              }}
            >
              Turn off
            </button>
            <button type="button" className="aicw-btn aicw-btn-secondary" onClick={() => setConfirmOff(null)}>
              Keep it on
            </button>
          </div>
        </Dialog>
      ) : null}
    </Root>
  );
}

function Loading({ text }: { text: string }) {
  return (
    <div className="aicw-loading">
      <span className="aicw-spinner" aria-hidden="true" />
      <span>{text}</span>
    </div>
  );
}

function ErrorNotice({ error, onRetry }: { error: ClientError; onRetry: () => void }) {
  return (
    <div className="aicw-notice aicw-notice-error aicw-row">
      <span className="aicw-grow">{error.message}</span>
      {error.status !== 401 ? (
        <button type="button" className="aicw-btn aicw-btn-secondary" onClick={onRetry}>
          Try again
        </button>
      ) : null}
    </div>
  );
}

/** What an owner reads when email is off: the operator's job, in plain words. */
export const EMAILS_OFF_FOR_OWNER = "Email isn't switched on for this site yet, so nothing is emailed: each message is logged as skipped.";

function StatusLines({ status, showTechnical }: { status: CommsStatusWire; showTechnical: boolean }) {
  const from = status.fromName ?? "your site's usual name";
  const reply = status.replyTo ?? "your site's usual reply address";
  return (
    <div className="aicw-stack" data-aicw-status="">
      <p>
        Your customers see emails from <strong>{from}</strong> and their replies go to <strong>{reply}</strong>.
      </p>
      {!status.emails ? (
        <div className="aicw-notice aicw-notice-warn" data-aicw-emails-off="">
          {EMAILS_OFF_FOR_OWNER}
          {showTechnical && status.emailsOffReason ? <span className="aicw-detail">{status.emailsOffReason}</span> : null}
        </div>
      ) : null}
      {status.scheduled.late > 0 ? <div className="aicw-notice aicw-notice-warn">{lateSentence(status.scheduled.late)}</div> : null}
      {status.scheduled.behind > 0 ? (
        <div className="aicw-notice aicw-notice-warn" data-aicw-behind="">
          {behindSentence(status.scheduled.behind)}
        </div>
      ) : null}
    </div>
  );
}

function TemplateGroups({
  templates,
  businessName,
  canManage,
  busyKey,
  onEdit,
  onToggle,
}: {
  templates: readonly TemplateWire[];
  /** Who the emails go out as, for {{businessName}} in the subject preview. */
  businessName: string | null;
  canManage: boolean;
  busyKey: string | null;
  onEdit: (template: TemplateWire) => void;
  onToggle: (template: TemplateWire) => void;
}) {
  return (
    <div className="aicw-stack">
      {TEMPLATE_GROUPS.map((group) => {
        const items = templates.filter((t) => templateGroup(t.key) === group);
        if (items.length === 0) return null;
        return (
          <div key={group} className="aicw-group" data-aicw-group={group}>
            <h3 className="aicw-h3">{group}</h3>
            <ul className="aicw-list">
              {items.map((template) => {
                const label = templateLabel(template.key);
                const when = templateWhen(template.key);
                return (
                  <li key={template.key} className="aicw-template" data-aicw-template={template.key}>
                    <div className="aicw-grow">
                      <div className="aicw-template-name">{label}</div>
                      {when ? <div className="aicw-template-when">{when}</div> : null}
                      <div className="aicw-template-subject">
                        {template.channel === "sms"
                          ? "Text message"
                          : template.subject
                            ? <>Subject, for example: {previewSubject(template.subject, businessName)}</>
                            : "No subject"}
                      </div>
                    </div>
                    <span className={`aicw-tag ${template.active ? "aicw-tag-ok" : "aicw-tag-warn"}`}>{template.active ? "On" : "Off"}</span>
                    {canManage ? (
                      <div className="aicw-actions">
                        <button type="button" className="aicw-btn aicw-btn-secondary" aria-label={`Edit ${label}`} onClick={() => onEdit(template)}>
                          Edit
                        </button>
                        <button
                          type="button"
                          className="aicw-btn aicw-btn-secondary"
                          disabled={busyKey === template.key}
                          aria-label={`${template.active ? "Turn off" : "Turn on"} ${label}`}
                          onClick={() => onToggle(template)}
                        >
                          {template.active ? "Turn off" : "Turn on"}
                        </button>
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </div>
  );
}

function issueFor(issues: readonly WireIssue[] | undefined, field: string): string | null {
  return issues?.find((issue) => issue.path[0] === field)?.message ?? null;
}

function EditTemplate({
  template,
  transport,
  onClose,
  onSaved,
}: {
  template: TemplateWire;
  transport: CommsTransport;
  onClose: () => void;
  onSaved: (template: TemplateWire) => void;
}) {
  const id = useId();
  const [subject, setSubject] = useState(template.subject ?? "");
  const [body, setBody] = useState(template.body);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<ClientError | null>(null);
  const email = template.channel === "email";
  const subjectIssue = issueFor(error?.issues, "subject");
  const bodyIssue = issueFor(error?.issues, "body");

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    const res = await safely(() => transport.saveTemplate(template.key, { subject: email ? subject : null, body }));
    setSaving(false);
    if (res.ok) onSaved(res.data.template);
    else setError(res.error);
  };

  return (
    <Dialog title={`Edit "${templateLabel(template.key)}"`} onClose={onClose}>
      <form className="aicw-stack" onSubmit={(event) => void save(event)} noValidate>
        {email ? (
          <div className="aicw-field">
            <label className="aicw-label" htmlFor={`${id}-subject`}>
              Subject
            </label>
            <input
              id={`${id}-subject`}
              className="aicw-input"
              value={subject}
              maxLength={300}
              aria-invalid={subjectIssue ? true : undefined}
              aria-describedby={subjectIssue ? `${id}-subject-error` : undefined}
              onChange={(event) => setSubject(event.target.value)}
            />
            {subjectIssue ? (
              <span className="aicw-field-error" id={`${id}-subject-error`}>
                {subjectIssue}
              </span>
            ) : null}
          </div>
        ) : null}
        <div className="aicw-field">
          <label className="aicw-label" htmlFor={`${id}-body`}>
            Message
          </label>
          <textarea
            id={`${id}-body`}
            className="aicw-input"
            value={body}
            maxLength={20_000}
            aria-invalid={bodyIssue ? true : undefined}
            aria-describedby={`${id}-vars${bodyIssue ? ` ${id}-body-error` : ""}`}
            onChange={(event) => setBody(event.target.value)}
          />
          {bodyIssue ? (
            <span className="aicw-field-error" id={`${id}-body-error`}>
              {bodyIssue}
            </span>
          ) : null}
          <span className="aicw-hint" id={`${id}-vars`} data-aicw-vars="">
            {template.variables.length > 0
              ? `Filled in for you: ${template.variables.map((v) => `{{${v}}}`).join(", ")}`
              : "This message has no fill-in parts."}
            {email ? "" : " Every text starts with your business name and ends with how to stop texts."}
          </span>
        </div>
        {error && !subjectIssue && !bodyIssue ? (
          <div className="aicw-notice aicw-notice-error" role="alert">
            {error.message}
          </div>
        ) : null}
        <div className="aicw-actions">
          <button type="submit" className="aicw-btn aicw-btn-primary" disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </button>
          <button type="button" className="aicw-btn aicw-btn-secondary" onClick={onClose}>
            Cancel
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function DeliveryLog({ messages, locale }: { messages: readonly MessageWire[]; locale: string | undefined }) {
  if (messages.length === 0) {
    return (
      <div className="aicw-empty" data-aicw-empty="">
        <p className="aicw-empty-title">Nothing has gone out yet</p>
        <p className="aicw-muted">
          Once you&apos;re using it, every email your customers get from you (quotes, confirmations, invoices, reminders) is listed here with
          whether it arrived.
        </p>
      </div>
    );
  }
  const what = (m: MessageWire) => (m.templateKey ? templateLabel(m.templateKey) : m.channel === "sms" ? "Text message" : "Email");
  const note = (m: MessageWire) => [m.note, m.blanks.length > 0 ? `Left blank: ${m.blanks.join(", ")}` : null].filter(Boolean).join(" · ");
  return (
    <div data-aicw-log="">
      <table className="aicw-table">
        <thead>
          <tr>
            <th scope="col">When</th>
            <th scope="col">To</th>
            <th scope="col">Message</th>
            <th scope="col">Status</th>
            <th scope="col">Note</th>
          </tr>
        </thead>
        <tbody>
          {messages.map((m) => (
            <tr key={m.id} data-aicw-message={m.id}>
              <td>{formatWhen(m.at, locale)}</td>
              <td>{m.to}</td>
              <td>
                <div>{what(m)}</div>
                {m.subject ? <div className="aicw-small">{m.subject}</div> : null}
                {m.fromName ? <div className="aicw-small">Sent as {m.fromName}</div> : null}
              </td>
              <td>
                <span className={`aicw-tag aicw-tag-${STATUS_TONE[m.status]}`}>{STATUS_WORDS[m.status]}</span>
              </td>
              <td className="aicw-small">{note(m)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <ul className="aicw-cards">
        {messages.map((m) => (
          <li key={m.id} className="aicw-log-card">
            <div className="aicw-row">
              <strong className="aicw-grow">{what(m)}</strong>
              <span className={`aicw-tag aicw-tag-${STATUS_TONE[m.status]}`}>{STATUS_WORDS[m.status]}</span>
            </div>
            <div className="aicw-small">
              {formatWhen(m.at, locale)} · {m.to}
            </div>
            {m.fromName ? <div className="aicw-small">Sent as {m.fromName}</div> : null}
            {note(m) ? <div className="aicw-small">{note(m)}</div> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
