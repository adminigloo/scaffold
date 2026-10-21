import { companySettings, defineTenantSettings } from "../settings.js";
import { defineSetupChecklist } from "../checklist.js";
import { tenancyMembershipGate } from "./gate.js";
import { createCtx, holdsPermission } from "./context.js";
import { readCompany } from "./db.js";
import { tenancyChecklistItems, changeChecklist, getChecklist } from "./checklist-service.js";
import { checkSlug, createCompany } from "./companies.js";
import {
  acceptInvitation,
  joinInvitation,
  listInvitations,
  previewInvitation,
  resendInvitation,
  revokeInvitation,
  sendInvitation,
  settleInvitationEmail,
} from "./invitations-lifecycle.js";
import {
  assignOwner,
  deleteCompany,
  getCompanyDetail,
  listCompanies,
  listPeople,
  listStaffRoles,
  reactivateCompany,
  releaseRetiredAddresses,
  resolveCompanyBySlug,
  resolvePublicCompany,
  setStaffRole,
  suspendCompany,
} from "./operator.js";
import { rememberCtx } from "./internals.js";
import { getCompany, removeLogo, setLogo, updateBranding, updateCompanyProfile } from "./profile.js";
import { activeCompanyIds, companyProfile, listMemberPeople } from "./profile-read.js";
import {
  deprovisionUser,
  ensureBootstrapAdmin,
  ensureBootstrapAdminForEmail,
  provisionUser,
} from "./provisioning.js";
import { invitationsForMe, resolveSession, setActiveCompany } from "./session.js";
import { getSettings, readSettings, updateSettings } from "./settings-service.js";
import { changeMemberRole, getTeam, leaveCompany, removeMember, transferOwnership } from "./team.js";
import { companyView } from "./views.js";
import type { CreateTenancyServiceOptions, TenancyService } from "./types.js";

/**
 * The company lifecycle, built once per project (create-app's
 * `src/server/tenancy.ts` is the one construction site).
 *
 * Construction FAILS FAST on a bad option — a missing db, an unknown mode, a
 * settings registry with no `company` fragment (the checklist and the
 * operator detail read its time zone and contact fields) — because each of
 * those would otherwise surface as a confusing 500 on some later request.
 *
 * Every method authorises itself (D7): it re-resolves the caller's membership
 * and permissions on its own transaction, under the company lock. The HTTP
 * handlers never pre-check a permission, so a host calling the service
 * directly (a server action, a script) gets the same rules.
 */
export function createTenancyService(options: CreateTenancyServiceOptions): TenancyService {
  if (!options || !options.db) throw new TypeError("createTenancyService needs a database handle (`db`).");
  if (options.mode !== "companies" && options.mode !== "personal") {
    throw new TypeError(`createTenancyService: mode must be "companies" or "personal" (got ${JSON.stringify(options.mode)}).`);
  }
  if (!options.tenantCatalog || options.tenantCatalog.scope !== "tenant") {
    throw new TypeError("createTenancyService needs the project's TENANT permission catalog (`tenantCatalog`).");
  }
  const settings = options.settings ?? defineTenantSettings([companySettings]);
  if (!settings.get("company")) {
    throw new TypeError(
      "createTenancyService: the settings registry has no `company` fragment. Include tenancy's `companySettings` " +
        "(defineTenantSettings([companySettings, ...yours])): the checklist and the operator console read it.",
    );
  }
  const noun = options.noun ?? { singular: "company", plural: "companies" };
  const ctx = createCtx({
    db: options.db,
    mode: options.mode,
    noun,
    tenantCatalog: options.tenantCatalog,
    bootstrap: options.bootstrap,
    settings,
    checklist: options.checklist ?? defineSetupChecklist(tenancyChecklistItems({})),
    ...(options.roles ? { roles: options.roles } : {}),
    ...(options.seats ? { seats: options.seats } : {}),
    ...(options.logos ? { logos: options.logos } : {}),
    ...(options.deletion ? { deletion: options.deletion } : {}),
    ...(options.reservedSlugs ? { reservedSlugs: options.reservedSlugs } : {}),
    ...(options.invitations ? { invitations: options.invitations } : {}),
    ...(options.companiesPerAccount !== undefined ? { companiesPerAccount: options.companiesPerAccount } : {}),
    ...(options.audit ? { audit: options.audit } : {}),
    ...(options.onEvent ? { onEvent: options.onEvent } : {}),
    ...(options.onEventError ? { onEventError: options.onEventError } : {}),
    ...(options.now ? { now: options.now } : {}),
  });

  const service: TenancyService = {
    mode: options.mode,
    noun,
    settings,
    roles: ctx.roles,

    provisionUser: (input) => provisionUser(ctx, input),
    deprovisionUser: (input) => deprovisionUser(ctx, input),
    ensureBootstrapAdmin: (input) => ensureBootstrapAdmin(ctx, input),
    ensureBootstrapAdminFor: (input) => ensureBootstrapAdminForEmail(ctx.db, { email: input.email, audit: (tx, e) => ctx.audit(tx, e) }),

    resolveSession: (input) => resolveSession(ctx, input),
    // CONTRACT: 7.1 lists `active-set` as unavailable in personal mode, but
    // 8.4 (and D6) show the switcher to someone in two personal workspaces,
    // and choosing one IS `setActive`. Switching stays available in both
    // modes; only creating and joining companies are company-mode only.
    setActiveCompany: (input) => setActiveCompany(ctx, input),
    membership: (input) => tenancyMembershipGate(ctx.db, input),
    hasPermission: (input) => holdsPermission(ctx.db, input),

    checkSlug: (input) => checkSlug(ctx, input),
    createCompany: (input) => createCompany(ctx, input),

    getCompany: (input) => getCompany(ctx, input),
    updateCompanyProfile: (input) => updateCompanyProfile(ctx, input),
    updateBranding: (input) => updateBranding(ctx, input),
    setLogo: (input) => setLogo(ctx, input),
    removeLogo: (input) => removeLogo(ctx, input),

    getSettings: (input) => getSettings(ctx, input),
    updateSettings: (input) => updateSettings(ctx, input),
    readSettings: (tenantId) => readSettings(ctx, tenantId),

    getChecklist: (input) => getChecklist(ctx, input),
    dismissChecklistItem: (input) => changeChecklist(ctx, input, { op: "dismiss", key: input.key }),
    restoreChecklistItem: (input) => changeChecklist(ctx, input, { op: "restore", key: input.key }),
    hideChecklist: (input) => changeChecklist(ctx, input, { op: "hide" }),
    showChecklist: (input) => changeChecklist(ctx, input, { op: "show" }),

    getTeam: (input) => getTeam(ctx, input),
    changeMemberRole: (input) => changeMemberRole(ctx, input),
    removeMember: (input) => removeMember(ctx, input),
    leaveCompany: (input) => leaveCompany(ctx, input),
    transferOwnership: (input) => transferOwnership(ctx, input),

    listInvitations: (input) => listInvitations(ctx, input),
    sendInvitation: (input) => sendInvitation(ctx, input),
    resendInvitation: (input) => resendInvitation(ctx, input),
    settleInvitationEmail: (input) => settleInvitationEmail(ctx, input),
    revokeInvitation: (input) => revokeInvitation(ctx, input),
    acceptInvitation: (input) => acceptInvitation(ctx, input),
    joinInvitation: (input) => joinInvitation(ctx, input),
    invitationsForMe: (input) => invitationsForMe(ctx, input),
    previewInvitation: (input) => previewInvitation(ctx, input),

    listCompanies: (input) => listCompanies(ctx, input),
    getCompanyDetail: (input) => getCompanyDetail(ctx, input),
    suspendCompany: (input) => suspendCompany(ctx, input),
    reactivateCompany: (input) => reactivateCompany(ctx, input),
    assignOwner: (input) => assignOwner(ctx, input),
    releaseRetiredAddresses: (input) => releaseRetiredAddresses(ctx, input),
    deleteCompany: (input) => deleteCompany(ctx, input),
    listPeople: (input) => listPeople(ctx, input),
    listStaffRoles: (input) => listStaffRoles(ctx, input),
    setStaffRole: (input) => setStaffRole(ctx, input),

    resolveCompanyBySlug: (slug) => resolveCompanyBySlug(ctx, slug),
    async companyFor(tenantId) {
      const row = await readCompany(ctx.db, tenantId);
      return row && row.deletedAt === null ? companyView(row, null) : null;
    },

    // Tenancy 2a: the feature packages' reads (no permission check; see profile-read.ts).
    resolvePublicCompany: (slug) => resolvePublicCompany(ctx, slug),
    companyProfile: (tenantId) => companyProfile(ctx, tenantId),
    listMemberPeople: (tenantId, options) => listMemberPeople(ctx, tenantId, options ?? {}),
    activeCompanyIds: () => activeCompanyIds(ctx),

    // Tenancy 2b-1 (8.1): the handlers wait for the listeners before answering.
    settleEvents: (timeoutMs) => ctx.settle(timeoutMs),
  };
  rememberCtx(service, ctx);
  return service;
}
