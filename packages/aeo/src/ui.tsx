import { useCallback, useEffect, useState, type FormEvent, type ReactElement } from "react";
import type { MentionCheckWire, MentionsOverviewWire, ProfileWire, QuestionWire, RunResultWire } from "./wire.js";

/**
 * THE DROP-IN "AI MENTIONS" SCREEN (0.2), on the `./ui` entry:
 *
 *   <AiMentions transport={createAiMentionsTransport({ baseUrl: "/api/app/{id}/ai-mentions" })} />
 *
 * Who the business is (its name, website, other names, competitors), the
 * questions customers ask, and for each one the last answer: named or not,
 * the quoted words, the sources, the competitors it named, and how often
 * it's been named over the last eight weeks. "Check now" for someone who may.
 *
 * WHAT AN AI SAID IS SHOWN AS TEXT, never as markup: React escapes the quote,
 * and only http(s) sources become links (rel="nofollow noopener noreferrer").
 */

export interface AiMentionsTransport {
  overview(): Promise<MentionsOverviewWire>;
  saveProfile?(input: { brand: string; domain: string; aliases: string; competitors: string }): Promise<ProfileWire>;
  addQuestion?(question: string): Promise<QuestionWire>;
  removeQuestion?(id: string): Promise<void>;
  checkQuestion?(id: string): Promise<RunResultWire>;
  checkAll?(): Promise<RunResultWire>;
}

export class AiMentionsTransportError extends Error {
  readonly name = "AiMentionsTransportError";
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function createAiMentionsTransport(options: { baseUrl: string; fetch?: typeof fetch }): Required<AiMentionsTransport> {
  const base = options.baseUrl.replace(/\/+$/, "");
  const doFetch = options.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  async function call<T>(path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await doFetch(`${base}/${path}`, {
        method: body === undefined ? "GET" : "POST",
        credentials: "same-origin",
        headers: body === undefined ? undefined : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new AiMentionsTransportError("offline", 0, "Couldn't reach the server. Check your connection and try again.");
    }
    const text = await res.text();
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    if (!res.ok) {
      const error = (data as { error?: { code?: string; message?: string } } | null)?.error;
      throw new AiMentionsTransportError(error?.code ?? "internal", res.status, error?.message ?? "Something went wrong. Please try again.");
    }
    return data as T;
  }
  return {
    overview: () => call("v1/mentions"),
    saveProfile: async (input) => (await call<{ profile: ProfileWire }>("v1/profile", input)).profile,
    addQuestion: async (question) => (await call<{ question: QuestionWire }>("v1/questions", { question })).question,
    removeQuestion: async (id) => {
      await call(`v1/questions/${encodeURIComponent(id)}/remove`, {});
    },
    checkQuestion: (id) => call(`v1/questions/${encodeURIComponent(id)}/check`, {}),
    checkAll: () => call("v1/check", {}),
  };
}

const STYLE_ID = "aiam-styles";
const CSS = `
.aiam { --aiam-surface:#fff; --aiam-surface-2:#f5f7f9; --aiam-ink:#0e161c; --aiam-muted:#55636f; --aiam-line:#e1e7ec; --aiam-accent:#0f766e;
  --aiam-good:#1b7a43; --aiam-good-soft:#dcf1e4; --aiam-warn:#8a5a00; --aiam-warn-soft:#fbefd5; --aiam-bad:#b3261e; --aiam-bad-soft:#f9e0dd;
  color: var(--aiam-ink); display:flex; flex-direction:column; gap:16px; min-width:0; font-size:14px; line-height:1.5; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) .aiam { --aiam-surface:#161d23; --aiam-surface-2:#0f1418; --aiam-ink:#e8edf1; --aiam-muted:#93a2ae;
  --aiam-line:#29343d; --aiam-accent:#45c4ad; --aiam-good:#5fd08f; --aiam-good-soft:#12301f; --aiam-warn:#e2b553; --aiam-warn-soft:#332608; --aiam-bad:#f08a80; --aiam-bad-soft:#3a1512; } }
:root[data-theme="dark"] .aiam { --aiam-surface:#161d23; --aiam-surface-2:#0f1418; --aiam-ink:#e8edf1; --aiam-muted:#93a2ae;
  --aiam-line:#29343d; --aiam-accent:#45c4ad; --aiam-good:#5fd08f; --aiam-good-soft:#12301f; --aiam-warn:#e2b553; --aiam-warn-soft:#332608; --aiam-bad:#f08a80; --aiam-bad-soft:#3a1512; }
.aiam-bar { display:flex; flex-wrap:wrap; gap:10px 12px; align-items:center; }
.aiam-title { font-size:20px; font-weight:700; margin:0; }
.aiam-sub { color: var(--aiam-muted); margin:2px 0 0; }
.aiam-button { font:inherit; font-weight:600; min-height:44px; padding:8px 16px; border-radius:10px; border:1px solid var(--aiam-accent); background: var(--aiam-accent); color:#fff; cursor:pointer; }
.aiam-button-quiet { background: transparent; color: var(--aiam-accent); }
.aiam-button[disabled] { opacity:.6; cursor:default; }
.aiam-button:focus-visible, .aiam-input:focus-visible { outline:2px solid var(--aiam-accent); outline-offset:2px; }
.aiam-panel { background: var(--aiam-surface); border:1px solid var(--aiam-line); border-radius:14px; padding:16px; min-width:0; }
.aiam-form { display:grid; gap:10px; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); }
.aiam-field { display:flex; flex-direction:column; gap:4px; font-weight:600; font-size:13px; }
.aiam-input { font:inherit; font-weight:400; font-size:14px; min-height:44px; padding:8px 12px; border-radius:10px; border:1px solid var(--aiam-line); background: var(--aiam-surface); color: var(--aiam-ink); box-sizing:border-box; width:100%; }
.aiam-hint { font-weight:400; color: var(--aiam-muted); font-size:12px; }
.aiam-notice { background: var(--aiam-warn-soft); color: var(--aiam-warn); border-radius:10px; padding:10px 12px; margin:0; }
.aiam-error { background: var(--aiam-bad-soft); color: var(--aiam-bad); border-radius:10px; padding:10px 12px; margin:0; }
.aiam-list { list-style:none; margin:0; padding:0; display:flex; flex-direction:column; gap:10px; }
.aiam-q { border:1px solid var(--aiam-line); border-radius:12px; padding:12px; background: var(--aiam-surface); display:flex; flex-direction:column; gap:8px; }
.aiam-q h4 { margin:0; font-size:15px; overflow-wrap:anywhere; }
.aiam-pill { font-size:12px; font-weight:700; border-radius:999px; padding:2px 8px; display:inline-block; }
.aiam-yes { background: var(--aiam-good-soft); color: var(--aiam-good); }
.aiam-no { background: var(--aiam-warn-soft); color: var(--aiam-warn); }
.aiam-quote { margin:0; padding:8px 12px; border-left:3px solid var(--aiam-line); color: var(--aiam-ink); background: var(--aiam-surface-2); border-radius:0 8px 8px 0; overflow-wrap:anywhere; }
.aiam-sources { margin:0; padding-left:18px; overflow-wrap:anywhere; font-size:13px; }
.aiam-sources a { color: var(--aiam-accent); }
.aiam-row { display:flex; flex-wrap:wrap; gap:8px; align-items:center; }
`;

function useStyles(): void {
  useEffect(() => {
    if (typeof document === "undefined" || document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = CSS;
    document.head.appendChild(style);
  }, []);
}

function when(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** "Named in 3 of 5 answers over the last 8 weeks" — counted from the weeks, in code. */
export function trendSentence(question: QuestionWire): string {
  const checks = question.trend.reduce((sum, w) => sum + w.checks, 0);
  const cited = question.trend.reduce((sum, w) => sum + w.cited, 0);
  if (checks === 0) return "Not checked in the last 8 weeks.";
  return `Named in ${cited} of ${checks} answer${checks === 1 ? "" : "s"} over the last ${question.trend.length} weeks.`;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function Answer({ check }: { check: MentionCheckWire }): ReactElement {
  if (check.status === "failed") return <p className="aiam-sub">{check.problem}</p>;
  return (
    <>
      <div className="aiam-row">
        <span className={`aiam-pill ${check.cited ? "aiam-yes" : "aiam-no"}`}>{check.cited ? (check.mentioned ? "Named you" : "Used your website") : "Didn't name you"}</span>
        <span className="aiam-sub">
          {check.engine}, {when(check.checkedAt)}
        </span>
      </div>
      {check.snippet ? <blockquote className="aiam-quote">{check.snippet}</blockquote> : null}
      {check.competitorsNamed.length > 0 ? <p className="aiam-sub">Also named: {check.competitorsNamed.join(", ")}</p> : null}
      {check.sources.length > 0 ? (
        <details>
          <summary>Sources it used ({check.sources.length})</summary>
          <ul className="aiam-sources">
            {check.sources.map((url) => (
              <li key={url}>
                <a href={url} rel="nofollow noopener noreferrer" target="_blank">
                  {hostOf(url)}
                </a>
                {check.matchedUrl === url ? " — your website" : ""}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </>
  );
}

export interface AiMentionsProps {
  transport: AiMentionsTransport;
  initial?: MentionsOverviewWire | null;
  headingLevel?: 2 | 3;
}

export function AiMentions(props: AiMentionsProps): ReactElement {
  useStyles();
  const { transport } = props;
  const [data, setData] = useState<MentionsOverviewWire | null>(props.initial ?? null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [question, setQuestion] = useState("");
  const [editing, setEditing] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await transport.overview());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong. Please try again.");
    }
  }, [transport]);

  useEffect(() => {
    if (!props.initial) void load();
  }, [load, props.initial]);

  async function act(key: string, work: () => Promise<void>) {
    setBusy(key);
    setError(null);
    setNote(null);
    try {
      await work();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong. Please try again.");
    } finally {
      setBusy(null);
    }
  }

  function afterRun(result: RunResultWire) {
    setData(result.overview);
    const parts = [`Checked ${result.checked} question${result.checked === 1 ? "" : "s"}: named in ${result.cited}.`];
    if (result.failed > 0) parts.push(`${result.failed} didn't get an answer.`);
    if (result.stopped) parts.push(result.stopped);
    setNote(parts.join(" "));
  }

  function onProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!transport.saveProfile) return;
    const form = new FormData(event.currentTarget);
    void act("profile", async () => {
      await transport.saveProfile!({
        brand: String(form.get("brand") ?? ""),
        domain: String(form.get("domain") ?? ""),
        aliases: String(form.get("aliases") ?? ""),
        competitors: String(form.get("competitors") ?? ""),
      });
      setEditing(false);
      await load();
    });
  }

  function onAdd(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!transport.addQuestion || question.trim() === "") return;
    void act("add", async () => {
      await transport.addQuestion!(question);
      setQuestion("");
      await load();
    });
  }

  const Heading = props.headingLevel === 3 ? "h3" : "h2";
  const profile = data?.profile ?? null;
  const manage = data?.canManage ?? false;
  const showForm = manage && (profile === null || editing);
  const start = profile ?? (data?.suggested ? { brand: data.suggested.brand, domain: data.suggested.domain, aliases: [], competitors: [] } : null);

  return (
    <section className="aiam" aria-label="AI mentions">
      <div className="aiam-bar">
        <div style={{ flex: "1 1 240px", minWidth: 0 }}>
          <Heading className="aiam-title">AI mentions</Heading>
          <p className="aiam-sub">
            When customers ask an AI assistant the questions below, does the answer name {profile ? profile.brand : "your business"}? Checked with web search, the way the
            assistant answers anyone.
          </p>
        </div>
        {manage && data?.engine.on && transport.checkAll && (data?.questions.length ?? 0) > 0 && profile ? (
          <button type="button" className="aiam-button" disabled={busy !== null} onClick={() => void act("all", async () => afterRun(await transport.checkAll!()))}>
            {busy === "all" ? "Checking… (up to a minute)" : "Check now"}
          </button>
        ) : null}
      </div>
      {data && !data.engine.on && data.engine.message ? <p className="aiam-notice">{data.engine.message}</p> : null}
      {data?.notice ? <p className="aiam-notice">{data.notice}</p> : null}
      {error ? (
        <p className="aiam-error" role="alert">
          {error}
        </p>
      ) : null}
      {note ? <p className="aiam-sub" role="status">{note}</p> : null}
      {data === null && error === null ? <p className="aiam-sub">Loading…</p> : null}

      {data && showForm ? (
        <form className="aiam-panel" onSubmit={onProfile}>
          <strong>How answers would name you</strong>
          <div className="aiam-form" style={{ marginTop: 10 }}>
            <label className="aiam-field">
              Business name
              <input className="aiam-input" name="brand" required maxLength={200} defaultValue={start?.brand ?? ""} />
            </label>
            <label className="aiam-field">
              Website
              <input className="aiam-input" name="domain" maxLength={200} placeholder="greenacres.com" defaultValue={start?.domain ?? ""} />
            </label>
            <label className="aiam-field">
              Other names <span className="aiam-hint">Separate with commas</span>
              <input className="aiam-input" name="aliases" maxLength={2000} defaultValue={start?.aliases.join(", ") ?? ""} />
            </label>
            <label className="aiam-field">
              Competitors to watch for <span className="aiam-hint">Separate with commas</span>
              <input className="aiam-input" name="competitors" maxLength={2000} defaultValue={start?.competitors.join(", ") ?? ""} />
            </label>
          </div>
          <div className="aiam-row" style={{ marginTop: 10 }}>
            <button type="submit" className="aiam-button" disabled={busy !== null}>
              {busy === "profile" ? "Saving…" : "Save"}
            </button>
            {profile ? (
              <button type="button" className="aiam-button aiam-button-quiet" onClick={() => setEditing(false)}>
                Cancel
              </button>
            ) : null}
          </div>
        </form>
      ) : null}
      {data && profile && !showForm ? (
        <p className="aiam-sub">
          Looking for <strong>{profile.brand}</strong>
          {profile.domain ? ` (${profile.domain})` : ""}
          {profile.aliases.length > 0 ? `, also “${profile.aliases.join("”, “")}”` : ""}.{" "}
          {manage ? (
            <button type="button" className="aiam-button aiam-button-quiet" style={{ minHeight: 44 }} onClick={() => setEditing(true)}>
              Change
            </button>
          ) : null}
        </p>
      ) : null}

      {data ? (
        <ul className="aiam-list">
          {data.questions.map((q) => (
            <li key={q.id} className="aiam-q">
              <h4>“{q.question}”</h4>
              {q.latest ? <Answer check={q.latest} /> : <p className="aiam-sub">Not checked yet.</p>}
              <p className="aiam-sub">
                {trendSentence(q)}
                {q.nextAutomaticAt ? ` Asked again automatically around ${when(q.nextAutomaticAt)}.` : ""}
              </p>
              {manage ? (
                <div className="aiam-row">
                  {data.engine.on && transport.checkQuestion && profile ? (
                    <button type="button" className="aiam-button aiam-button-quiet" disabled={busy !== null} onClick={() => void act(q.id, async () => afterRun(await transport.checkQuestion!(q.id)))}>
                      {busy === q.id ? "Checking…" : "Check this one"}
                    </button>
                  ) : null}
                  {transport.removeQuestion ? (
                    <button
                      type="button"
                      className="aiam-button aiam-button-quiet"
                      disabled={busy !== null}
                      onClick={() =>
                        void act(`remove-${q.id}`, async () => {
                          await transport.removeQuestion!(q.id);
                          await load();
                        })
                      }
                    >
                      Remove
                    </button>
                  ) : null}
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {data && manage && data.questions.length >= data.maxQuestions && data.maxQuestions > 0 ? (
        <p className="aiam-sub">
          You're tracking {data.maxQuestions} question{data.maxQuestions === 1 ? "" : "s"}, the most your plan includes. Remove one to add another.
        </p>
      ) : null}
      {data && data.questions.length === 0 ? <p className="aiam-sub">No questions yet. Add one a customer might type, like “wheelchair ramp rental Raleigh”.</p> : null}
      {data && manage && transport.addQuestion && data.questions.length < data.maxQuestions ? (
        <form className="aiam-row" onSubmit={onAdd}>
          <label className="aiam-field" style={{ flex: "1 1 260px" }}>
            Add a question customers ask
            <input className="aiam-input" value={question} maxLength={300} placeholder="wheelchair ramp rental Raleigh" onChange={(e) => setQuestion(e.target.value)} />
          </label>
          <button type="submit" className="aiam-button" disabled={busy !== null || question.trim() === ""} style={{ alignSelf: "flex-end" }}>
            {busy === "add" ? "Adding…" : "Add"}
          </button>
        </form>
      ) : null}
    </section>
  );
}
