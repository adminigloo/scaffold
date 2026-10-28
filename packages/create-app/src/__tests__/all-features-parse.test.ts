import { describe, expect, it } from "vitest";
import ts from "typescript";
import { DEFAULT_ANSWERS, type Answers } from "../answers.js";
import { planEmit } from "../emit.js";
import { TEMPLATE_DIR } from "./configurations.js";

/**
 * EVERY FEATURE AT ONCE, READ AS TYPESCRIPT. Each chunk proved its own
 * features in a generated project, a few at a time; the first project made
 * with all of them (Igloo Back Office) didn't compile, because two features'
 * blocks of the emitted proof helper each declared `const rule` in the same
 * function. Typechecking a generated project is the integration check's job
 * and takes minutes; this catches the cheap half here, on every `pnpm test`:
 * every emitted .ts/.tsx file of the all-features projects must parse, and
 * must not declare the same name twice in one scope.
 *
 * Imports are not resolved (that's the integration check), so only syntax
 * errors and duplicate declarations are read from the checker.
 */

const EVERYTHING: Partial<Answers> = {
  adminShell: "full",
  includeAi: true,
  includeEmail: true,
  includeFeedback: true,
  includeSeoReports: true,
  includeNotifications: true,
  includeStorage: true,
  includeAssistant: true,
  includeMarketing: true,
  includeEstimator: true,
  includeScheduling: true,
  includeInvoicing: true,
  includeComms: true,
  includeBooking: true,
  includeStore: true,
  includeCustomers: true,
  includeSocial: true,
  includeAeo: true,
  includeAnalytics: true,
  includeSeo: true,
};

/** Cannot redeclare block-scoped variable; Duplicate identifier; Duplicate function implementation. */
const DUPLICATES = new Set([2451, 2300, 2393]);

async function problems(overrides: Partial<Answers>): Promise<string[]> {
  const answers: Answers = { ...DEFAULT_ANSWERS, projectName: "igloo-back-office", ...EVERYTHING, ...overrides };
  const plan = await planEmit(TEMPLATE_DIR, "/out", answers);
  const sources = new Map<string, string>();
  for (const [path, contents] of plan.files) {
    if (/\.tsx?$/.test(path)) sources.set(path.replace(/\\/g, "/"), contents);
  }
  const options: ts.CompilerOptions = {
    noResolve: true,
    noLib: true,
    types: [],
    jsx: ts.JsxEmit.Preserve,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
  };
  const host = ts.createCompilerHost(options);
  host.getSourceFile = (name, version) => {
    const text = sources.get(name);
    return text === undefined ? undefined : ts.createSourceFile(name, text, version, true);
  };
  host.fileExists = (name) => sources.has(name);
  host.readFile = (name) => sources.get(name);
  const program = ts.createProgram([...sources.keys()], options, host);
  const found: string[] = [];
  for (const file of program.getSourceFiles()) {
    const diagnostics = [
      ...program.getSyntacticDiagnostics(file),
      ...program.getSemanticDiagnostics(file).filter((d) => DUPLICATES.has(d.code)),
    ];
    for (const d of diagnostics) {
      const line = d.start === undefined ? 0 : file.getLineAndCharacterOfPosition(d.start).line + 1;
      found.push(`${file.fileName}:${line} TS${d.code} ${ts.flattenDiagnosticMessageText(d.messageText, " ")}`);
    }
  }
  return found;
}

describe("every feature at once", () => {
  it("a companies project that sells plans: every emitted TypeScript file parses, with no name declared twice", async () => {
    expect(await problems({ tenantNoun: "Company", businessModel: "subscription" })).toEqual([]);
  }, 120_000);

  it("one business: the same", async () => {
    expect(await problems({ tenantNoun: "none", businessModel: "one-time" })).toEqual([]);
  }, 120_000);

  it("a project whose customers are people, selling them plans (billing 0.5): the same", async () => {
    expect(await problems({ tenantNoun: "none", audience: "consumers", businessModel: "subscription" })).toEqual([]);
  }, 120_000);
});
