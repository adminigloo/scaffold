import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { argv, cwd, exit, stderr, stdout } from "node:process";
import { collectAnswers, HELP, nextSteps, parseArgs, targetDirFor } from "./cli.js";
import { createPrompter } from "./prompt.js";
import { assertTargetUsable, planEmit, writePlan } from "./emit.js";
import {
  ADDABLE_FEATURES,
  addNextSteps,
  applyAdd,
  planAdd,
  UnknownFeatureError,
  type FeatureName,
} from "./add.js";

export {
  parseArgs,
  collectAnswers,
  nextSteps,
  targetDirFor,
  HELP,
  UnknownFlagValueError,
} from "./cli.js";
export type { CliFlags } from "./cli.js";
export {
  planEmit,
  writePlan,
  renderTokens,
  renderPackageJson,
  renderEnvExample,
  renderEnvLocal,
  versionRangeFor,
  packageVersions,
  UnknownPackageVersionError,
  renderScaffoldRecord,
  renderEnvModule,
  renderSchemaModule,
  renderPermissionsCatalog,
  PACKAGE_PERMISSION_FRAGMENTS,
  assertPermissionScopes,
  PermissionScopeMismatchError,
  renderAppRouter,
  renderRootLayout,
  renderAuditRegistry,
  renderInvitationMail,
  renderSiteNav,
  renderAdminNav,
  renderAdminDashboard,
  renderHomePage,
  renderPlanCatalog,
  renderSeoModule,
  renderRobots,
  renderSitemap,
  renderLegalRecord,
  targetNameFor,
  assertTargetUsable,
  TargetNotEmptyError,
  OverlayCollisionError,
  OverlayMissingError,
  GeneratorVersionUnreadableError,
} from "./emit.js";
export type {
  EmitPlan,
  PackagePermissionFragment,
  PermissionScope,
} from "./emit.js";
export {
  buildManifest,
  renderManifest,
  MANIFEST_FILENAME,
  MANIFEST_VERSION,
} from "./manifest.js";
export type { ProjectManifest } from "./manifest.js";
export {
  CAPABILITY_EVIDENCE,
  UNDISTINGUISHED_CAPABILITIES,
  assertCapabilitiesAreProvable,
  UnprovableCapabilityError,
} from "./capabilities.js";
export type { CapabilityEvidence } from "./capabilities.js";
export {
  authScopedLayouts,
  assertNoPrerenderedAuthRoutes,
  PrerenderedAuthRouteError,
} from "./prerender.js";
export type { AuthScopedLayout } from "./prerender.js";
export {
  DEFAULT_ANSWERS,
  packagesFor,
  overlayNamesFor,
  capabilitiesFor,
  requiredEnvFor,
  optionalEnvFor,
  tenantLabel,
  tenantLabelPlural,
  isPersonalWorkspaceOnly,
  validateProjectName,
  InvalidProjectNameError,
} from "./answers.js";
export type { Answers, AdminShell, BusinessModel, TenantNoun } from "./answers.js";
export { createPrompter, defaultsOnlyPrompter, interactivePrompter } from "./prompt.js";
export type { Prompter, Choice } from "./prompt.js";
export {
  ADDABLE_FEATURES,
  planAdd,
  applyAdd,
  addNextSteps,
  readProjectManifest,
  UnknownFeatureError,
  ManifestUnreadableError,
  FeatureAlreadyPresentError,
} from "./add.js";
export type { AddPlan, FeatureName } from "./add.js";

const ADD_HELP = `
create-adminigloo-app add <feature> — turn a feature on in an existing project.

  pnpm dlx @adminigloo/create-app add <feature> [--dir <path>]

  Run from a generated project's root, or point --dir at one. Reads the
  project's adminigloo.json, wires the feature in exactly as generating with it
  would have — its router, its schema, its admin page, its env — and never
  overwrites a file you have edited (those land as <file>.new to merge).

  <feature>     ${ADDABLE_FEATURES.join(" | ")}
  --dir <path>  The project to add to. Defaults to the current directory.
  --help, -h    Show this.
`.trimStart();

/** `add` reads only a feature name and --dir; it shares none of generate's flags. */
async function addMain(rawArgs: readonly string[]): Promise<number> {
  let feature: string | undefined;
  let dir: string | undefined;
  for (let i = 0; i < rawArgs.length; i += 1) {
    const arg = rawArgs[i];
    if (arg === undefined) continue;
    if (arg === "--help" || arg === "-h") {
      stdout.write(ADD_HELP);
      return 0;
    }
    if (arg === "--dir" || arg.startsWith("--dir=")) {
      dir = arg === "--dir" ? rawArgs[i + 1] : arg.slice("--dir=".length);
      if (arg === "--dir") i += 1;
    } else if (arg === "--yes" || arg === "-y") {
      // Accepted for symmetry with generate; `add` never prompts.
    } else if (!arg.startsWith("-")) {
      feature ??= arg;
    }
  }

  if (feature === undefined) {
    stderr.write(`\n${new UnknownFeatureError("(none given)").message}\n`);
    return 1;
  }

  try {
    const projectDir = resolve(cwd(), dir ?? ".");
    const plan = await planAdd(templateDir(), projectDir, feature as FeatureName);
    await applyAdd(plan);
    stdout.write(addNextSteps(plan));
    return 0;
  } catch (error) {
    stderr.write(`\n${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

/** `template/` sits beside `dist/` in the published tarball. */
function templateDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "template");
}

export async function main(rawArgs: readonly string[] = argv.slice(2)): Promise<number> {
  // `add` is a subcommand, not a project name. Dispatched before parseArgs so
  // its own small flag surface (a feature and --dir) never collides with
  // generate's.
  if (rawArgs[0] === "add") {
    return addMain(rawArgs.slice(1));
  }

  const flags = parseArgs(rawArgs);

  if (flags.help) {
    stdout.write(HELP);
    return 0;
  }

  const prompter = createPrompter(!flags.yes);
  try {
    const answers = await collectAnswers(flags, prompter);
    const targetDir = targetDirFor(flags, answers, cwd());

    // Check before planning, and plan fully before writing anything. A failure
    // halfway through leaves an empty directory rather than a half-generated
    // project that looks complete enough to start editing.
    await assertTargetUsable(targetDir);
    const plan = await planEmit(templateDir(), targetDir, answers);
    await writePlan(plan);

    stdout.write(nextSteps(answers, targetDir));
    return 0;
  } catch (error) {
    stderr.write(`\n${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  } finally {
    prompter.close();
  }
}

// Run only when invoked as the binary, so the module stays importable by tests.
if (process.env["ADMINIGLOO_CREATE_APP_NO_AUTORUN"] !== "1") {
  const invokedPath = argv[1];
  const selfPath = fileURLToPath(import.meta.url);
  if (invokedPath && (invokedPath === selfPath || invokedPath.endsWith("index.js"))) {
    void main().then((code) => {
      if (code !== 0) exit(code);
    });
  }
}
