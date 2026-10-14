import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as admin from "../admin/index.js";
import * as root from "../index.js";

const here = dirname(fileURLToPath(import.meta.url));
const source = (file: string) => readFileSync(resolve(here, file), "utf8");
/** Every type the wire region declares (contract 7.3, plus TenancyErrorCode). */
const wireTypes = [...source("../types.ts").matchAll(/^export (?:type|interface) (\w+)/gm)].map((m) => m[1]!);
const OPERATOR_TYPES = new Set([
  "PersonRefWire", "AdminCompanyRowWire", "AdminCompanyListWire", "AdminMemberWire", "AuditLineWire",
  "AdminCompanyDetailWire", "SuspendBody", "StaffRoleWire", "AdminPersonWire", "AdminPeopleWire", "StaffRoleBody",
]);

/**
 * Both entries speak wire version v1 (every route is `{base}/v1/...`), and
 * export exactly what the contract (8.14) promises a buyer. The operator
 * console lives ONLY under ./admin, so a customer's bundle never ships it.
 */
describe("tenancy-widget entries", () => {
  it("speak wire version v1 from both entries", () => {
    expect(root.TENANCY_WIRE_VERSION).toBe("v1");
    expect(admin.TENANCY_WIRE_VERSION).toBe(root.TENANCY_WIRE_VERSION);
  });

  it("the company entry exports the seven screens, the transport, the styles and the pure helpers", () => {
    for (const name of [
      "Onboarding",
      "CompanySwitcher",
      "SetupChecklist",
      "TeamManager",
      "CompanySettings",
      "CompanySuspended",
      "AcceptInvitation",
      "CompanyBrandBar",
      "CompanyUnavailable",
      "roleKeyOrNull",
      "createTenancyClient",
      "injectTenancyStyles",
      "tenancyWidgetCss",
      "suggestSlug",
      "validateSlug",
      "brandColorReport",
      "contrastRatio",
      "normaliseHexColor",
      "US_TIME_ZONES",
      "nounTitle",
    ]) {
      expect(root, name).toHaveProperty(name);
    }
  });

  it("the admin entry exports the console, its transport and its styles, and none of the company screens", () => {
    for (const name of ["CompaniesConsole", "CompanyDetail", "StaffPeople", "createTenancyAdminClient", "injectTenancyAdminStyles", "tenancyAdminCss"]) {
      expect(admin, name).toHaveProperty(name);
    }
    for (const name of ["Onboarding", "TeamManager", "CompanySettings"]) expect(admin, name).not.toHaveProperty(name);
    for (const name of ["CompaniesConsole", "CompanyDetail", "StaffPeople"]) expect(root, name).not.toHaveProperty(name);
  });

  it("every wire type is exported from the company entry, and the operator ones from ./admin too", () => {
    expect(wireTypes.length).toBeGreaterThan(45);
    const rootSource = source("../index.ts");
    const adminSource = source("../admin/index.ts");
    for (const name of wireTypes) expect(rootSource, name).toMatch(new RegExp(`\\b${name},`));
    for (const name of OPERATOR_TYPES) {
      expect(wireTypes).toContain(name);
      expect(adminSource, name).toMatch(new RegExp(`\\b${name},`));
    }
  });
});
