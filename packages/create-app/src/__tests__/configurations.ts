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
                  includeMarketing,
                },
              };
            }),
          ),
        ),
      ),
    ),
);
