import type { z } from "zod";
import {
  describeAppEnv,
  isDeployed,
  type AppEnv,
  type AppEnvOrigin,
  type EnvSource,
} from "./app-env.js";
import { isBlank } from "./validators.js";

/**
 * One variable, described without ever naming what it holds.
 *
 * There is deliberately no `value`, no `preview`, no `error`: this report is
 * built to be rendered on a setup page, and a setup page that prints a secret
 * is worse than no setup page at all. `malformed` is a bare flag rather than a
 * Zod message for the same reason — Zod quotes the offending input in several
 * of its own messages.
 */
export interface EnvVarReport {
  readonly name: string;
  readonly present: boolean;
  /** Must this be set for THIS environment to boot? */
  readonly required: boolean;
  /** Present, but does not satisfy its schema. Absent variables are never malformed. */
  readonly malformed?: boolean;
  /**
   * The schema supplies a value when this is unset, so being absent switches
   * nothing off. Distinguishes `LOG_LEVEL`, which defaults to "info", from a
   * credential that is merely tolerated — without it the startup summary tells
   * every reader on every boot that logging is disabled.
   */
  readonly defaulted?: boolean;
}

export interface EnvGroupReport {
  readonly name: string;
  /** What stops working while anything in this group is unset. */
  readonly disables?: string;
  readonly vars: readonly EnvVarReport[];
}

export interface EnvReport {
  readonly appEnv: AppEnv;
  /**
   * Which variable decided `appEnv`, or `unidentified` if none did.
   *
   * On the page this is the difference between "this is staging" and "nothing
   * on this box says where it is, so it is being treated as staging". The
   * second sentence has an action attached to it and the first does not, and
   * without this field the page cannot tell them apart.
   */
  readonly origin: AppEnvOrigin;
  /**
   * Was this IDENTIFIED as a deployment, by the platform or by `APP_ENV`?
   *
   * This — not `appEnv !== "local"` — is what decides whether a deferred
   * credential counts as required, because it is the same predicate `defineEnv`
   * uses to decide whether the app will actually refuse to boot without it. A
   * report that answered that question differently from the validator would
   * tell somebody their deployment is fine and then fail to start.
   */
  readonly deployed: boolean;
  readonly groups: readonly EnvGroupReport[];
  /**
   * Absent variables that block boot under LOCAL strictness — that is, with
   * `optionalUntilDeployed` applied. Empty on a well-configured laptop even
   * when half the providers are unconfigured, which is the whole point.
   */
  readonly missingLocally: readonly string[];
  /**
   * Absent variables that block boot under DEPLOYED strictness, where nothing
   * is relaxed. This is the checklist to work through before shipping, and it
   * is computed the same way wherever the report runs.
   */
  readonly missingWhenDeployed: readonly string[];
  /** Does the environment as it stands satisfy the strictness of `appEnv`? */
  readonly ok: boolean;
}

/**
 * Optional provenance: which variables belong to a feature, and what goes dark
 * without them.
 *
 * Without this the only grouping available is server/client, because the app
 * flattens every package's fragment into one record before `defineEnv` sees it
 * and the provenance is gone. A setup page that can only say "3 server
 * variables missing" cannot tell the reader that checkout is off.
 */
export interface EnvFeature {
  readonly name: string;
  readonly vars: readonly string[];
  readonly disables?: string;
}

export interface DescribeEnvOptions {
  readonly server: Record<string, z.ZodType>;
  readonly client: Record<string, z.ZodType>;
  readonly runtimeEnv: Record<string, string | undefined>;
  readonly optionalUntilDeployed?: readonly string[];
  readonly features?: readonly EnvFeature[];
  readonly source?: EnvSource;
}

/**
 * Describe the environment without validating it — pure, serialisable, and it
 * never throws, so a setup page can render even while the app cannot boot.
 *
 * `ok` covers presence and schema validity only. The key-mode binding is
 * asserted by `defineEnv` on the raw values and is not represented here, so an
 * `ok: true` report can still be followed by a `KeyModeMismatchError`. Folding
 * mode into this report would mean either throwing from a function documented
 * not to throw, or publishing which mode a key carries — which is information
 * about the key's value.
 */
export function describeEnv(opts: DescribeEnvOptions): EnvReport {
  const source = opts.source ?? process.env;
  const { appEnv, origin } = describeAppEnv(source);
  const deployed = isDeployed(source);
  const relaxable = new Set(opts.optionalUntilDeployed ?? []);

  const scoped: { scope: "server" | "client"; report: EnvVarReport }[] = [];
  const seen = new Set<string>();
  const missingLocally: string[] = [];
  const missingWhenDeployed: string[] = [];
  let anyMalformed = false;

  for (const scope of ["server", "client"] as const) {
    for (const [name, schema] of Object.entries(opts[scope])) {
      // A name declared in both records is one variable. Counting it twice
      // would inflate the "n of m configured" line the summary prints.
      if (seen.has(name)) continue;
      seen.add(name);

      const raw = opts.runtimeEnv[name];
      const present = !isBlank(raw);

      // Asking the schema what it does with `undefined` is the only portable
      // way to tell required from `.optional()` from `.default()` across Zod 3
      // and 4 without reaching into internals. Only the shape of the outcome is
      // read, never the value it produced.
      const whenAbsent = schema.safeParse(undefined);
      const requiredWhenDeployed = !whenAbsent.success;
      const defaulted = whenAbsent.success && whenAbsent.data !== undefined;
      const requiredLocally = requiredWhenDeployed && !relaxable.has(name);
      // `deployed`, not `appEnv`. An unidentified host resolves to "staging" so
      // that the danger gates close, but `defineEnv` still defers its
      // credentials there — and a report that called them required would list
      // blockers for a boot that is going to succeed.
      const required = deployed ? requiredWhenDeployed : requiredLocally;

      const malformed = present && !schema.safeParse(raw).success;
      if (malformed) anyMalformed = true;
      if (!present && requiredLocally) missingLocally.push(name);
      if (!present && requiredWhenDeployed) missingWhenDeployed.push(name);

      const base = { name, present, required };
      scoped.push({
        scope,
        report: malformed
          ? { ...base, malformed: true }
          : defaulted
            ? { ...base, defaulted: true }
            : base,
      });
    }
  }

  const byName = new Map(scoped.map((entry) => [entry.report.name, entry.report]));
  const claimed = new Set<string>();
  const groups: EnvGroupReport[] = [];

  for (const feature of opts.features ?? []) {
    const vars: EnvVarReport[] = [];
    for (const name of feature.vars) {
      // The schemas are the source of truth for which variables this app has.
      // A feature naming one the app never declared belongs to a package that
      // is not installed, and inventing a row for it would tell the reader to
      // go configure something the app will never read.
      const report = byName.get(name);
      if (report === undefined || claimed.has(name)) continue;
      claimed.add(name);
      vars.push(report);
    }
    if (vars.length === 0) continue;
    groups.push(
      feature.disables === undefined
        ? { name: feature.name, vars }
        : { name: feature.name, disables: feature.disables, vars },
    );
  }

  for (const scope of ["server", "client"] as const) {
    const vars = scoped
      .filter((entry) => entry.scope === scope && !claimed.has(entry.report.name))
      .map((entry) => entry.report);
    if (vars.length > 0) groups.push({ name: scope, vars });
  }

  const ok =
    !anyMalformed &&
    (deployed ? missingWhenDeployed.length === 0 : missingLocally.length === 0);

  return {
    appEnv,
    origin,
    deployed,
    groups,
    missingLocally,
    missingWhenDeployed,
    ok,
  };
}

/**
 * A startup summary for the terminal. Plain text, no colour codes — this gets
 * piped into CI logs and Vercel build output, where escape sequences arrive as
 * literal `[32m` and make the one line you needed to read unreadable.
 */
export function formatEnvReport(report: EnvReport): string {
  const entries = report.groups.flatMap((group) =>
    group.vars.map((entry) => ({ group, entry })),
  );
  const healthy = entries.filter(
    (item) => item.entry.present && item.entry.malformed !== true,
  ).length;


  const name = (item: (typeof entries)[number]): string =>
    `  - ${item.entry.name} (${item.group.name})`;

  // What a feature switches off is only news when the app is still running
  // without it. On a row that stops the boot the reader needs the fix, not an
  // inventory of what they are missing out on.
  const nameAndEffect = (item: (typeof entries)[number]): string =>
    item.group.disables === undefined
      ? name(item)
      : `${name(item)} - ${item.group.disables}`;

  const sections: string[] = [];
  const section = (heading: string, rows: readonly string[]): void => {
    if (rows.length > 0) sections.push([heading, ...rows].join("\n"));
  };

  const blocking = entries.filter(
    (item) => !item.entry.present && item.entry.required,
  );

  section(
    "Malformed - fix these, the app will not boot:",
    entries.filter((item) => item.entry.malformed === true).map(name),
  );
  section("Missing and required here - the app will not boot:", blocking.map(name));
  section(
    "Not set - these features are off until you configure them:",
    entries
      .filter(
        (item) =>
          !item.entry.present &&
          !item.entry.required &&
          item.entry.defaulted !== true,
      )
      .map(nameAndEffect),
  );

  // Only worth printing on a laptop. On a deployment these are already in the
  // blocking list, and repeating them reads as two separate problems.
  const blockingNames = new Set(blocking.map((item) => item.entry.name));
  const beforeDeploying = report.missingWhenDeployed.filter(
    (name) => !blockingNames.has(name),
  );
  if (!report.deployed && beforeDeploying.length > 0) {
    section(
      "Required before this deploys to preview or production:",
      beforeDeploying.map((name) => `  - ${name}`),
    );
  }

  if (sections.length === 0) {
    sections.push("Everything this environment requires is set.");
  }

  // The origin is printed only when nothing named the environment, because
  // that is the only case with an action attached: everywhere else the reader
  // already knows which variable they set. Left off, an operator reading
  // "Environment: staging" on their production box has no way to learn that
  // the word was a guess rather than a reading.
  const where =
    report.origin === "unidentified"
      ? `${report.appEnv} (nothing on this host names the environment - set ` +
        `APP_ENV to local, staging or production; being unnamed is why the ` +
        `simulated checkout and the automatic first-admin grant are off)`
      : report.appEnv;

  return [
    `Environment: ${where} - ${healthy} of ${entries.length} variables set.`,
    "",
    sections.join("\n\n"),
  ].join("\n");
}
