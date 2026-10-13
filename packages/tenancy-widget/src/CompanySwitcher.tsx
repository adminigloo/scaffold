import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import type { TenancyTransport } from "./client.js";
import {
  CheckIcon,
  ChevronDownIcon,
  CompanyMark,
  navigate,
  WidgetRoot,
  type ChromeProps,
  type NounProps,
} from "./parts.js";
import { isUnconnected, useLoaded, useTenancyTransport } from "./transport.js";
import type { CompanyChoiceWire, SessionWire } from "./types.js";
import { errorText, nounOf, SWITCHER, W } from "./words.js";

/**
 * <CompanySwitcher> (contract 8.4): the header button that says which company
 * you're working in, and a menu to move to another.
 *
 * SWITCHING IS A FULL RELOAD. The active company decides what every server
 * page renders (decision D3), so after `setActive` the browser loads
 * `reloadHref` from scratch: the header, the page gate and the page all
 * resolve the new company together. A client-side swap would leave the page
 * below showing the old company's people under the new company's name.
 *
 * A SUSPENDED COMPANY CAN STILL BE CHOSEN. Its members need somewhere to
 * learn it's suspended; the page they land on explains, and offers the
 * others.
 */

export interface CompanySwitcherProps extends ChromeProps, NounProps {
  baseUrl?: string;
  transport?: TenancyTransport;
  /** Server-resolved; renders with no fetch. Without it the component asks for the session on mount. */
  session?: SessionWire;
  /** Where to go after switching. Default "/dashboard". */
  reloadHref?: string;
  /** "Create another {noun}". Default "/onboarding?another=1"; null = no link. */
  createHref?: string | null;
  /** "{Noun} settings". Default "/settings/company"; null = no link. */
  settingsHref?: string | null;
  /** "Team". Default "/settings/team"; null = no link. */
  teamHref?: string | null;
}

const NAME_MAX = 24;
/** The menu's widest likely size (its CSS min-width is 240px), for choosing which edge it hangs from. */
const MENU_WIDTH = 260;

/** The name cut to 24 characters with an ellipsis; the full name goes in `title`. */
export function shortName(name: string): string {
  const chars = [...name];
  return chars.length > NAME_MAX ? `${chars.slice(0, NAME_MAX - 1).join("").trimEnd()}…` : name;
}

export function CompanySwitcher(props: CompanySwitcherProps) {
  const { reloadHref = "/dashboard", theme, nonce, className, style } = props;
  const noun = nounOf(props.noun);
  const transport = useTenancyTransport(props.transport, props.baseUrl);
  const unconnected = isUnconnected(props.transport, props.baseUrl);
  const session = useLoaded(() => transport.session(), props.session, unconnected && !props.session ? null : "session");
  const chrome = { theme, nonce, className, style };

  const [open, setOpen] = useState(false);
  /**
   * Which edge the menu hangs from. A switcher at the right of a header
   * (where hosts usually put it) would otherwise open its 240px menu
   * rightwards off the screen of a phone (review T1-05).
   */
  const [align, setAlign] = useState<"start" | "end">("start");
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState("");
  const rootRef = useRef<HTMLSpanElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const menuId = useId();

  const items = () => [...(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"], [role="menuitem"]') ?? [])];

  const close = (returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) buttonRef.current?.focus();
  };

  // On open, focus lands on the company you're in (or the first item).
  useEffect(() => {
    if (!open) return;
    const list = items();
    const checked = list.find((el) => el.getAttribute("aria-checked") === "true");
    (checked ?? list[0])?.focus();
  }, [open]);

  // A click anywhere outside closes the menu (without stealing focus back).
  useEffect(() => {
    if (!open || typeof document === "undefined") return;
    const onDown = (event: MouseEvent | TouchEvent) => {
      if (rootRef.current && event.target instanceof Node && !rootRef.current.contains(event.target)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("touchstart", onDown);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("touchstart", onDown);
    };
  }, [open]);

  const data = session.data;
  // The header must never fail a page: no session (still loading, or an
  // error) renders an empty slot, never an error box in the nav bar.
  if (!data) {
    return (
      <WidgetRoot {...chrome}>
        <span className="aitw-sr" role="status">
          {session.loading ? W.loading : ""}
        </span>
      </WidgetRoot>
    );
  }

  if (data.state === "needs-onboarding" || !data.company) {
    return (
      <WidgetRoot {...chrome} data={{ "aitw-switcher": "setup" }}>
        <a className="aitw-btn aitw-btn-secondary" href={props.createHref ?? "/onboarding"}>
          {SWITCHER.setUp(noun)}
        </a>
      </WidgetRoot>
    );
  }

  const company = data.company;
  const choices: CompanyChoiceWire[] = data.companies.length > 0
    ? data.companies
    : [{ id: company.id, name: company.name, slug: company.slug, logoUrl: company.logoUrl, role: company.role, status: company.status, active: true }];

  // Personal mode: one workspace needs no switcher at all; two or more (an
  // accepted invitation) get the menu, with no "Create another".
  if (data.mode === "personal" && choices.length < 2) return null;

  const createHref = props.createHref === undefined ? "/onboarding?another=1" : props.createHref;
  const settingsHref = props.settingsHref === undefined ? "/settings/company" : props.settingsHref;
  const teamHref = props.teamHref === undefined ? "/settings/team" : props.teamHref;
  const links = [
    createHref ? { href: createHref, label: SWITCHER.createAnother(noun), key: "create" } : null,
    settingsHref ? { href: settingsHref, label: SWITCHER.settings(noun), key: "settings" } : null,
    teamHref ? { href: teamHref, label: SWITCHER.team, key: "team" } : null,
  ].filter((link): link is { href: string; label: string; key: string } => link !== null);

  const choose = async (choice: CompanyChoiceWire) => {
    if (busy) return;
    if (choice.id === company.id) {
      close(true);
      return;
    }
    setBusy(choice.id);
    setProblem("");
    const res = await transport.setActive(choice.id);
    if (res.ok) {
      navigate(reloadHref);
      return;
    }
    setBusy(null);
    setProblem(errorText(res.error, noun));
  };

  /** Open the menu, hanging it from whichever edge keeps it on screen. */
  const openMenu = () => {
    const rect = buttonRef.current?.getBoundingClientRect();
    const viewport = typeof window !== "undefined" ? window.innerWidth : 0;
    setAlign(rect && viewport > 0 && rect.left + MENU_WIDTH > viewport - 8 ? "end" : "start");
    setOpen(true);
  };

  const onButtonKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      openMenu();
    }
  };

  const onMenuKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const list = items();
    const at = list.indexOf(document.activeElement as HTMLElement);
    const move = (to: number) => {
      event.preventDefault();
      list[(to + list.length) % list.length]?.focus();
    };
    switch (event.key) {
      case "ArrowDown":
        return move(at + 1);
      case "ArrowUp":
        return move(at - 1);
      case "Home":
        return move(0);
      case "End":
        return move(list.length - 1);
      case "Escape":
        event.preventDefault();
        return close(true);
      case "Tab":
        // Tab leaves the menu the way it leaves anything: the menu closes and
        // focus moves on to the next thing in the page.
        setOpen(false);
        return;
      case " ":
        // Space chooses a company the way Enter does (a link already follows on Enter).
        if (document.activeElement instanceof HTMLButtonElement) {
          event.preventDefault();
          document.activeElement.click();
        }
        return;
      default:
        return;
    }
  };

  return (
    <WidgetRoot {...chrome} data={{ "aitw-switcher": data.mode }}>
      <span className="aitw-switcher" ref={rootRef}>
        <button
          ref={buttonRef}
          type="button"
          className="aitw-switcher-btn"
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={open ? menuId : undefined}
          aria-label={SWITCHER.buttonName(company.name, noun)}
          title={company.name}
          onClick={() => (open ? setOpen(false) : openMenu())}
          onKeyDown={onButtonKey}
        >
          <CompanyMark name={company.name} logoUrl={company.logoUrl} />
          <span className="aitw-switcher-name">{shortName(company.name)}</span>
          <ChevronDownIcon />
        </button>
        {open ? (
          <div className="aitw-menu" data-aitw-menu="" data-align={align}>
            <div role="menu" id={menuId} aria-label={SWITCHER.menuLabel(noun)} ref={menuRef} onKeyDown={onMenuKey} className="aitw-stack-sm">
              {choices.map((choice) => {
                const checked = choice.id === company.id;
                return (
                  <button
                    key={choice.id}
                    type="button"
                    role="menuitemradio"
                    aria-checked={checked}
                    tabIndex={-1}
                    className="aitw-menu-item"
                    data-company={choice.id}
                    disabled={busy !== null && busy !== choice.id}
                    aria-busy={busy === choice.id || undefined}
                    title={choice.name}
                    onClick={() => void choose(choice)}
                  >
                    <CompanyMark name={choice.name} logoUrl={choice.logoUrl} />
                    <span className="aitw-menu-text">{choice.name}</span>
                    {/* The space keeps the spoken name "Side Gig Suspended", not "Side GigSuspended". */}
                    {choice.status === "suspended" ? <> <span className="aitw-tag aitw-tag-warn">{SWITCHER.suspendedSuffix}</span></> : null}
                    {checked ? (
                      <span className="aitw-menu-check">
                        <CheckIcon />
                      </span>
                    ) : null}
                  </button>
                );
              })}
              {links.length > 0 ? <hr className="aitw-menu-sep" role="separator" /> : null}
              {links.map((link) => (
                <a key={link.key} role="menuitem" tabIndex={-1} className="aitw-menu-item" href={link.href} data-link={link.key}>
                  <span className="aitw-menu-text">{link.label}</span>
                </a>
              ))}
            </div>
            <p className="aitw-menu-status aitw-status" role="alert">
              {problem}
            </p>
          </div>
        ) : null}
      </span>
    </WidgetRoot>
  );
}
