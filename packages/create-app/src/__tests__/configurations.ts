/**
 * EVERY CONFIGURATION THIS GENERATOR CAN BE ASKED FOR, computed rather than
 * listed.
 *
 * A sweep over "every configuration" is only worth the runtime if "every" is
 * derived from the option sets the CLI validates against. Written out by hand
 * beside them it is one value short the day somebody adds a fifth business
 * model, and nothing says so — the sweep goes on passing, over a space that no
 * longer matches the product. `answers.ts` owns the tuples; this is the
 * cartesian product of them and nothing else.
 *
 * The count is deliberately not asserted anywhere: a test that pinned it to 240
 * would fail on the day a new option is added, for a reason that has nothing to
 * do with anything being wrong.
 */

import { join } from "node:path";
import {
  ADMIN_SHELLS,
  BUSINESS_MODELS,
  DEFAULT_ANSWERS,
  TENANT_NOUNS,
  type Answers,
} from "../answers.js";

/** `template/`, from which `planEmit` reads the base and the overlays. */
export const TEMPLATE_DIR = join(__dirname, "..", "..", "template");

export interface Configuration {
  /** The flags that produce it, as somebody would type them. */
  readonly label: string;
  readonly flags: readonly string[];
  readonly answers: Answers;
}

const BOTH = [true, false] as const;

export const EVERY_CONFIGURATION: readonly Configuration[] = TENANT_NOUNS.flatMap(
  (tenantNoun) =>
    BUSINESS_MODELS.flatMap((businessModel) =>
      ADMIN_SHELLS.flatMap((adminShell) =>
        BOTH.flatMap((includeAi) =>
          BOTH.flatMap((includeEmail) =>
            // Feedback is an axis for the same reason marketing is, plus one
            // of its own: it is the first answer that changes a GENERATED base
            // file (`app/layout.tsx` gains the widget mount), and it selects
            // one overlay or two depending on the admin shell — a coupling
            // only a full product can exercise in every pairing.
            BOTH.flatMap((includeFeedback) =>
              // The three newest suite features share ONE axis, deliberately.
              // Each is independent of the others — no emitted line reads two
              // of the three answers together — and their only structural
              // coupling is with the admin shell, which toggling all three at
              // once still exercises in every shell pairing. Three private
              // axes would multiply this product by eight for combinations no
              // code path can distinguish; per-flag behaviour (parsing,
              // packages, overlays, capabilities) is pinned one flag at a
              // time in cli.test.ts instead.
              BOTH.flatMap((includeSuite) =>
                // The public face is its own axis, so it is swept like the others.
                // It has to be: `--marketing` moves `app/(site)/page.tsx` from a
                // generated file to an overlay one and adds three routes and two
                // generated modules, which is a bigger structural difference than
                // `--email` makes — and a dimension left out of this product is a
                // dimension the exhaustive sweep is not exhaustive over.
                BOTH.map((includeMarketing): Configuration => {
                  const flags = [
                    "--tenant-noun",
                    tenantNoun,
                    "--model",
                    businessModel,
                    "--admin",
                    adminShell,
                    includeAi ? "--ai" : "--no-ai",
                    includeEmail ? "--email" : "--no-email",
                    includeFeedback ? "--feedback" : "--no-feedback",
                    includeSuite ? "--seo-reports" : "--no-seo-reports",
                    includeSuite ? "--notifications" : "--no-notifications",
                    includeSuite ? "--storage" : "--no-storage",
                    includeSuite ? "--assistant" : "--no-assistant",
                    // The five field-service features ride the same axis, for the
                    // reason the suite trio does: each is independent of the
                    // others, coupled only to the admin shell, so toggling them
                    // together still exercises every shell pairing without an
                    // axis apiece (which would multiply this product by 32).
                    // The estimator and scheduling need an admin panel:
                    // `--estimator --admin none` and `--scheduling --admin
                    // none` are refused (assertAnswersCompatible), so neither
                    // is a configuration — the suite axis drops them there.
                    includeSuite && adminShell !== "none" ? "--estimator" : "--no-estimator",
                    includeSuite && adminShell !== "none" ? "--scheduling" : "--no-scheduling",
                    includeSuite ? "--invoicing" : "--no-invoicing",
                    includeSuite ? "--comms" : "--no-comms",
                    includeSuite ? "--aeo" : "--no-aeo",
                    // Tenancy 2b-4a: website visits and search basics, on the suite axis too.
                    includeSuite ? "--analytics" : "--no-analytics",
                    includeSuite ? "--seo" : "--no-seo",
                    // Tenancy 2b-4c: book a call, on the suite axis too. A single
                    // business works its calls under /admin, so `--booking
                    // --tenant-noun none --admin none` is refused and dropped here.
                    includeSuite && !(tenantNoun === "none" && adminShell === "none") ? "--booking" : "--no-booking",
                    // Getting paid, part 2: the store, on the suite axis too, with
                    // the same single-business admin rule as booking.
                    includeSuite && !(tenantNoun === "none" && adminShell === "none") ? "--store" : "--no-store",
                    includeMarketing ? "--marketing" : "--no-marketing",
                  ];
                  return {
                    label: flags.join(" "),
                    flags,
                    answers: {
                      ...DEFAULT_ANSWERS,
                      projectName: "acme",
                      tenantNoun,
                      businessModel,
                      adminShell,
                      includeAi,
                      includeEmail,
                      includeFeedback,
                      includeSeoReports: includeSuite,
                      includeNotifications: includeSuite,
                      includeStorage: includeSuite,
                      includeAssistant: includeSuite,
                      includeEstimator: includeSuite && adminShell !== "none",
                      includeScheduling: includeSuite && adminShell !== "none",
                      includeInvoicing: includeSuite,
                      includeComms: includeSuite,
                      includeAeo: includeSuite,
                      includeAnalytics: includeSuite,
                      includeSeo: includeSuite,
                      includeBooking: includeSuite && !(tenantNoun === "none" && adminShell === "none"),
                      includeStore: includeSuite && !(tenantNoun === "none" && adminShell === "none"),
                      includeMarketing,
                    },
                  };
                }),
              ),
            ),
          ),
        ),
      ),
    ),
);

/**
 * TENANCY 2b-1's configurations (contract 13.11, 15.5), named: the founder's
 * companies project and a single business with every feature and alerts and
 * files, each of alerts and files alone in a companies project, the field
 * features without files (the slots' "nothing" variants), and a single
 * business with no admin shell (the bell only). The cartesian product above
 * covers them too; these are the ones the 2b-1 checks read by name.
 */
const EVERY_FIELD_FEATURE: Partial<Answers> = {
  includeEstimator: true,
  includeScheduling: true,
  includeInvoicing: true,
  includeComms: true,
  includeEmail: true,
};
const NO_FIELD_FEATURE: Partial<Answers> = {
  includeEstimator: false,
  includeScheduling: false,
  includeInvoicing: false,
  includeComms: false,
};

export const TENANCY_2B1_CONFIGURATIONS = {
  /** `--tenant-noun Company --admin full` with every feature, `--notifications --storage --ai`. */
  companyAll: { tenantNoun: "Company", adminShell: "full", ...EVERY_FIELD_FEATURE, includeStorage: true, includeNotifications: true, includeAi: true },
  /** `--tenant-noun none --admin minimal` with the same. */
  singleAll: { tenantNoun: "none", adminShell: "minimal", ...EVERY_FIELD_FEATURE, includeStorage: true, includeNotifications: true },
  /** Alerts alone in a companies project. */
  companyAlertsAlone: { tenantNoun: "Company", adminShell: "full", ...NO_FIELD_FEATURE, includeEmail: true, includeNotifications: true, includeStorage: false },
  /** Files alone in a companies project. */
  companyFilesAlone: { tenantNoun: "Company", adminShell: "full", ...NO_FIELD_FEATURE, includeNotifications: false, includeStorage: true },
  /** Every field feature and alerts, no files: the record slots' empty variant. */
  companyFieldNoFiles: { tenantNoun: "Company", adminShell: "full", ...EVERY_FIELD_FEATURE, includeNotifications: true, includeStorage: false },
  /** Every field feature, neither alerts nor files: 2a's project, unchanged. */
  companyFieldOnly: { tenantNoun: "Company", adminShell: "full", ...EVERY_FIELD_FEATURE, includeNotifications: false, includeStorage: false },
  /** A single business with no admin shell (invoicing and messages need none): the bell, no alert settings. */
  singleNoShell: { tenantNoun: "none", adminShell: "none", ...NO_FIELD_FEATURE, includeInvoicing: true, includeComms: true, includeEmail: true, includeNotifications: true, includeStorage: true },
} as const satisfies Record<string, Partial<Answers>>;
