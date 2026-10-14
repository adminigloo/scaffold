import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react";
import { createEstimatorClient } from "../client.js";
import { formatDateTime, friendlyError } from "../format.js";
import type { ClientError } from "../http.js";
import { CopyField, describedBy, Dialog, Field, Loading, Notice } from "../parts.js";
import { contrastRatio } from "../styles.js";
import type { EstimatorAdminTransport } from "./client.js";
import { adminErrorText, issuesByField } from "./helpers.js";
import type { KeyWire } from "./types.js";
import { AdminFrame, LoadError, Outcome, Panel, useAdminBasics, useAdminTransport, type AdminChromeProps } from "./ui.js";

/**
 * <EmbedKeys> — putting the estimator on the business's OWN website.
 *
 * NO CODE FIRST (Tenancy 2a review T2A-BO-02 / TB-2). A lawn-care or cleaning
 * business's website is Wix, Squarespace, WordPress or GoDaddy: there is no
 * "React code" to paste into, and the React component below ships from a
 * private registry. So when the page knows the business's public estimate
 * page (`publicPageUrl`), the screen leads with what ANY website can take,
 * with no key and no developer:
 *
 *   - a button (one line of HTML, in the business's colour) that opens the
 *     estimate page, and the plain address for a button the site already has;
 *   - the estimate page inside a page of their site (an iframe).
 *
 * The keyed React component (contract 9.7) stays, under "For developers",
 * saying plainly what it needs. A key is shown ONCE, when it is made, with a
 * ready-to-paste snippet built from THIS deployment's address
 * (`embedBaseUrl`) — never adminigloo.com (ES-15). Each key lists the
 * websites it may be used on; a key with none works anywhere, and says so in
 * words. "Test this key" asks the estimator for its products the way the
 * embed will.
 */

export interface EmbedKeysProps extends AdminChromeProps {
  /** The public estimator's address the snippet points at. Default the server's, then `${location.origin}/api/estimator`. */
  embedBaseUrl?: string;
  /** Offer making, editing and revoking keys (`estimator.settings.manage` on the server). Default true. */
  canManage?: boolean;
  /**
   * The business's public estimate page, e.g. "https://app.example/t/green-acres/estimate"
   * (a path like "/estimate" is completed with this page's address). With it,
   * the screen offers the no-code button and page first, and the keyed React
   * snippet under "For developers".
   */
  publicPageUrl?: string;
  /** The button's colour (`#rrggbb`): the business's brand colour. Default a dark ink. */
  buttonColor?: string | null;
}

const BUTTON_INK_DEFAULT = "#1f2937";

/** Safe inside a double-quoted HTML attribute. */
function attr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * What any website can take, no key and no code beyond a paste (T2A-BO-02):
 * a button in the business's colour (its text white or near-black, whichever
 * reads better on it) and the estimate page in a frame. One line each, so a
 * page builder's "Embed" or "Custom code" box takes it as it is.
 */
export function noCodeSnippets(pageUrl: string, color: string | null | undefined): { button: string; frame: string } {
  const background = typeof color === "string" && /^#[0-9a-f]{6}$/i.test(color) ? color.toLowerCase() : BUTTON_INK_DEFAULT;
  const ink = contrastRatio("#ffffff", background) >= contrastRatio("#111111", background) ? "#ffffff" : "#111111";
  const href = attr(pageUrl);
  return {
    button:
      `<a href="${href}" target="_blank" rel="noopener" style="display:inline-block;padding:12px 20px;border-radius:6px;` +
      `background:${background};color:${ink};font:600 16px/1.2 system-ui,sans-serif;text-decoration:none">Get an instant estimate</a>`,
    frame: `<iframe src="${href}" title="Instant estimate" loading="lazy" style="width:100%;min-height:900px;border:0"></iframe>`,
  };
}

/** The page's address, absolute: a path is completed with this page's origin once the page is in a browser. */
function useAbsolute(url: string | undefined): string | undefined {
  const [absolute, setAbsolute] = useState(url);
  useEffect(() => {
    if (!url || /^https?:\/\//i.test(url) || typeof window === "undefined") {
      setAbsolute(url);
      return;
    }
    try {
      setAbsolute(new URL(url, window.location.origin).toString());
    } catch {
      setAbsolute(url);
    }
  }, [url]);
  return absolute;
}

/** The deployment's public estimator base, in order: the prop, the server's, this page's origin. */
export function resolveEmbedBaseUrl(prop: string | undefined, fromStatus: string | null | undefined): string {
  if (prop) return prop.replace(/\/+$/, "");
  if (fromStatus) return fromStatus.replace(/\/+$/, "");
  if (typeof window !== "undefined" && window.location?.origin && window.location.origin !== "null") return `${window.location.origin}/api/estimator`;
  return "/api/estimator";
}

/** The two ways to paste the estimator into a React site. */
export function embedSnippets(embedBaseUrl: string, key: string): { modal: string; inline: string } {
  const base = JSON.stringify(embedBaseUrl);
  const k = JSON.stringify(key);
  return {
    modal: [
      `import { EstimatorProvider, EstimatorButton, EstimatorModal } from "@adminigloo/estimator-widget";`,
      ``,
      `<EstimatorProvider config={{ baseUrl: ${base}, clientKey: ${k} }}>`,
      `  <EstimatorButton />`,
      `  <EstimatorModal />`,
      `</EstimatorProvider>`,
    ].join("\n"),
    inline: [`import { EstimateTool } from "@adminigloo/estimator-widget";`, ``, `<EstimateTool baseUrl=${base} clientKey=${k} />`].join("\n"),
  };
}

/** One website per line → the list the server checks (trimmed, blanks dropped). */
export function originsFromText(text: string): string[] {
  return text
    .split(/[\n,]+/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export function EmbedKeys(props: EmbedKeysProps) {
  const transport = useAdminTransport(props.transport, props.baseUrl);
  const basics = useAdminBasics(transport);
  const embedBaseUrl = resolveEmbedBaseUrl(props.embedBaseUrl, basics.status?.embedBaseUrl);
  const publicPageUrl = useAbsolute(props.publicPageUrl);
  const [keys, setKeys] = useState<KeyWire[] | null>(null);
  const [error, setError] = useState<ClientError | null>(null);
  const [reload, setReload] = useState(0);
  const [issued, setIssued] = useState<{ key: KeyWire; plaintext: string } | null>(null);
  const headingRef = useRef<HTMLHeadingElement | null>(null);

  // Deep link (Tenancy 2a: the setup checklist's "Get the snippet" goes to
  // "#embed"): scroll here and put focus on the heading.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const focusHash = () => {
      if (window.location.hash !== "#embed" || !headingRef.current) return;
      if (typeof headingRef.current.scrollIntoView === "function") headingRef.current.scrollIntoView({ block: "start" });
      headingRef.current.focus();
    };
    focusHash();
    window.addEventListener("hashchange", focusHash);
    return () => window.removeEventListener("hashchange", focusHash);
  }, []);

  useEffect(() => {
    let alive = true;
    setError(null);
    void transport.listKeys().then((res) => {
      if (!alive) return;
      if (res.ok) setKeys(res.data.keys);
      else setError(res.error);
    });
    return () => {
      alive = false;
    };
  }, [transport, reload]);

  const replace = useCallback((next: KeyWire) => {
    setKeys((list) => (list ? (list.some((k) => k.id === next.id) ? list.map((k) => (k.id === next.id ? next : k)) : [next, ...list]) : [next]));
  }, []);

  const active = (keys ?? []).filter((k) => !k.revokedAt);
  const revoked = (keys ?? []).filter((k) => k.revokedAt);

  return (
    <AdminFrame chrome={props} basics={basics} data={{ "aiew-keys": keys ? "ready" : error ? "error" : "loading" }}>
      <h2 className="aiew-admin-title" id="embed" tabIndex={-1} ref={headingRef}>
        {publicPageUrl ? "Your website" : "Website embed"}
      </h2>
      {publicPageUrl ? (
        <>
          <p className="aiew-muted" data-aiew-no-code="">
            Let customers get a price from your own website. Copy one of these into it: they work on Wix, Squarespace, WordPress,
            GoDaddy or any site that lets you add HTML (look for an &ldquo;Embed&rdquo; or &ldquo;Custom code&rdquo; block). No key
            and no developer needed.
          </p>
          <NoCode pageUrl={publicPageUrl} color={props.buttonColor ?? null} />
        </>
      ) : (
        <p className="aiew-muted">
          Put the estimator on another website you own that is built with React. Make a key for that site, then paste the snippet
          into its code. It needs the @adminigloo/estimator-widget package, which is private: your developer gets access from
          whoever runs this site.
        </p>
      )}
      {error ? <LoadError error={error} onRetry={() => setReload((n) => n + 1)} /> : null}
      {!keys && !error ? <Loading label="Loading keys…" /> : null}
      {keys && publicPageUrl ? (
        <details className="aiew-developer" data-aiew-developer="">
          <summary>For developers: the estimator as a React component, with a key</summary>
          <p className="aiew-hint">
            Only for a website built with React. It needs the @adminigloo/estimator-widget package, which is private: your developer
            gets access from whoever runs this site. Everyone else, use the button or the page above.
          </p>
          {keyScreens()}
        </details>
      ) : keys ? (
        keyScreens()
      ) : null}
    </AdminFrame>
  );

  function keyScreens() {
    return (
      <>
        {props.canManage !== false ? (
          <NewKey
            transport={transport}
            onIssued={(res) => {
              replace(res.key);
              setIssued(res);
              basics.refresh();
            }}
          />
        ) : null}
        {issued ? <IssuedKey issued={issued} embedBaseUrl={embedBaseUrl} onDone={() => setIssued(null)} /> : null}
        <Panel id="keys" title="Your keys">
          {active.length === 0 ? <p className="aiew-muted">No keys yet.</p> : null}
          <ul className="aiew-stack-sm" style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {active.map((key) => (
              <li key={key.id}>
                <KeyRow
                  keyWire={key}
                  transport={transport}
                  locale={props.locale ?? "en-US"}
                  canManage={props.canManage !== false}
                  onChanged={(next) => (replace(next), basics.refresh())}
                />
              </li>
            ))}
          </ul>
          {revoked.length > 0 ? (
            <details>
              <summary>Revoked keys ({revoked.length})</summary>
              <ul className="aiew-stack-sm" style={{ listStyle: "none", margin: 0, padding: 0 }}>
                {revoked.map((key) => (
                  <li key={key.id} className="aiew-key" data-revoked="">
                    <strong>{key.label}</strong> <span>({key.keyPrefix}…)</span> — revoked {formatDateTime(key.revokedAt, props.locale ?? "en-US")}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </Panel>
      </>
    );
  }
}

/** The button and the page frame, each ready to copy (T2A-BO-02). */
function NoCode({ pageUrl, color }: { pageUrl: string; color: string | null }) {
  const snippets = noCodeSnippets(pageUrl, color);
  return (
    <div className="aiew-stack">
      <Panel id="button" title="A button on your website" hint="Customers tap it and get your instant estimate in a new tab.">
        <CopyField label="Button (paste into an Embed or Custom code block)" value={snippets.button} buttonLabel="Copy button" />
        <CopyField
          label="Or point a button you already have at this address"
          value={pageUrl}
          buttonLabel="Copy address"
          hint="Most website builders let you set where a button goes: paste this as its link."
        />
      </Panel>
      <Panel id="page" title="The estimate inside a page of your website" hint="Your estimate page, shown inside one of your own pages.">
        <CopyField label="Page frame (paste into an Embed or Custom code block)" value={snippets.frame} buttonLabel="Copy page frame" />
      </Panel>
    </div>
  );
}

function NewKey({ transport, onIssued }: { transport: EstimatorAdminTransport; onIssued: (res: { key: KeyWire; plaintext: string }) => void }) {
  const ids = useId();
  const [label, setLabel] = useState("");
  const [sites, setSites] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ClientError | null>(null);
  const fields = issuesByField(error);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    if (!label.trim()) {
      setError({ code: "invalid", message: "Name the key.", status: 0, issues: [{ path: ["label"], message: "Name the key, e.g. the website it's for." }] });
      return;
    }
    setBusy(true);
    setError(null);
    const res = await transport.issueKey({ label: label.trim(), allowedOrigins: originsFromText(sites) });
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setLabel("");
    setSites("");
    onIssued(res.data);
  };
  return (
    <Panel id="new-key" title="Add a key" hint="One key per website, so you can switch one off without touching the others.">
      <form className="aiew-stack" onSubmit={(event) => void submit(event)} noValidate>
        <Field id={`${ids}-label`} label="Name" hint={`Which site it's for, e.g. "Main website".`} error={fields.label ?? null}>
          <input
            id={`${ids}-label`}
            className="aiew-input"
            maxLength={100}
            value={label}
            aria-invalid={fields.label ? true : undefined}
            aria-describedby={describedBy(`${ids}-label`, true, fields.label)}
            onChange={(event) => setLabel(event.target.value)}
          />
        </Field>
        <Field
          id={`${ids}-sites`}
          label="Websites it works on"
          optional
          hint="One per line, like https://www.yourbusiness.com. Leave it empty and the key works on any website."
          error={fields.allowedOrigins ?? null}
        >
          <textarea
            id={`${ids}-sites`}
            className="aiew-input"
            rows={3}
            value={sites}
            spellCheck={false}
            aria-invalid={fields.allowedOrigins ? true : undefined}
            aria-describedby={describedBy(`${ids}-sites`, true, fields.allowedOrigins)}
            onChange={(event) => setSites(event.target.value)}
          />
        </Field>
        <div className="aiew-row">
          <button type="submit" className="aiew-btn aiew-btn-primary" disabled={busy} aria-busy={busy || undefined}>
            {busy ? "Making the key…" : "Make the key"}
          </button>
          <Outcome error={error && !fields.label && !fields.allowedOrigins ? adminErrorText(error) : null} />
        </div>
      </form>
    </Panel>
  );
}

/** The key, once, with the snippet and a test. */
function IssuedKey({ issued, embedBaseUrl, onDone }: { issued: { key: KeyWire; plaintext: string }; embedBaseUrl: string; onDone: () => void }) {
  const snippets = embedSnippets(embedBaseUrl, issued.plaintext);
  const snippetIds = useId();
  const [test, setTest] = useState<{ busy: boolean; text: string | null; ok: boolean }>({ busy: false, text: null, ok: false });
  const runTest = async () => {
    setTest({ busy: true, text: null, ok: false });
    const res = await createEstimatorClient({ baseUrl: embedBaseUrl, clientKey: issued.plaintext }).config();
    if (res.ok) {
      const n = res.data.products.length;
      setTest({ busy: false, ok: true, text: `Works: ${n} product${n === 1 ? "" : "s"} on your estimator.` });
    } else {
      setTest({ busy: false, ok: false, text: friendlyError(res.error, "config") });
    }
  };
  return (
    <Panel id="issued" title={`Your new key: ${issued.key.label}`} hint="This is the only time the key is shown. Copy it now; if you lose it, make a new one.">
      <CopyField label="Key" value={issued.plaintext} buttonLabel="Copy key" />
      {/*
        Each snippet is wider than a phone, so its box scrolls sideways — and a
        box that scrolls must take keyboard focus, or someone without a mouse
        can't read the end of the line they're meant to copy (axe:
        scrollable-region-focusable). Focusable, so it carries its own name.
      */}
      <div className="aiew-stack-sm">
        <strong id={`${snippetIds}-modal`}>Paste this into the other site (a button that opens the estimator):</strong>
        <pre className="aiew-code" data-aiew-snippet="modal" tabIndex={0} role="region" aria-labelledby={`${snippetIds}-modal`}>
          {snippets.modal}
        </pre>
        <strong id={`${snippetIds}-inline`}>Or show it in the page:</strong>
        <pre className="aiew-code" data-aiew-snippet="inline" tabIndex={0} role="region" aria-labelledby={`${snippetIds}-inline`}>
          {snippets.inline}
        </pre>
      </div>
      {issued.key.allowedOrigins.length === 0 ? <Notice tone="warn">Works on any website. Add yours.</Notice> : null}
      <div className="aiew-row">
        <button type="button" className="aiew-btn aiew-btn-secondary" onClick={() => void runTest()} disabled={test.busy} aria-busy={test.busy || undefined}>
          {test.busy ? "Testing…" : "Test this key"}
        </button>
        <span role="status" className={test.ok ? "aiew-ok-text" : "aiew-danger-text"} data-aiew-test="">
          {test.text ?? ""}
        </span>
        <button type="button" className="aiew-btn aiew-btn-link" onClick={onDone}>
          I&apos;ve copied it
        </button>
      </div>
    </Panel>
  );
}

function KeyRow({
  keyWire,
  transport,
  locale,
  canManage,
  onChanged,
}: {
  keyWire: KeyWire;
  transport: EstimatorAdminTransport;
  locale: string;
  canManage: boolean;
  onChanged: (key: KeyWire) => void;
}) {
  const ids = useId();
  const [editing, setEditing] = useState(false);
  const [sites, setSites] = useState(keyWire.allowedOrigins.join("\n"));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ClientError | null>(null);
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const fields = issuesByField(error);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const res = await transport.updateKey(keyWire.id, { allowedOrigins: originsFromText(sites) });
    setBusy(false);
    if (!res.ok) return setError(res.error);
    setEditing(false);
    onChanged(res.data.key);
  };

  const revoke = async () => {
    setBusy(true);
    const res = await transport.revokeKey(keyWire.id);
    setBusy(false);
    setConfirmRevoke(false);
    if (!res.ok) return setError(res.error);
    onChanged(res.data.key);
  };

  return (
    <div className="aiew-key" data-aiew-key={keyWire.id}>
      <div className="aiew-row">
        <strong className="aiew-grow">{keyWire.label}</strong>
        <span className="aiew-muted">{keyWire.keyPrefix}…</span>
      </div>
      <p className="aiew-hint">
        {keyWire.lastUsedAt ? `Last used ${formatDateTime(keyWire.lastUsedAt, locale)}.` : "Not used yet."} Made {formatDateTime(keyWire.createdAt, locale)}.
      </p>
      {keyWire.allowedOrigins.length > 0 ? (
        <p>Works on: {keyWire.allowedOrigins.join(", ")}</p>
      ) : (
        <p className="aiew-tag aiew-tag-warn" data-aiew-any-site="">
          Works on any website. Add yours.
        </p>
      )}
      {editing ? (
        <form className="aiew-stack-sm" onSubmit={(event) => void save(event)} noValidate>
          <Field id={`${ids}-sites`} label="Websites it works on" hint="One per line, like https://www.yourbusiness.com." error={fields.allowedOrigins ?? null}>
            <textarea
              id={`${ids}-sites`}
              className="aiew-input"
              rows={3}
              value={sites}
              spellCheck={false}
              aria-invalid={fields.allowedOrigins ? true : undefined}
              aria-describedby={describedBy(`${ids}-sites`, true, fields.allowedOrigins)}
              onChange={(event) => setSites(event.target.value)}
            />
          </Field>
          <div className="aiew-row">
            <button type="submit" className="aiew-btn aiew-btn-primary aiew-btn-sm" disabled={busy}>
              Save websites
            </button>
            <button type="button" className="aiew-btn aiew-btn-secondary aiew-btn-sm" onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
        </form>
      ) : canManage ? (
        <div className="aiew-row">
          <button type="button" className="aiew-btn aiew-btn-secondary aiew-btn-sm" onClick={() => setEditing(true)}>
            Edit websites
          </button>
          <button type="button" className="aiew-btn aiew-btn-danger-outline aiew-btn-sm" onClick={() => setConfirmRevoke(true)}>
            Revoke
          </button>
        </div>
      ) : null}
      {error && !fields.allowedOrigins ? <Outcome error={adminErrorText(error)} /> : null}
      {confirmRevoke ? (
        <Dialog title={`Revoke "${keyWire.label}"?`} onClose={() => setConfirmRevoke(false)}>
          <p>The estimator stops working on the websites using this key straight away. This can&apos;t be undone; you can make a new key.</p>
          <div className="aiew-actions">
            <button type="button" className="aiew-btn aiew-btn-danger" onClick={() => void revoke()} disabled={busy} data-autofocus="">
              Revoke the key
            </button>
            <button type="button" className="aiew-btn aiew-btn-secondary" onClick={() => setConfirmRevoke(false)}>
              Keep it
            </button>
          </div>
        </Dialog>
      ) : null}
    </div>
  );
}
