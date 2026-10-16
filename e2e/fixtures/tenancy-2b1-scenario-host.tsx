/**
 * The host page of the Tenancy 2b-1 scenario (contract 16): the Tenancy 2a
 * scenario's screens (fixtures/tenancy-2a-scenario-host.tsx, which this copies
 * and leaves alone) plus ALERTS and FILES, as create-app 0.24's emitted pages
 * render them — the bell in every company page's header
 * (src/components/AlertsBellSlot.tsx), /app/alerts, /app/alerts/settings,
 * /app/files, a visit's photos and files, and "Photos and files" under the
 * estimate and invoice editors (src/components/RecordFilesSlot.tsx).
 * fixtures/tenancy-2b1-scenario-server.ts computes `window.__page` per request
 * and serves this bundle as /widgets.js. The widgets come from SOURCE
 * (bundle.mjs's `tenancy2b1ScenarioTarget`) against the BUILT server packages.
 */
import { StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import {
  AcceptInvitation,
  CompanyBrandBar,
  CompanySettings,
  CompanySuspended,
  CompanySwitcher,
  CompanyUnavailable,
  Onboarding,
  SetupChecklist,
  TeamManager,
} from "../../packages/tenancy-widget/src/index.ts";
import { CompaniesConsole, CompanyDetail } from "../../packages/tenancy-widget/src/admin/index.ts";
import { ManageVisit, VisitPicker } from "../../packages/scheduling-widget/src/index.ts";
import { CrewDay, ScheduleCalendar, SchedulingSettings } from "../../packages/scheduling-widget/src/admin/index.ts";
import { EstimateTool, QuoteView } from "../../packages/estimator-widget/src/index.ts";
import { EmbedKeys, EstimateEditor, EstimatesQueue, EstimatorSettings, PriceBook } from "../../packages/estimator-widget/src/admin/index.ts";
import { InvoiceView } from "../../packages/invoicing-widget/src/index.ts";
import { InvoiceEditor, InvoicesLedger } from "../../packages/invoicing-widget/src/admin/index.ts";
import { MessagesConsole } from "../../packages/comms-widget/src/admin/index.ts";
import { AlertSettings, AlertsBell, AlertsInbox } from "../../packages/notifications-widget/src/admin/index.ts";
import { FilesManager, RecordFiles } from "../../packages/storage-widget/src/admin/index.ts";

/* eslint-disable @typescript-eslint/no-explicit-any -- window.__page is the server's JSON */
const cfg: any = (window as any).__page;
const TENANCY_API = "/api/tenancy";
const TENANCY_ADMIN_API = "/api/admin/tenancy";
const NOUN = { singular: "company", plural: "companies" } as const;

/** src/components/AuthHeader.tsx: the brand, the permission-filtered links, the switcher and the account button. */
function Header() {
  if (!cfg.session) return null;
  return (
    <header className="e2e-header">
      <a href="/" className="e2e-brand">
        Igloo Back Office
      </a>
      <nav aria-label="Main" className="e2e-nav">
        {((cfg.links ?? []) as { href: string; label: string }[]).map((link) => (
          <a key={link.href} href={link.href}>
            {link.label}
          </a>
        ))}
      </nav>
      <div className="e2e-right">
        {cfg.session?.state === "ready" && (cfg.can ?? []).includes("alerts.view") ? (
          <AlertsBell baseUrl={`/api/app/${cfg.session.company.id}/alerts`} />
        ) : null}
        <CompanySwitcher session={cfg.session} baseUrl={TENANCY_API} reloadHref="/dashboard" noun={NOUN} />
        <span className="e2e-avatar" aria-hidden="true">
          {String(cfg.email || "?").slice(0, 1).toUpperCase()}
        </span>
      </div>
    </header>
  );
}

/** The emitted PageHeader: a title, a line under it, and the page's own links. */
function Title(props: { title: string; children?: ReactNode }) {
  return (
    <div className="e2e-title">
      <h1>{props.title}</h1>
      {props.children}
    </div>
  );
}

/** src/components/PublicCompanyGate.tsx: the brand bar, then the page — or, suspended, the plain sentence and no widget at all. */
function PublicGate(props: { render: (company: any) => ReactNode }) {
  const company = cfg.publicCompany;
  return (
    <main className="e2e-public">
      <CompanyBrandBar company={company} />
      <div className="e2e-public-body">{company.status === "suspended" ? <CompanyUnavailable company={company} /> : props.render(company)}</div>
    </main>
  );
}

function Body(): ReactNode {
  const company = cfg.company;
  switch (cfg.mode) {
    // --- Tenancy 1's pages (overlays/companies, template) ---------------------------
    case "onboarding":
      return (
        <main>
          <Onboarding
            initialSession={cfg.session}
            purpose={cfg.another ? "additional" : "onboarding"}
            baseUrl={TENANCY_API}
            publicUrlPrefix={location.origin + "/t/"}
            afterHref="/dashboard"
            noun={NOUN}
            staffConsoleHref={cfg.staffConsoleHref}
          />
        </main>
      );
    case "dashboard":
      // app/(site)/dashboard/page.tsx: the name, the checklist, and a card per
      // link the person's role opens (the same filtered list as the header).
      return (
        <main>
          <Title title={company.name} />
          {cfg.can.includes("tenant.edit") ? null : (
            <p className="e2e-note" data-member-note="">{`You're part of ${company.name}. Your role decides what you can open here; ask the owner if something you need is missing.`}</p>
          )}
          <SetupChecklist baseUrl={TENANCY_API} tenantId={company.id} noun={NOUN} />
          <nav aria-label="Go to" className="e2e-cards">
            {(cfg.cards as { href: string; label: string }[]).map((link) => (
              <a key={link.href} href={link.href}>
                {link.label}
              </a>
            ))}
          </nav>
        </main>
      );
    case "settings":
      return (
        <main>
          <Title title="Company settings" />
          <CompanySettings baseUrl={TENANCY_API} tenantId={company.id} publicUrlPrefix={location.origin + "/t/"} noun={NOUN} />
        </main>
      );
    case "team":
      return (
        <main>
          <Title title="Team" />
          <TeamManager baseUrl={TENANCY_API} tenantId={company.id} noun={NOUN} afterLeaveHref="/dashboard" />
        </main>
      );
    case "suspended":
      return (
        <main>
          <CompanySuspended companyName={cfg.companyName} companies={cfg.companies} baseUrl={TENANCY_API} supportEmail={cfg.supportEmail} noun={NOUN} />
        </main>
      );
    case "invite":
      return (
        <main>
          <AcceptInvitation baseUrl={TENANCY_API} token={cfg.token} signedInAs={cfg.email} afterHref="/dashboard" signOutHref="/__test/sign-out" noun={NOUN} />
        </main>
      );
    case "no-access":
      // CompanyGate's refusal for a member whose role lacks the page's key.
      return (
        <main>
          <div role="status" className="e2e-notice">
            <h2>You don't have access to this page</h2>
            <p>{`Ask the owner of ${company.name} to change your role.`}</p>
          </div>
        </main>
      );
    case "admin-companies":
      return (
        <main>
          <Title title="Companies" />
          <CompaniesConsole baseUrl={TENANCY_ADMIN_API} detailHref="/admin/companies/{id}" defaultKind="org" noun={NOUN} />
        </main>
      );
    case "admin-company":
      return (
        <main>
          <CompanyDetail baseUrl={TENANCY_ADMIN_API} tenantId={cfg.tenantId} backHref="/admin/companies" noun={NOUN} />
        </main>
      );

    // --- The company area (overlays/<feature>-companies/app/(site)/app/…) -----------
    case "schedule":
      return (
        <main className="e2e-wide">
          <Title title="Schedule">
            <a href="/app/schedule/settings">Schedule settings</a>
          </Title>
          <ScheduleCalendar
            baseUrl={`/api/app/${company.id}/schedule`}
            bookingPageUrl={cfg.bookingPageUrl}
            initialDate={cfg.initialDate}
            initialVisitId={cfg.initialVisitId}
            visitFilesHref={cfg.visitFilesHref}
            canManage={cfg.can.includes("schedule.manage")}
          />
        </main>
      );
    case "today":
      return (
        <main>
          <CrewDay baseUrl={`/api/app/${company.id}/schedule`} filesHref={cfg.filesHref} />
        </main>
      );
    case "schedule-settings":
      return (
        <main>
          <Title title="Schedule settings" />
          <SchedulingSettings
            baseUrl={`/api/app/${company.id}/schedule`}
            bookingPageUrl={cfg.bookingPageUrl}
            inviteHref="/settings/team"
            canManage={cfg.can.includes("schedule.resources.manage")}
          />
        </main>
      );
    case "estimates":
      return (
        <main className="e2e-wide">
          <Title title="Estimates">
            <nav aria-label="Estimates" className="e2e-subnav">
              <a href="/app/price-book">Price book</a>
              <span aria-hidden="true">·</span>
              <a href="/app/estimates/settings">Settings</a>
            </nav>
          </Title>
          <EstimatesQueue baseUrl={`/api/app/${company.id}/estimator`} estimateHref="/app/estimates/{id}" canManage={cfg.can.includes("estimator.estimates.manage")} />
        </main>
      );
    case "estimate":
      return (
        <main className="e2e-wide">
          <EstimateEditor
            baseUrl={`/api/app/${company.id}/estimator`}
            estimateId={cfg.estimateId}
            backHref="/app/estimates"
            estimateHref="/app/estimates/{id}"
            canManage={cfg.can.includes("estimator.estimates.manage")}
          />
          <div className="e2e-gap">
            <RecordFiles
              baseUrl={`/api/app/${company.id}/files`}
              record={{ type: "estimator.estimate", id: cfg.estimateId }}
              title="Other files"
              hint="Photos of the job go in Photos above, so the estimate can read them. Your team sees these; they aren't sent to the customer."
            />
          </div>
        </main>
      );
    case "estimate-settings":
      return (
        <main>
          <Title title="Estimate settings" />
          <EstimatorSettings baseUrl={`/api/app/${company.id}/estimator`} canManage={cfg.can.includes("estimator.settings.manage")} />
          <div className="e2e-gap">
            <EmbedKeys
              baseUrl={`/api/app/${company.id}/estimator`}
              canManage={cfg.can.includes("estimator.settings.manage")}
              publicPageUrl={`${location.origin}/t/${company.slug}/estimate`}
              buttonColor={company.brandColor}
              notices={false}
            />
          </div>
        </main>
      );
    case "price-book":
      return (
        <main className="e2e-wide">
          <Title title="Price book" />
          <PriceBook baseUrl={`/api/app/${company.id}/estimator`} canManage={cfg.can.includes("estimator.pricebook.manage")} />
        </main>
      );
    case "invoices":
      return (
        <main className="e2e-wide">
          <Title title="Invoices" />
          <InvoicesLedger baseUrl={`/api/app/${company.id}/invoices`} invoiceHref="/app/invoices/{id}" canManage={cfg.can.includes("invoices.manage")} />
        </main>
      );
    case "invoice":
      return (
        <main>
          <InvoiceEditor baseUrl={`/api/app/${company.id}/invoices`} invoiceId={cfg.invoiceId} backHref="/app/invoices" />
          <div className="e2e-gap">
            <RecordFiles
              baseUrl={`/api/app/${company.id}/files`}
              record={{ type: "invoicing.invoice", id: cfg.invoiceId }}
              hint="Your team sees these; they aren't sent to the customer."
            />
          </div>
        </main>
      );
    case "messages":
      return (
        <main>
          <Title title="Messages" />
          <MessagesConsole baseUrl={`/api/app/${company.id}/messages`} canManage={cfg.can.includes("comms.manage")} />
        </main>
      );

    // --- Tenancy 2b-1: alerts and files (overlays/notifications-companies, storage-companies, storage-visits-companies) ---
    case "alerts":
      return (
        <main>
          <Title title="Alerts">
            <a href="/app/alerts/settings">Alert settings</a>
          </Title>
          <AlertsInbox baseUrl={`/api/app/${company.id}/alerts`} hideTitle />
        </main>
      );
    case "alert-settings":
      return (
        <main>
          <Title title="Alert settings">
            <a href="/app/alerts">All alerts</a>
          </Title>
          <AlertSettings baseUrl={`/api/app/${company.id}/alerts`} hideTitle />
        </main>
      );
    case "files":
      return (
        <main className="e2e-wide">
          <Title title="Files" />
          <FilesManager
            baseUrl={`/api/app/${company.id}/files`}
            platformName={cfg.platformName}
            supportEmail={cfg.supportEmail}
            logoSettings="company settings"
            title={false}
          />
        </main>
      );
    case "visit-files":
      return (
        <main>
          <RecordFiles
            baseUrl={`/api/app/${company.id}/files`}
            record={{ type: "scheduling.visit", id: cfg.visitId }}
            backHref={cfg.can.includes("schedule.view") ? `/app/schedule?visit=${encodeURIComponent(cfg.visitId)}` : "/app/schedule/today"}
          />
        </main>
      );

    // --- Each company's public pages (overlays/<feature>-companies/app/(site)/t/[slug]/…) ---
    case "public-home":
      return (
        <PublicGate
          render={(c) => (
            <nav aria-label={c.name} className="e2e-cards">
              {(cfg.publicPages as { path: string; label: string }[]).map((p) => (
                <a key={p.path} href={`${c.publicPath}${p.path}`}>
                  {p.label}
                </a>
              ))}
            </nav>
          )}
        />
      );
    case "public-estimate":
      return <PublicGate render={(c) => <EstimateTool baseUrl={`/api/t/${c.slug}/estimator`} bookHref={`${c.publicPath}/book-visit`} accentColor={c.brandColor} />} />;
    case "public-quote":
      return (
        <PublicGate render={(c) => <QuoteView baseUrl={`/api/t/${c.slug}/estimator`} token={cfg.token} bookHref={`${c.publicPath}/book-visit`} accentColor={c.brandColor} />} />
      );
    case "public-book":
      return (
        <PublicGate
          render={(c) => (
            <VisitPicker baseUrl={`/api/t/${c.slug}/schedule`} service={cfg.service ?? undefined} estimateId={cfg.estimate ?? undefined} accentColor={c.brandColor} />
          )}
        />
      );
    case "public-visit":
      return <PublicGate render={(c) => <ManageVisit baseUrl={`/api/t/${c.slug}/schedule`} token={cfg.token} bookHref={`${c.publicPath}/book-visit`} accentColor={c.brandColor} />} />;
    case "public-invoice":
      return <PublicGate render={(c) => <InvoiceView baseUrl={`/api/t/${c.slug}/invoices`} token={cfg.token} preview={cfg.preview === true} accentColor={c.brandColor} />} />;
    default:
      return (
        <main>
          <p>{cfg.text}</p>
        </main>
      );
  }
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Header />
    <Body />
  </StrictMode>,
);
