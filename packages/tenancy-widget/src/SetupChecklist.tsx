import { useEffect, useId, useState } from "react";
import type { TenancyTransport } from "./client.js";
import {
  CheckCircleIcon,
  CircleIcon,
  LiveRegion,
  Loading,
  Notice,
  WidgetRoot,
  type ChromeProps,
  type NounProps,
} from "./parts.js";
import { isUnconnected, useAnnouncer, useLoaded, useTenancyTransport } from "./transport.js";
import type { ChecklistWire } from "./types.js";
import { CHECKLIST, errorText, nounOf, NOT_CONNECTED_MESSAGE, W } from "./words.js";

/**
 * <SetupChecklist> (contract 8.5): what's left before the company is ready,
 * on the dashboard. The items come from the server's registry (tenancy ships
 * the company and team items; other packages add theirs), already filtered to
 * what this person may do, so a member who can do none of them sees nothing.
 *
 * FRESH WITHOUT A RELOAD. The owner usually ticks an item in another tab (the
 * settings page the item links to), so the list asks again whenever the tab
 * becomes visible.
 *
 * "HIDE THIS LIST" WAITS. Until everything is done or skipped it sits behind
 * "More", so it isn't the tempting way out of a list nobody has started.
 */

export interface SetupChecklistProps extends ChromeProps, NounProps {
  baseUrl?: string;
  transport?: TenancyTransport;
  tenantId: string;
  /** Server-rendered, so there is no loading flash. */
  initial?: ChecklistWire;
  /** Default "Finish setting up". */
  title?: string;
  /**
   * The dashboard's shape: the done items fold into one "3 done" line, the
   * open ones keep their one sentence, and the spacing is tighter — so the
   * list reads as "what's left", not as a wall of nine cards. Default false.
   */
  compact?: boolean;
}

export function SetupChecklist(props: SetupChecklistProps) {
  const { tenantId, title = CHECKLIST.title, theme, nonce, className, style } = props;
  const noun = nounOf(props.noun);
  const transport = useTenancyTransport(props.transport, props.baseUrl);
  const unconnected = isUnconnected(props.transport, props.baseUrl);
  const list = useLoaded(() => transport.checklist(tenantId), props.initial, unconnected ? null : tenantId);
  const { status, alert, announce, fail } = useAnnouncer();
  const [busy, setBusy] = useState<string | null>(null);
  const headingId = useId();
  const progressId = useId();
  const chrome = { theme, nonce, className, style };
  const reload = list.reload;

  useEffect(() => {
    if (unconnected || typeof document === "undefined") return;
    const onVisible = () => {
      if (document.visibilityState === "visible") void reload();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [reload, unconnected]);

  if (unconnected) {
    return (
      <WidgetRoot {...chrome}>
        <div className="aitw-panel">
          <Notice tone="error">{NOT_CONNECTED_MESSAGE}</Notice>
        </div>
      </WidgetRoot>
    );
  }
  const data = list.data;
  if (!data) {
    if (list.loading) {
      return (
        <WidgetRoot {...chrome}>
          <div className="aitw-panel">
            <Loading label={W.loading} />
          </div>
        </WidgetRoot>
      );
    }
    // A dashboard extra that can't load says nothing rather than shout: the
    // owner's work is elsewhere on the page.
    return null;
  }
  if (data.items.length === 0) return null;

  const show = async () => {
    setBusy("__show");
    const res = await transport.showChecklist(tenantId);
    setBusy(null);
    if (res.ok) list.set(res.data);
    else fail(errorText(res.error, noun));
  };

  // A hidden list leaves one quiet way back (review T1-13): hiding was a
  // one-way door, and a mis-tap meant the list was gone for good.
  if (data.hidden) {
    return (
      <WidgetRoot {...chrome} data={{ "aitw-checklist": "hidden" }}>
        <button type="button" className="aitw-btn aitw-btn-link" disabled={busy !== null} onClick={() => void show()}>
          {CHECKLIST.show}
        </button>
        <LiveRegion status={status} alert={alert} />
      </WidgetRoot>
    );
  }

  const restore = async (key: string, itemTitle: string) => {
    setBusy(key);
    const res = await transport.restoreChecklistItem(tenantId, key);
    setBusy(null);
    if (res.ok) {
      list.set(res.data);
      announce(CHECKLIST.restored(itemTitle));
    } else {
      fail(errorText(res.error, noun));
    }
  };

  const dismiss = async (key: string, itemTitle: string) => {
    setBusy(key);
    const res = await transport.dismissChecklistItem(tenantId, key);
    setBusy(null);
    if (res.ok) {
      list.set(res.data);
      announce(CHECKLIST.dismissed(itemTitle));
    } else {
      fail(errorText(res.error, noun));
    }
  };

  const hide = async () => {
    setBusy("__hide");
    const res = await transport.hideChecklist(tenantId);
    setBusy(null);
    if (res.ok) list.set(res.data);
    else fail(errorText(res.error, noun));
  };

  const progressText = CHECKLIST.progress(data.done, data.total);
  const compact = props.compact === true;
  // Compact: what's left, in full; what's done (or skipped), folded away.
  const shown = compact ? data.items.filter((item) => !item.done && !item.dismissed) : data.items;
  const folded = compact ? data.items.filter((item) => item.done || item.dismissed) : [];
  const hideButton = (
    <button type="button" className="aitw-btn aitw-btn-secondary" disabled={busy !== null} onClick={() => void hide()}>
      {CHECKLIST.hide}
    </button>
  );

  return (
    <WidgetRoot {...chrome} data={{ "aitw-checklist": data.complete ? "complete" : "open" }}>
      <section className={compact ? "aitw-panel aitw-checklist-compact" : "aitw-panel"} aria-labelledby={headingId}>
        <div className="aitw-head">
          <h2 className="aitw-title" id={headingId}>
            {title}
          </h2>
        </div>
        <div className="aitw-progress-row">
          <label className="aitw-sub" htmlFor={progressId}>
            {progressText}
          </label>
          <progress id={progressId} className="aitw-progress" value={data.done} max={Math.max(1, data.total)}>
            {progressText}
          </progress>
        </div>
        <ul className="aitw-items">
          {shown.map((item) => (
            <li key={item.key} className="aitw-item" data-item={item.key} data-done={item.done ? "" : undefined} data-dismissed={item.dismissed && !item.done ? "" : undefined}>
              <span className="aitw-item-icon">{item.done ? <CheckCircleIcon /> : <CircleIcon />}</span>
              <div className="aitw-item-main">
                <p className="aitw-item-title">
                  {item.title}
                  <span className="aitw-sr">. {item.done ? CHECKLIST.done : item.dismissed ? CHECKLIST.skipped : ""}</span>
                </p>
                <p className="aitw-item-desc">{item.description}</p>
              </div>
              <div className="aitw-item-actions">
                {item.done ? (
                  <span className="aitw-tag aitw-tag-ok">{CHECKLIST.done}</span>
                ) : item.dismissed ? (
                  <>
                    <span className="aitw-tag">{CHECKLIST.skipped}</span>
                    {/* "Not needed" sits right beside the action link, so a
                        mis-tap must be one tap to undo (review T1-13). */}
                    <button
                      type="button"
                      className="aitw-btn aitw-btn-link"
                      disabled={busy !== null}
                      aria-busy={busy === item.key || undefined}
                      onClick={() => void restore(item.key, item.title)}
                    >
                      {CHECKLIST.undo}
                      <span className="aitw-sr">: {item.title}</span>
                    </button>
                  </>
                ) : (
                  <>
                    {item.href ? (
                      <a className="aitw-btn aitw-btn-secondary aitw-btn-sm" href={item.href}>
                        {item.actionLabel || item.title}
                      </a>
                    ) : null}
                    <button
                      type="button"
                      className="aitw-btn aitw-btn-link"
                      disabled={busy !== null}
                      aria-busy={busy === item.key || undefined}
                      onClick={() => void dismiss(item.key, item.title)}
                    >
                      {CHECKLIST.notNeeded}
                      <span className="aitw-sr">: {item.title}</span>
                    </button>
                  </>
                )}
              </div>
            </li>
          ))}
        </ul>
        {folded.length > 0 ? (
          <details className="aitw-more" data-aitw-folded="">
            <summary>{folded.length === 1 ? "1 done or skipped" : `${folded.length} done or skipped`}</summary>
            <ul className="aitw-folded">
              {folded.map((item) => (
                <li key={item.key} data-item={item.key} data-done={item.done ? "" : undefined} data-dismissed={item.dismissed && !item.done ? "" : undefined}>
                  <span className="aitw-item-icon">{item.done ? <CheckCircleIcon /> : <CircleIcon />}</span>
                  <span className="aitw-folded-title">{item.title}</span>
                  {!item.done && item.dismissed ? (
                    <button
                      type="button"
                      className="aitw-btn aitw-btn-link"
                      disabled={busy !== null}
                      onClick={() => void restore(item.key, item.title)}
                    >
                      {CHECKLIST.undo}
                      <span className="aitw-sr">: {item.title}</span>
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
          </details>
        ) : null}
        {data.complete ? (
          <div className="aitw-row">
            <p className="aitw-ok-text aitw-grow">{CHECKLIST.allSet}</p>
            {hideButton}
          </div>
        ) : (
          <details className="aitw-more">
            <summary>{CHECKLIST.more}</summary>
            <div className="aitw-actions">{hideButton}</div>
          </details>
        )}
        <LiveRegion status={status} alert={alert} />
      </section>
    </WidgetRoot>
  );
}
