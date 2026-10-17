import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { createSettingsTransport, type AssistantSettingsTransport } from "../client.js";
import { injectStyles } from "../styles.js";
import { useHostTheme, useStyles } from "../theme.js";
import type { AssistantAllowanceWire, AssistantChangeWire, AssistantSettingsWire, FaqWire } from "../types.js";

/**
 * What the assistant knows about the business, written by the owner in plain
 * words — no prompts, no settings jargon:
 *
 *   About your business      what it does, where, its hours, how it talks
 *   Answers to questions     a question and the owner's answer; asked word
 *                            for word, it's answered without AI (free)
 *   House rules              things it must always (or never) do
 *   Words you use            "the yard" means our depot on 5th
 *   This month's AI use      messages used of the month's allowance, what
 *                            it cost, and when it starts again
 *   Recent changes           who changed what, in words
 *
 * Talks to the assistant handler's settings routes (`baseUrl`). Every figure
 * shown was worked out by the server; the screen only displays it.
 */

export interface AssistantSettingsProps {
  /** Where the assistant's handler is mounted, e.g. `/api/app/${company.id}/assistant`. */
  baseUrl: string;
  transport?: AssistantSettingsTransport;
  theme?: "auto" | "light" | "dark";
}

type Note = { tone: "ok" | "problem"; text: string } | null;

function centsWords(cents: string): string {
  const n = Number(cents);
  if (!Number.isFinite(n)) return cents;
  return `$${(n / 100).toFixed(2)}`;
}

function dateWords(day: string): string {
  const at = new Date(`${day}T12:00:00Z`);
  return Number.isNaN(at.getTime()) ? day : at.toLocaleDateString(undefined, { month: "long", day: "numeric" });
}

function Usage({ usage, configured }: { usage: AssistantAllowanceWire | null; configured: boolean }) {
  if (!configured) {
    return <p className="aia-card-help">The assistant's AI isn't switched on for this site yet, so nothing is being used. Answers you write here still work.</p>;
  }
  if (!usage) return <p className="aia-card-help">No allowance is set for this assistant.</p>;
  const share = usage.messageLimit ? Math.min(100, Math.round((usage.messagesUsed / usage.messageLimit) * 100)) : 0;
  return (
    <>
      <p data-aia-usage="">
        {usage.messageLimit !== null
          ? `${usage.messagesUsed} of ${usage.messageLimit} questions used this month`
          : `${usage.messagesUsed} questions this month`}
        {usage.centLimit !== null ? ` · ${centsWords(usage.centsUsed)} of ${centsWords(String(usage.centLimit))} of AI` : ` · ${centsWords(usage.centsUsed)} of AI`}
      </p>
      {usage.messageLimit !== null ? (
        <div className="aia-meter" data-full={usage.usedUp} role="presentation">
          <span style={{ width: `${share}%` }} />
        </div>
      ) : null}
      <p className="aia-card-help">
        {usage.usedUp && usage.message ? usage.message : `It starts again on ${dateWords(usage.resetsOn)}.`} Questions answered from your own answers below don't count.
      </p>
    </>
  );
}

export function AssistantSettings({ baseUrl, transport: given, theme: themeChoice = "auto" }: AssistantSettingsProps) {
  const transport = useMemo(() => given ?? createSettingsTransport(baseUrl), [given, baseUrl]);
  useStyles(injectStyles);
  const rootRef = useRef<HTMLDivElement>(null);
  const theme = useHostTheme(rootRef, themeChoice);

  const [settings, setSettings] = useState<AssistantSettingsWire | null>(null);
  const [changes, setChanges] = useState<AssistantChangeWire[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [profile, setProfile] = useState("");
  const [profileNote, setProfileNote] = useState<Note>(null);
  const [faqDraft, setFaqDraft] = useState<{ id?: string; question: string; answer: string }>({ question: "", answer: "" });
  const [faqNote, setFaqNote] = useState<Note>(null);
  const [rule, setRule] = useState("");
  const [ruleNote, setRuleNote] = useState<Note>(null);
  const [term, setTerm] = useState({ term: "", meaning: "" });
  const [termNote, setTermNote] = useState<Note>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await transport.settings();
    if (!res.ok) {
      setLoadError(res.message);
      return;
    }
    setSettings(res.data);
    setProfile(res.data.profile);
    const log = await transport.changes();
    if (log.ok) setChanges(log.data.changes);
  }, [transport]);

  useEffect(() => {
    void load();
  }, [load]);

  const run = async (work: () => Promise<Note>, setNote: (note: Note) => void) => {
    if (busy) return;
    setBusy(true);
    setNote(null);
    try {
      setNote(await work());
      await load();
    } finally {
      setBusy(false);
    }
  };

  const saveProfile = (event: FormEvent) => {
    event.preventDefault();
    void run(async () => {
      const res = await transport.saveProfile(profile);
      return res.ok ? { tone: "ok", text: "Saved." } : { tone: "problem", text: res.message };
    }, setProfileNote);
  };

  const saveFaq = (event: FormEvent) => {
    event.preventDefault();
    void run(async () => {
      const res = await transport.saveFaq(faqDraft);
      if (!res.ok) return { tone: "problem", text: res.message };
      setFaqDraft({ question: "", answer: "" });
      return { tone: "ok", text: faqDraft.id ? "Answer updated." : "Answer added." };
    }, setFaqNote);
  };

  const editFaq = (faq: FaqWire) => {
    setFaqDraft({ id: faq.id, question: faq.question, answer: faq.answer });
    setFaqNote(null);
  };

  const addRule = (event: FormEvent) => {
    event.preventDefault();
    void run(async () => {
      const res = await transport.addRule(rule);
      if (!res.ok) return { tone: "problem", text: res.message };
      setRule("");
      return { tone: "ok", text: "Rule added." };
    }, setRuleNote);
  };

  const addTerm = (event: FormEvent) => {
    event.preventDefault();
    void run(async () => {
      const res = await transport.addTerm(term.term, term.meaning.trim() || null);
      if (!res.ok) return { tone: "problem", text: res.message };
      setTerm({ term: "", meaning: "" });
      return { tone: "ok", text: "Word added." };
    }, setTermNote);
  };

  const remove = (work: () => Promise<{ ok: boolean; message?: string }>, setNote: (note: Note) => void) =>
    void run(async () => {
      const res = await work();
      return res.ok ? { tone: "ok", text: "Removed." } : { tone: "problem", text: (res as { message?: string }).message ?? "That didn't work." };
    }, setNote);

  const note = (value: Note) =>
    value ? (
      <p className={value.tone === "ok" ? "aia-saved" : "aia-problem"} role={value.tone === "ok" ? "status" : "alert"}>
        {value.text}
      </p>
    ) : null;

  if (loadError) {
    return (
      <div ref={rootRef} className="aia-root" data-theme={theme}>
        <p className="aia-problem" role="alert">
          {loadError}
        </p>
      </div>
    );
  }
  if (!settings) {
    return (
      <div ref={rootRef} className="aia-root" data-theme={theme}>
        <p className="aia-card-help">Loading the assistant's settings…</p>
      </div>
    );
  }

  return (
    <div ref={rootRef} className="aia-root aia-settings" data-theme={theme}>
      <section className="aia-card" aria-labelledby="aia-s-profile">
        <h2 className="aia-card-title" id="aia-s-profile">
          About your business
        </h2>
        <p className="aia-card-help">What you do, where, your hours, anything the assistant should know before it answers. Plain words are best.</p>
        <form onSubmit={saveProfile}>
          <label className="aia-field">
            <span className="aia-sr">About your business</span>
            <textarea
              value={profile}
              maxLength={settings.profileMaxChars}
              onChange={(event) => setProfile(event.target.value)}
              placeholder="We mow and edge lawns in Boise, Monday to Saturday, 7am to 6pm. Most jobs take an hour."
            />
          </label>
          <div className="aia-row" style={{ marginTop: 8 }}>
            <button type="submit" className="aia-btn aia-btn-primary" disabled={busy}>
              Save
            </button>
            <span className="aia-card-help">
              {profile.length} of {settings.profileMaxChars} characters
            </span>
          </div>
          {note(profileNote)}
        </form>
      </section>

      <section className="aia-card" aria-labelledby="aia-s-faqs">
        <h2 className="aia-card-title" id="aia-s-faqs">
          Answers to common questions
        </h2>
        <p className="aia-card-help">When someone asks one of these word for word, the assistant answers with exactly what you wrote — no AI used.</p>
        {settings.faqs.length > 0 ? (
          <ul className="aia-list">
            {settings.faqs.map((faq) => (
              <li key={faq.id} className="aia-item">
                <div className="aia-item-body">
                  <strong>{faq.question}</strong>
                  <p className="aia-item-sub">{faq.answer}</p>
                </div>
                <div className="aia-row">
                  <button type="button" className="aia-btn" onClick={() => editFaq(faq)} disabled={busy}>
                    Edit
                  </button>
                  <button type="button" className="aia-btn aia-btn-danger" onClick={() => remove(() => transport.removeFaq(faq.id), setFaqNote)} disabled={busy}>
                    Remove
                  </button>
                </div>
              </li>
            ))}
          </ul>
        ) : null}
        <form onSubmit={saveFaq} className="aia-card" style={{ boxShadow: "none" }}>
          <label className="aia-field">
            Question
            <input value={faqDraft.question} onChange={(event) => setFaqDraft({ ...faqDraft, question: event.target.value })} placeholder="Do you work on Sundays?" />
          </label>
          <label className="aia-field">
            Your answer
            <textarea value={faqDraft.answer} onChange={(event) => setFaqDraft({ ...faqDraft, answer: event.target.value })} placeholder="No — we work Monday to Saturday." />
          </label>
          <div className="aia-row">
            <button type="submit" className="aia-btn aia-btn-primary" disabled={busy || !faqDraft.question.trim() || !faqDraft.answer.trim()}>
              {faqDraft.id ? "Save the answer" : "Add the answer"}
            </button>
            {faqDraft.id ? (
              <button type="button" className="aia-btn aia-btn-quiet" onClick={() => setFaqDraft({ question: "", answer: "" })}>
                Cancel
              </button>
            ) : null}
          </div>
          {note(faqNote)}
        </form>
      </section>

      <section className="aia-card" aria-labelledby="aia-s-rules">
        <h2 className="aia-card-title" id="aia-s-rules">
          House rules
        </h2>
        <p className="aia-card-help">Things the assistant should always or never do. One rule per line works best.</p>
        {settings.rules.length > 0 ? (
          <ul className="aia-list">
            {settings.rules.map((r) => (
              <li key={r.id} className="aia-item">
                <div className="aia-item-body">{r.text}</div>
                <button type="button" className="aia-btn aia-btn-danger" onClick={() => remove(() => transport.removeRule(r.id), setRuleNote)} disabled={busy}>
                  Remove
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        <form onSubmit={addRule} className="aia-row">
          <label className="aia-field" style={{ flex: 1, minWidth: "12rem" }}>
            <span className="aia-sr">New house rule</span>
            <input value={rule} onChange={(event) => setRule(event.target.value)} placeholder="Always offer a free quote." />
          </label>
          <button type="submit" className="aia-btn aia-btn-primary" disabled={busy || !rule.trim()}>
            Add rule
          </button>
        </form>
        {note(ruleNote)}
      </section>

      <section className="aia-card" aria-labelledby="aia-s-words">
        <h2 className="aia-card-title" id="aia-s-words">
          Words you use
        </h2>
        <p className="aia-card-help">Names and phrases that mean something special in your business.</p>
        {settings.glossary.length > 0 ? (
          <ul className="aia-list">
            {settings.glossary.map((t) => (
              <li key={t.id} className="aia-item">
                <div className="aia-item-body">
                  <strong>{t.term}</strong>
                  {t.meaning ? <p className="aia-item-sub">{t.meaning}</p> : null}
                </div>
                <button type="button" className="aia-btn aia-btn-danger" onClick={() => remove(() => transport.removeTerm(t.id), setTermNote)} disabled={busy}>
                  Remove
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        <form onSubmit={addTerm} className="aia-row">
          <label className="aia-field" style={{ flex: 1, minWidth: "10rem" }}>
            Word
            <input value={term.term} onChange={(event) => setTerm({ ...term, term: event.target.value })} placeholder="the yard" />
          </label>
          <label className="aia-field" style={{ flex: 2, minWidth: "12rem" }}>
            What it means
            <input value={term.meaning} onChange={(event) => setTerm({ ...term, meaning: event.target.value })} placeholder="Our depot on 5th Street" />
          </label>
          <button type="submit" className="aia-btn aia-btn-primary" disabled={busy || !term.term.trim()} style={{ alignSelf: "flex-end" }}>
            Add word
          </button>
        </form>
        {note(termNote)}
      </section>

      <section className="aia-card" aria-labelledby="aia-s-usage">
        <h2 className="aia-card-title" id="aia-s-usage">
          This month's AI use
        </h2>
        <Usage usage={settings.usage} configured={settings.configured} />
      </section>

      {changes.length > 0 ? (
        <section className="aia-card" aria-labelledby="aia-s-changes">
          <h2 className="aia-card-title" id="aia-s-changes">
            Recent changes
          </h2>
          <ul className="aia-list">
            {changes.slice(0, 10).map((change) => (
              <li key={change.id} className="aia-item">
                <div className="aia-item-body">{change.what}</div>
                <span className="aia-card-help">{new Date(change.when).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
