"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";

/** One link as the frame draws it: already filtered for the viewer by `AuthHeader`. */
export interface FrameLink {
  readonly href: string;
  readonly label: string;
  /** Something there needs the person (src/server/nav-badges.ts); absent or 0 draws nothing. */
  readonly badge?: number;
}

/** A sidebar heading and the links under it. `heading: null` sits above the headings (Dashboard). */
export interface FrameGroup {
  readonly heading: string | null;
  readonly links: readonly FrameLink[];
}

/** What a company's work area needs: who it is, its grouped links, and where it lives. */
export interface FrameWork {
  readonly company: { readonly name: string; readonly logoUrl: string | null };
  readonly groups: readonly FrameGroup[];
  /** The person's own links (Your account, Admin): in the top bar, not the sidebar. */
  readonly bar: readonly FrameLink[];
  /** The paths that are the work area ("/dashboard", "/app", ...); everything else is the public site. */
  readonly prefixes: readonly string[];
}

/**
 * The site's chrome, in one of two shapes, chosen by the URL.
 *
 * THE PUBLIC SITE (the landing page, the shop, pricing, sign-in, and every
 * page for someone signed out or without a company): a header with the site's
 * name and its public links, folded into a Menu below `md`.
 *
 * A COMPANY'S WORK AREA (/dashboard, /app/…, /settings/…, /account/… for
 * someone in a company): a left sidebar with the company switcher at the top
 * and the company's links under plain-word headings, the way Jobber and
 * Housecall Pro lay out a field-service business's screens. Below `lg` the
 * sidebar becomes a drawer behind a Menu button. The top bar keeps the bell
 * and the account button and nothing else, so nothing in it can collide. The
 * public site's links are not in here: a business owner at work has no use for
 * this site's own Products and Pricing next to their own Store.
 *
 * A CLIENT COMPONENT because it is mounted by the `(site)` layout, and a
 * layout is NOT re-rendered when the person moves between the pages under it
 * — only `usePathname` knows whether this page is the public site or the work
 * area. Everything it draws was decided on the server (`AuthHeader`): which
 * links exist, which this person may open, and the server-rendered switcher,
 * bell and account button passed in as elements.
 */
export function SiteFrame(props: {
  readonly siteName: string;
  readonly siteLinks: readonly FrameLink[];
  /** The signed-in person's links on the public site (Dashboard, Your account, ...); [] signed out. */
  readonly headerLinks: readonly FrameLink[];
  /** Null: no work area for this person (signed out, no company yet, or a single business). */
  readonly work: FrameWork | null;
  /** The company switcher: top of the sidebar in the work area, in the header otherwise. */
  readonly switcher?: ReactNode;
  readonly bell?: ReactNode;
  /** The account button, or Sign in, or the "sign-in is off" note. */
  readonly account: ReactNode;
  readonly banner?: ReactNode;
  readonly footer?: ReactNode;
  readonly children: ReactNode;
}) {
  const pathname = usePathname() ?? "/";
  const work = props.work;
  const inWork = work !== null && work.prefixes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));

  if (!work || !inWork) {
    return (
      <div className="flex min-h-dvh flex-col">
        <header className="border-b border-line bg-surface">
          <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-x-6 gap-y-2 px-4 py-3 sm:px-6">
            {/* The site's name, in words, as a link home: on every site ever
                built it is, and a customer three pages into a storefront tries
                it before they look for a Home link. */}
            <Link href="/" className="min-w-0 truncate text-base font-semibold tracking-tight text-ink no-underline">
              {props.siteName}
            </Link>
            <div className="flex min-w-0 flex-wrap items-center justify-end gap-x-4 gap-y-2">
              <nav aria-label="Main" className="hidden items-center gap-4 md:flex">
                {props.siteLinks.map((link) => (
                  <Link key={link.href} href={link.href} className="text-sm text-ink-muted no-underline hover:text-ink">
                    {link.label}
                  </Link>
                ))}
                {props.headerLinks.map((link) => (
                  <Link key={link.href} href={link.href} className="text-sm font-medium text-accent no-underline hover:underline">
                    {link.label}
                    <Badge count={link.badge} />
                  </Link>
                ))}
              </nav>
              <Fragment key="switcher">{work ? null : props.switcher}</Fragment>
              <PhoneMenu links={[...props.siteLinks, ...props.headerLinks]} />
              {/* Each server-rendered slot in a keyed Fragment: an element made by
                  a server component, placed bare among static siblings, draws
                  React's "unique key" warning in development. */}
              <Fragment key="bell">{props.bell}</Fragment>
              <Fragment key="account">{props.account}</Fragment>
            </div>
          </div>
        </header>
        <Fragment key="banner">{props.banner}</Fragment>
        <div className="flex-1">{props.children}</div>
        <Fragment key="footer">{props.footer}</Fragment>
      </div>
    );
  }

  return <WorkArea {...props} work={work} pathname={pathname} />;
}

function WorkArea(props: {
  readonly work: FrameWork;
  readonly pathname: string;
  readonly switcher?: ReactNode;
  readonly bell?: ReactNode;
  readonly account: ReactNode;
  readonly banner?: ReactNode;
  readonly children: ReactNode;
}) {
  const { work, pathname } = props;
  const [open, setOpen] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  const drawer = useRef<HTMLElement>(null);
  // Set by a close the person asked for; focus goes back to the Menu button
  // once the page behind is no longer inert (after the render, not before).
  const returnFocus = useRef(false);

  // A link in the drawer was followed: close it. (The layout stays mounted.)
  useEffect(() => setOpen(false), [pathname]);

  // While the drawer is open: Escape closes it, the page behind it does not
  // scroll, and focus starts on its first control and returns to the Menu
  // button after.
  useEffect(() => {
    if (!open) {
      if (returnFocus.current) menuButton.current?.focus();
      returnFocus.current = false;
      return;
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        returnFocus.current = true;
        setOpen(false);
      }
    };
    document.addEventListener("keydown", onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    drawer.current?.querySelector<HTMLElement>("a, button")?.focus();
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
    };
  }, [open]);

  // The ONE current link: the longest href this path is under, so
  // /app/schedule/today marks Today's route and not Schedule as well.
  const all = work.groups.flatMap((group) => group.links);
  const current = all
    .filter((link) => pathname === link.href || pathname.startsWith(`${link.href}/`))
    .sort((a, b) => b.href.length - a.href.length)[0]?.href;

  const close = () => {
    returnFocus.current = true;
    setOpen(false);
  };

  return (
    <div className="min-h-dvh lg:flex">
      {open ? (
        <button
          type="button"
          aria-label="Close menu"
          tabIndex={-1}
          className="fixed inset-0 z-40 bg-black/40 lg:hidden"
          onClick={close}
        />
      ) : null}
      <aside
        ref={drawer}
        id="work-nav"
        aria-label={`${work.company.name} menu`}
        // Visible AT ONCE on open (so focus can land in it), hidden only after
        // the slide-out on close: the transition list differs by state.
        className={`fixed inset-y-0 left-0 z-50 flex w-72 max-w-[85vw] flex-col border-r border-line bg-surface duration-200 lg:sticky lg:top-0 lg:z-auto lg:h-dvh lg:w-64 lg:max-w-none lg:shrink-0 lg:translate-x-0 lg:visible ${
          open
            ? "visible translate-x-0 shadow-lg transition-transform"
            : "invisible -translate-x-full transition-[transform,visibility]"
        }`}
      >
        <div className="flex items-center gap-2 border-b border-line p-3">
          {/* THE COMPANY SWITCHER at the top, where the company's name and
              logo are: which one you're in, and the others you belong to. */}
          <div className="min-w-0 flex-1">{props.switcher ?? <CompanyName company={work.company} />}</div>
          <button
            type="button"
            onClick={close}
            className="inline-flex size-11 shrink-0 items-center justify-center rounded-[6px] text-ink-muted hover:bg-canvas hover:text-ink lg:hidden"
          >
            <span className="sr-only">Close menu</span>
            <svg aria-hidden="true" viewBox="0 0 20 20" className="size-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
              <path d="M5 5l10 10M15 5L5 15" />
            </svg>
          </button>
        </div>
        <nav aria-label={work.company.name} className="flex-1 overflow-y-auto px-2 py-3">
          {work.groups.map((group) => (
            <div key={group.heading ?? "top"} className={group.heading ? "mt-4" : undefined}>
              {group.heading ? (
                <p className="px-3 pb-1 text-xs font-semibold text-ink-muted">{group.heading}</p>
              ) : null}
              <ul className="flex flex-col gap-0.5">
                {group.links.map((link) => (
                  <li key={link.href}>
                    <Link
                      href={link.href}
                      aria-current={link.href === current ? "page" : undefined}
                      className={`flex min-h-11 items-center rounded-[6px] px-3 text-sm no-underline lg:min-h-9 ${
                        link.href === current
                          ? "bg-accent-soft font-semibold text-ink"
                          : "font-medium text-ink hover:bg-canvas"
                      }`}
                    >
                      <span className="min-w-0 flex-1 truncate">{link.label}</span>
                      <Badge count={link.badge} />
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>
        {/* On a phone the top bar has no room for these: they sit here. Rows are
            44px wherever the sidebar is a touch drawer, 36px on a desktop. */}
        {work.bar.length > 0 ? (
          <ul className="flex flex-col gap-0.5 border-t border-line px-2 py-2 sm:hidden">
            {work.bar.map((link) => (
              <li key={link.href}>
                <Link href={link.href} className="flex min-h-11 items-center rounded-[6px] px-3 text-sm text-ink-muted no-underline hover:bg-canvas hover:text-ink">
                  {link.label}
                </Link>
              </li>
            ))}
          </ul>
        ) : null}
      </aside>

      <div inert={open || undefined} className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 border-b border-line bg-surface">
          <div className="flex min-h-14 items-center gap-3 px-3 sm:px-4 lg:px-6">
            <button
              ref={menuButton}
              type="button"
              aria-expanded={open}
              aria-controls="work-nav"
              onClick={() => setOpen(true)}
              className="inline-flex size-11 shrink-0 items-center justify-center rounded-[6px] border border-line text-ink hover:bg-canvas lg:hidden"
            >
              <span className="sr-only">Menu</span>
              <svg aria-hidden="true" viewBox="0 0 20 20" className="size-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                <path d="M3 5h14M3 10h14M3 15h14" />
              </svg>
            </button>
            <div className="min-w-0 flex-1 lg:hidden">
              <CompanyName company={work.company} />
            </div>
            <div className="ml-auto flex shrink-0 items-center gap-3 sm:gap-4">
              {work.bar.length > 0 ? (
                <nav aria-label="Your links" className="hidden items-center gap-4 sm:flex">
                  {work.bar.map((link) => (
                    <Link key={link.href} href={link.href} className="text-sm text-ink-muted no-underline hover:text-ink">
                      {link.label}
                    </Link>
                  ))}
                </nav>
              ) : null}
              {/* Each server-rendered slot in a keyed Fragment: an element made by
                  a server component, placed bare among static siblings, draws
                  React's "unique key" warning in development. */}
              <Fragment key="bell">{props.bell}</Fragment>
              <Fragment key="account">{props.account}</Fragment>
            </div>
          </div>
        </header>
        <Fragment key="banner">{props.banner}</Fragment>
        <div className="min-w-0 flex-1">{props.children}</div>
      </div>
    </div>
  );
}

/** The company's logo when it has one, and its name, in words. */
function CompanyName({ company }: { readonly company: FrameWork["company"] }) {
  return (
    <Link href="/dashboard" className="flex min-h-11 min-w-0 items-center gap-2 text-base font-semibold tracking-tight text-ink no-underline">
      {company.logoUrl ? (
        // eslint-disable-next-line @next/next/no-img-element -- a company's
        // logo is any URL its owner uploaded; next/image refuses hosts absent
        // from next.config's remotePatterns.
        <img src={company.logoUrl} alt="" className="size-7 shrink-0 rounded-[6px] object-contain" />
      ) : null}
      <span className="min-w-0 truncate">{company.name}</span>
    </Link>
  );
}

/** A count beside a link while something there needs the person; nothing at 0. */
function Badge({ count }: { readonly count: number | undefined }) {
  if (!count) return null;
  return (
    <span
      className="ml-1 inline-flex min-w-5 shrink-0 items-center justify-center rounded-full bg-danger px-1.5 text-xs font-semibold text-surface no-underline"
      aria-label={`, ${count} need your attention`}
      data-nav-badge=""
    >
      {count}
    </span>
  );
}

/**
 * The public links, folded into a disclosure below `md`. A native <details>,
 * so it works with no JavaScript and the keyboard and screen readers already
 * know it; each row is at least 44px tall, the size a thumb can hit.
 */
function PhoneMenu({ links }: { readonly links: readonly FrameLink[] }) {
  const pathname = usePathname();
  const menu = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    if (menu.current) menu.current.open = false;
  }, [pathname]);
  if (links.length === 0) return null;
  return (
    <details ref={menu} className="relative md:hidden">
      <summary className="flex min-h-11 cursor-pointer list-none items-center rounded-[6px] border border-line px-3 text-sm text-ink">
        Menu
      </summary>
      <nav
        aria-label="Menu"
        className="absolute right-0 z-20 mt-1 flex w-56 max-w-[calc(100vw-2rem)] flex-col rounded-[6px] border border-line bg-surface py-1 shadow-lg"
      >
        {links.map((link) => (
          <Link key={link.href} href={link.href} className="flex min-h-11 items-center px-4 text-sm text-ink no-underline hover:bg-canvas">
            {link.label}
            <Badge count={link.badge} />
          </Link>
        ))}
      </nav>
    </details>
  );
}
