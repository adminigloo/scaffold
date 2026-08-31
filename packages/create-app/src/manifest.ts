/**
 * `adminigloo.json` — what this project is, written down by the thing that
 * built it.
 *
 * Until now the only record of a generated project's shape was the shape
 * itself: which packages are in `package.json`, which directories exist under
 * `app/`. Every tool that needed the answer re-derived it, so "does this
 * project have an admin panel?" had one implementation in the emitter, another
 * in a test, and a third in whatever script asked next — and they drifted. The
 * generated `/admin` link that 404'd in a `--admin none` project was that drift
 * reaching a customer.
 *
 * This file is the single derived answer. The matrix CI reads it to label a
 * run, a `doctor` command will read it to check the project still matches what
 * it was generated as, and the private component registry will read
 * `capabilities` to decide whether a component's requirements are met.
 *
 * PURELY DERIVED, and that is the load-bearing property rather than a
 * simplification. Every field is a function of `answers`, so the manifest can
 * be rebuilt from scratch and compared byte for byte against the copy on disk —
 * which is how drift gets detected at all. One hand-edited field anywhere in
 * here would make that comparison meaningless for the whole file. That is why
 * there is nowhere in this manifest to record a forked module: a fork is real
 * and worth recording, no tool can infer it, and it therefore belongs in
 * `SCAFFOLD.md`, which is prose and says plainly which part a human owns.
 */

import {
  capabilitiesFor,
  optionalEnvFor,
  overlayNamesFor,
  packagesFor,
  requiredEnvFor,
  type Answers,
} from "./answers.js";
import { versionRangeFor } from "./versions.js";

/** Written at the project root, beside `package.json`. */
export const MANIFEST_FILENAME = "adminigloo.json";

/**
 * Bumped only when the SHAPE changes in a way a reader cannot absorb.
 *
 * Adding a capability key is not a shape change; removing a field or changing
 * what one means is. A reader that finds a version it does not know should say
 * so and stop, rather than guessing at fields that may have moved.
 */
export const MANIFEST_VERSION = 1;

export interface ProjectManifest {
  /**
   * Addressed to whoever opens the file. JSON has no comments and this file
   * will be opened by people, not only by tools.
   */
  readonly "//": readonly string[];
  readonly manifestVersion: number;
  readonly generator: {
    readonly name: string;
    readonly version: string;
  };
  /**
   * The complete input. Feeding these back to the generator reproduces the
   * project, which is the first thing anyone wants when a generated app
   * misbehaves — and the reason the answers are stored whole rather than
   * summarised into the fields below.
   */
  readonly answers: Answers;
  /** Scoped package name -> the range this project depends on. */
  readonly packages: Readonly<Record<string, string>>;
  /** Overlay directories copied in, in the order they were applied. */
  readonly overlays: readonly string[];
  /** Stable keys naming what the project can be expected to do. */
  readonly capabilities: readonly string[];
  readonly env: {
    /** The app will not boot until every one of these is set. */
    readonly required: readonly string[];
    /** Each changes documented behaviour; none is needed to boot. */
    readonly optional: readonly string[];
  };
}

const PREAMBLE: readonly string[] = [
  "GENERATED FILE. Nobody maintains this by hand, and nobody should be asked to.",
  "Written by @adminigloo/create-app at generation time, and rewritten by its",
  "tooling — never edited in place.",
  "Every field here is derived from `answers` below, which is what makes the",
  "file useful: it can be rebuilt from those answers and compared against this",
  "copy, so drift between what the project claims and what it is becomes a",
  "thing a tool can find. A single hand-edited field would end that for the",
  "whole file.",
  "That is also why there is nowhere here to record a module you have forked",
  "from a base package. Forking is legitimate and worth writing down, but no",
  "tool can infer it — so it goes in SCAFFOLD.md, which says which part a",
  "person owns.",
];

export function buildManifest(
  answers: Answers,
  generatorVersion: string,
): ProjectManifest {
  const packages: Record<string, string> = {};
  for (const name of packagesFor(answers)) {
    packages[name] = versionRangeFor(name);
  }

  return {
    "//": PREAMBLE,
    manifestVersion: MANIFEST_VERSION,
    generator: { name: "@adminigloo/create-app", version: generatorVersion },
    answers,
    packages,
    overlays: overlayNamesFor(answers),
    capabilities: capabilitiesFor(answers),
    env: {
      required: requiredEnvFor(answers),
      optional: optionalEnvFor(answers),
    },
  };
}

export function renderManifest(manifest: ProjectManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}
