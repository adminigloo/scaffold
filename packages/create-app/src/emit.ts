import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import {
  isPersonalWorkspaceOnly,
  optionalEnvFor,
  overlayNamesFor,
  packagesFor,
  requiredEnvFor,
  tenantLabel,
  tenantLabelPlural,
  type Answers,
} from "./answers.js";
import {
  buildManifest,
  MANIFEST_FILENAME,
  renderManifest,
  type ProjectManifest,
} from "./manifest.js";
import { versionRangeFor } from "./versions.js";
import { assertCapabilitiesAreProvable } from "./capabilities.js";

export interface EmitPlan {
  readonly targetDir: string;
  /** Relative path -> file contents. Everything the generator will write. */
  readonly files: ReadonlyMap<string, string>;
}

export class TargetNotEmptyError extends Error {
  readonly name = "TargetNotEmptyError";
  constructor(dir: string, offenders: readonly string[]) {
    super(
      `${dir} already contains ${offenders.join(", ")}. Generating here would ` +
        `overwrite work. Pick an empty directory, or delete those first.`,
    );
  }
}

/**
 * Files that may exist in the target without blocking generation.
 *
 * Running `git init` before generating is a normal thing to do, and so is a
 * README written while deciding on a name. Refusing those would push people
 * toward a --force flag, which is how the check stops meaning anything.
 */
const HARMLESS = new Set([".git", ".gitkeep", "README.md", ".DS_Store"]);

export async function assertTargetUsable(targetDir: string): Promise<void> {
  if (!existsSync(targetDir)) return;
  const entries = await readdir(targetDir);
  const offenders = entries.filter((e) => !HARMLESS.has(e));
  if (offenders.length > 0) throw new TargetNotEmptyError(targetDir, offenders);
}

/**
 * Token substitution over template files.
 *
 * Deliberately not a templating language. Every token is a value the CLI asked
 * for, and a template that can branch is a template that will grow branches —
 * the thing the additive-packages design exists to avoid.
 */
export function renderTokens(source: string, answers: Answers): string {
  const tokens: Record<string, string> = {
    __PROJECT_NAME__: answers.projectName,
    __SCOPE__: answers.scope,
    __SCOPE_NAME__: answers.scope.replace(/^@/, ""),
    __TENANT_LABEL__: tenantLabel(answers),
    __TENANT_LABEL_LOWER__: tenantLabel(answers).toLowerCase(),
    // From the lookup in answers.ts, never `${label}s`. "Companys" was on
    // screen in the admin sidebar, in the /admin/tenants heading and in its
    // empty state, because a suffix is not a pluralisation rule.
    __TENANT_LABEL_PLURAL__: tenantLabelPlural(answers),
    // The lowercase form exists because template copy needs it mid-sentence
    // and the only way to write it before was `__TENANT_LABEL_LOWER__s`, which
    // is the same broken suffix spelled in a template file where no test could
    // see it. It produced "No companys yet".
    __TENANT_LABEL_PLURAL_LOWER__: tenantLabelPlural(answers).toLowerCase(),
  };
  let out = source;
  for (const [token, value] of Object.entries(tokens)) {
    out = out.split(token).join(value);
  }
  return out;
}

/**
 * npm strips a literal `.gitignore` from a published tarball, and has done
 * forever. Template files that must land as dotfiles ship with a leading
 * underscore and are renamed on the way out — the alternative is a generated
 * project with no ignore file, which nobody notices until node_modules is
 * committed.
 *
 * AN ALLOWLIST, not a rule about leading underscores. Renaming every leading
 * underscore turned `src/server/routers/_app.ts` into `.app.ts` — a hidden file
 * that the app then failed to import, and that nobody would think to look for.
 * A missing entry here leaves a file named `_foo`, which is visible and
 * obviously wrong; the general rule failed silently in the other direction.
 */
const DOTFILE_TEMPLATES = new Set([
  "_gitignore",
  "_gitattributes",
  "_npmrc",
  "_github",
  "_vscode",
  "_editorconfig",
  "_nvmrc",
]);

export function targetNameFor(templateRelativePath: string): string {
  return templateRelativePath
    .split(sep)
    .map((segment) =>
      DOTFILE_TEMPLATES.has(segment) ? `.${segment.slice(1)}` : segment,
    )
    .join(sep);
}

export class OverlayCollisionError extends Error {
  readonly name = "OverlayCollisionError";
  constructor(path: string) {
    super(
      `An overlay tried to overwrite ${path}, which the base template owns. ` +
        `Overlays must be purely additive — silently replacing a base file is ` +
        `how two templates drift apart without anyone noticing.`,
    );
  }
}

export class OverlayMissingError extends Error {
  readonly name = "OverlayMissingError";
  constructor(name: string, dir: string) {
    super(
      `The answers selected the ${name} overlay and ${dir} is not there. ` +
        `This is a broken install of the generator rather than a bad answer: ` +
        `the overlays directory has to be in the published tarball's files ` +
        `list. ` +
        `Generating anyway would produce a project quietly missing a feature ` +
        `it asked for, and adminigloo.json would claim it has it.`,
    );
  }
}

/**
 * Resolve the selected overlay names to directories on disk.
 *
 * The selection itself is `overlayNamesFor` in answers.ts, so the manifest can
 * record the same list without this module having to be involved.
 */
async function overlayDirsFor(
  templateDir: string,
  answers: Answers,
): Promise<string[]> {
  const overlaysRoot = join(templateDir, "..", "overlays");
  return overlayNamesFor(answers).map((name) => {
    const dir = join(overlaysRoot, name);
    // Absent used to be skipped silently. That was survivable while the only
    // record of what a project had was the project, and is not now that
    // adminigloo.json states it: a skipped overlay would make the manifest
    // assert a capability that nothing on disk provides.
    if (!existsSync(dir)) throw new OverlayMissingError(name, dir);
    return dir;
  });
}

async function walk(dir: string, base = dir): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full, base)));
    else out.push(relative(base, full));
  }
  return out;
}

/**
 * Build the complete set of files before writing any of them.
 *
 * Planning first means a failure halfway through leaves an empty directory
 * rather than a half-generated project that looks plausible enough to start
 * editing.
 */
export async function planEmit(
  templateDir: string,
  targetDir: string,
  answers: Answers,
): Promise<EmitPlan> {
  const files = new Map<string, string>();

  // Base first, then overlays. An overlay ADDS files; it never rewrites one the
  // base owns, and `assertOverlaysAreAdditive` enforces that rather than
  // trusting it. Selecting the admin shell copies a directory — it does not
  // switch a flag that some emitted file then branches on.
  for (const dir of [templateDir, ...(await overlayDirsFor(templateDir, answers))]) {
    for (const relPath of await walk(dir)) {
      const target = targetNameFor(relPath);
      if (dir !== templateDir && files.has(target)) {
        throw new OverlayCollisionError(target);
      }
      const source = await readFile(join(dir, relPath), "utf8");
      files.set(target, renderTokens(source, answers));
    }
  }

  files.set("package.json", renderPackageJson(answers));
  // Not a template file, unlike every other config in the project root. What
  // Next must be told never to bundle depends on which packages were installed
  // — see `renderNextConfig` — and a static file could only carry that as an
  // `if`.
  files.set("next.config.ts", renderNextConfig(answers));
  files.set(join("src", "env.ts"), renderEnvModule(answers));
  files.set(join("src", "db", "schema.ts"), renderSchemaModule(answers));
  files.set(
    join("src", "permissions", "catalog.ts"),
    renderPermissionsCatalog(answers),
  );
  files.set(join("src", "server", "routers", "_app.ts"), renderAppRouter(answers));
  // The audit vocabulary and the invitation mailer. Both generated for the same
  // reason `_app.ts` is: the fragments that exist and the packages that can send
  // mail depend on what was installed, and the alternative is an emitted file
  // holding an `if` about a feature it cannot see.
  files.set(join("src", "server", "audit.ts"), renderAuditRegistry(answers));
  files.set(
    join("src", "server", "invitation-mail.ts"),
    renderInvitationMail(answers),
  );
  // The nav and the landing page that reads it. Generated together and for the
  // same reason: /products exists only in a project that sells something and
  // /admin only in one with an admin shell, so neither the lists nor the page
  // can be a static file — and the overlays that own those routes are forbidden
  // from editing either.
  files.set(join("src", "nav.ts"), renderSiteNav(answers));
  // The admin sidebar, on the same footing as `src/nav.ts` and for the same
  // reason. It used to ship inside admin-minimal, where it could see neither
  // the admin-full pages layered on top of it nor the catalog-admin pages
  // beside it — so it linked to routes that were not there and omitted routes
  // that were. Written only when there is a shell to put it in: with
  // `--admin none` no layout imports it and an unused admin component in a
  // project that declined an admin panel is a file with nothing to say.
  if (answers.adminShell !== "none") {
    files.set(
      join("src", "components", "admin", "AdminNav.tsx"),
      renderAdminNav(answers),
    );
    // The panel's index, on the same footing as the sidebar beside it and for
    // the same reason. It counts orders, shipments and products in a project
    // that sells, and cannot so much as import those tables in one that does
    // not — so no single file in `admin-minimal` could have been right for
    // both, and the version that shipped there dodged the problem by counting
    // nothing at all and listing the viewer's permission keys instead.
    files.set(join("app", "admin", "page.tsx"), renderAdminDashboard(answers));
  }
  // Under `(site)`, so the landing page gets the same header and footer as every
  // other public page. The group is a routing no-op — this is still `/` — and it
  // is the base template that owns `app/(site)/layout.tsx`, which is what keeps
  // the storefront overlay additive while its pages inherit the chrome.
  files.set(join("app", "(site)", "page.tsx"), renderHomePage(answers));
  files.set(".env.example", renderEnvExample(answers));
  // Written directly, not just as an example. It is gitignored, and it carries
  // the one value that is not a credential — so `pnpm install && pnpm dev`
  // works with no setup at all, which is the whole point of deferring the rest.
  files.set(".env.local", renderEnvLocal(answers));

  // The manifest, and then the human-readable view OF the manifest. In that
  // order and from that one object, so the two cannot disagree: SCAFFOLD.md
  // used to be built from `answers` alongside adminigloo.json rather than from
  // it, which is two derivations of the same facts and therefore two chances to
  // drift.
  const manifest = buildManifest(answers, await readGeneratorVersion(templateDir));
  files.set(MANIFEST_FILENAME, renderManifest(manifest));
  files.set("SCAFFOLD.md", renderScaffoldRecord(manifest));

  const plan: EmitPlan = { targetDir, files };

  // Every capability the manifest is about to claim, checked against the files
  // this plan actually contains. On EVERY generation rather than only under
  // test, for the same reason `assertPermissionScopes` runs here: the cost is a
  // handful of substring checks over files already in memory, and the failure
  // it prevents — a manifest asserting something no emitted file provides — is
  // silent in every project that ships with it. `ai.streaming` was that
  // failure for several releases.
  assertCapabilitiesAreProvable(plan, manifest.capabilities);

  return plan;
}

export class GeneratorVersionUnreadableError extends Error {
  readonly name = "GeneratorVersionUnreadableError";
  constructor(path: string, cause: unknown) {
    super(
      `Could not read the generator's own version from ${path}: ` +
        `${cause instanceof Error ? cause.message : String(cause)}. ` +
        `Refusing to write a manifest that cannot say what produced it — ` +
        `an unattributed record is worse than none, because the whole point ` +
        `is diffing a copied file against the version it was copied from.`,
    );
  }
}

/**
 * The generator's own version, read from the package.json beside `template/`.
 *
 * Read rather than hardcoded, unlike the base package versions. Those describe
 * OTHER packages and can only be checked against the workspace by a test; this
 * one is right here, and a constant would need editing on every release —
 * a chore that gets skipped, after which every generated project claims to have
 * come from whichever version somebody last remembered to type in.
 */
async function readGeneratorVersion(templateDir: string): Promise<string> {
  const path = join(templateDir, "..", "package.json");
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as {
      version?: unknown;
    };
    if (typeof parsed.version !== "string" || parsed.version.length === 0) {
      throw new Error("no version field");
    }
    return parsed.version;
  } catch (error) {
    throw new GeneratorVersionUnreadableError(path, error);
  }
}

export async function writePlan(plan: EmitPlan): Promise<void> {
  for (const [relPath, contents] of plan.files) {
    const full = join(plan.targetDir, relPath);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, contents, "utf8");
  }
}

// The package version table moved to versions.ts, where the manifest can read
// it too. Re-exported so `emit.js` stays the one import path for everything the
// generator emits.
export {
  packageVersions,
  UnknownPackageVersionError,
  versionRangeFor,
} from "./versions.js";

/**
 * `pnpm dev` for a project that takes money.
 *
 * A SCRIPT RATHER THAN A COMMAND LINE, and the reason is a port. The line this
 * replaced was
 *
 *   concurrently -k "next dev" "stripe listen --forward-to localhost:3000/…"
 *
 * which writes the port down twice and lets one of them move. `next dev` with
 * no `--port` takes the next free port when 3000 is busy, so a second project
 * already running quietly relocates the app to 3001 while the listener keeps
 * forwarding to 3000: Stripe reports every delivery as delivered, nothing
 * arrives, and no order is ever written. `-k` compounded it — a machine with no
 * Stripe CLI exited that half instantly and took `next dev` down with it, so
 * `pnpm dev` did not start the app at all on a freshly generated project.
 *
 * `scripts/dev.ts` ships in the stripe overlay, resolves the port ONCE from
 * NEXT_PUBLIC_APP_URL and passes it to both halves, and treats the listener as
 * the optional half it is. It replaces `concurrently`, which is why that
 * dependency is gone.
 */
const STRIPE_DEV_SCRIPT = "tsx scripts/dev.ts";

export function renderPackageJson(answers: Answers): string {
  const sells = answers.businessModel !== "none";
  const deps: Record<string, string> = {
    "@clerk/nextjs": "^7.6.4",
    "@neondatabase/serverless": "^1.1.0",
    "@t3-oss/env-nextjs": "^0.13.11",
    "@tanstack/react-query": "^5.90.16",
    // In lockstep, and pinned to the range the workspace catalog builds the
    // packages against rather than to @adminigloo/trpc's peer floor. The floor
    // says what still works; this says what was actually tested. A generated
    // project resolving an older 11.x than the one the .d.ts files were emitted
    // from is a mismatch nobody would think to look for.
    "@trpc/client": "^11.18.0",
    "@trpc/react-query": "^11.18.0",
    "@trpc/server": "^11.18.0",
    "drizzle-orm": "^0.45.2",
    next: "16.2.12",
    // A PEER OF @adminigloo/observability, which every project installs, and it
    // was missing from this list entirely. `createLogger` imports pino at the
    // top of the module, and observability is reachable from every server page
    // through the tRPC context — so the build resolves it or it does not build.
    // It resolved anyway, because pnpm and npm auto-install peers by default;
    // set `auto-install-peers=false`, which plenty of teams do, and a freshly
    // generated project fails at the first `next build` with a module it never
    // asked for by name. A peer is a dependency the app is required to declare,
    // not one somebody else's default setting happens to supply.
    pino: "^10.3.1",
    react: "19.2.4",
    "react-dom": "19.2.4",
    "server-only": "^0.0.1",
    superjson: "^2.2.1",
    zod: "^4.5.1",
  };
  if (answers.includeAi) {
    // The provider SDK, and the only new runtime dependency `--ai` adds. Not
    // hand-rolled over fetch like the Upstash adapter: a model API is a moving
    // surface with streaming, retries, typed events and a wire format that
    // changes, and the vendor's own client is the thing that stays in step with
    // it. Pinned to the major the route's event handling is written against —
    // `content_block_delta` narrowing and `finalMessage()` are both typed.
    deps["@anthropic-ai/sdk"] = "^0.122.0";
  }
  if (answers.businessModel !== "none") {
    deps["stripe"] = "^22.6.0";
    // The Payment Element runs in the browser, so checkout needs the client SDK
    // as well as the server one.
    deps["@stripe/stripe-js"] = "^9.13.0";
    deps["@stripe/react-stripe-js"] = "^6.8.0";
  }
  for (const pkg of packagesFor(answers)) deps[pkg] = versionRangeFor(pkg);

  const devDeps: Record<string, string> = {
    "@types/node": "^26.4.0",
    "@types/react": "^19",
    "@types/react-dom": "^19",
    // Through `versionRangeFor` like every other package, not spelled out. It
    // was the one @adminigloo range written inline, so it was also the one the
    // drift test never looked at — a version pinned in a second place is a
    // version that will eventually be wrong in exactly one of them.
    [`${answers.scope}/testing`]: versionRangeFor(`${answers.scope}/testing`),
    "drizzle-kit": "^0.31.10",
    // Tailwind v4 folds in postcss and autoprefixer. Adding autoprefixer back
    // double-prefixes. These two ship in lockstep — a mismatched pair fails at
    // PostCSS load, before any page renders.
    tailwindcss: "^4.1.14",
    "@tailwindcss/postcss": "^4.1.14",
    // The seed script is TypeScript and is run directly, not built.
    tsx: "^4.23.5",
    typescript: "^5.9.3",
    vitest: "^4.1.11",
  };

  const manifest = {
    name: answers.projectName,
    version: "0.1.0",
    private: true,
    type: "module",
    scripts: {
      // The Stripe listener runs alongside `next dev` by default. Webhooks that
      // are only exercised in production are webhooks nobody has tested — and
      // it degrades to just the app on a machine with no Stripe CLI, rather
      // than refusing to start. See STRIPE_DEV_SCRIPT.
      dev: answers.businessModel === "none" ? "next dev" : STRIPE_DEV_SCRIPT,
      build: "next build",
      start: "next start",
      typecheck: "tsc --noEmit",
      test: "vitest run",
      "db:generate": "drizzle-kit generate",
      "db:migrate": "drizzle-kit migrate",
      "db:studio": "drizzle-kit studio",
      // Idempotent: re-run it after adding a permission to the catalog. It only
      // touches templates it created, never one you have customised.
      // --env-file because tsx, like drizzle-kit, does not read .env.local.
      "db:seed": "tsx --env-file=.env.local scripts/seed-roles.ts",
      // Local-only demo data: a tenant, members on different templates, an
      // override and a sealed permission, so the checklist shows all three states.
      //
      // CHAINED WITH THE SHOP SEED in a project that sells something, rather
      // than left as a second command somebody has to know about. A generated
      // project had no products at all, which made /products an empty page,
      // /checkout unreachable and the simulated purchase button unclickable —
      // a whole capability behind a command nobody had been told to run. Two
      // scripts because `scripts/seed-shop.ts` imports the catalog and commerce
      // packages, which a `--model none` project never installs; one entry
      // point because the person seeding wants the demo, not a list of parts.
      "db:seed:demo": sells
        ? "tsx --env-file=.env.local scripts/seed-demo.ts && tsx --env-file=.env.local scripts/seed-shop.ts"
        : "tsx --env-file=.env.local scripts/seed-demo.ts",
      // Separately runnable, because the catalogue is the half you re-seed
      // after buying everything in it, and re-running the people fixture to get
      // it back is a bigger hammer than the job needs.
      ...(sells
        ? { "db:seed:shop": "tsx --env-file=.env.local scripts/seed-shop.ts" }
        : {}),
      // No --env-file: this runs in CI where .env.local does not exist, and Node
      // treats a missing --env-file as fatal. The script loads it in a try/catch.
      "db:migrate:deploy": "tsx scripts/migrate.ts",
      "test:integration": "vitest run --project=integration",
    },
    dependencies: Object.fromEntries(Object.entries(deps).sort()),
    devDependencies: Object.fromEntries(Object.entries(devDeps).sort()),
    // pnpm 10 stopped running dependency install scripts unless they are named
    // here. Without it Next's image optimiser has no sharp binary and esbuild
    // has no platform binary, and both fail at the first build rather than at
    // install — where the warning that explains it has already scrolled past.
    pnpm: { onlyBuiltDependencies: ["esbuild", "sharp"] },
  };

  return `${JSON.stringify(manifest, null, 2)}\n`;
}

/**
 * `next.config.ts` for this project.
 *
 * GENERATED RATHER THAN COPIED FROM `template/`, for one line of it. Every
 * other setting is the same in every project; `serverExternalPackages` is not,
 * because what has to be kept out of the bundler depends on which packages were
 * installed — and the emitted file has to state the answer as a literal list
 * rather than compute it, which is the rule this generator exists to hold.
 */
export function renderNextConfig(answers: Answers): string {
  const scope = answers.scope;

  // The order is the order they are explained in below. Sorting would put the
  // paragraph about email above the entry it describes.
  const external = ["@neondatabase/serverless"];
  if (answers.includeEmail) external.push(`${scope}/email`);

  const emailNote = answers.includeEmail
    ? `
  //
  // ${scope}/email, because \`${scope}/email/emails\` renders the message
  // bodies with React Email — which means \`react-dom/server\`. React ships a
  // \`react-server\` export condition for that module whose entire body is
  // \`throw new Error("react-dom/server is not supported in React Server
  // Components")\`, and everything Next bundles into the React Server
  // Component graph — server components AND route handlers — resolves under
  // that condition. From this project the renderer is reached through
  // \`src/emails/invitation.ts\`, the invitations router and \`_app.ts\` into
  // \`src/trpc/server.ts\`, which every server component calling \`api()\`
  // imports, so it is not one email that is at stake.
  //
  // WITHOUT THIS LINE IT STILL BUILDS, and that is the reason the line is
  // here rather than the reason it is not. Turbopack applies its
  // react-dom/server rule to project source and exempts anything under
  // node_modules, so an installed ${scope}/email is bundled into the RSC
  // chunks with the real Node build of the renderer inside it. The result
  // works, and it works because the bundler declined to look — a heuristic
  // about a path, one Next release away from being tightened. Naming the
  // package here makes it deliberate: \`renderToStaticMarkup\` leaves
  // .next/server entirely and Node loads the module at request time.
  //
  // It is not a way of stopping the render happening on the server. Composing
  // an email IS server work, it stays there, and it stays synchronous, exactly
  // as \`src/server/invitation-mail.ts\` calls it. What changes is only WHO
  // loads the module: Node, under node conditions where \`react-dom/server\`
  // is the real renderer, instead of the bundler under \`react-server\` where
  // it is a throw.
  //
  // An external has to be INSTALLED. Next matches on a resolved path
  // containing \`node_modules/${scope}/email/\`, so a package symlinked out of
  // a checkout — a \`link:\` dependency, a workspace on the side — is not
  // externalised, IS treated as project source, and fails the build with
  // "You're importing a component that imports react-dom/server".
  // \`transpilePackages\` does not rescue it either, because transpiling is
  // bundling. Install the package, or point at a packed tarball; do not link
  // it.`
    : "";

  return `import type { NextConfig } from "next";

// Importing the env module here is deliberate: it runs Zod validation during
// \`next build\`, so a missing or malformed variable fails the build rather than
// the first request that happens to touch it.
import "./src/env";

const config: NextConfig = {
  reactStrictMode: true,
  // Packages Next must NOT bundle, and must \`require\` from node_modules at
  // request time instead.
  //
  // @neondatabase/serverless, because the driver decides between a WebSocket
  // and an HTTP fetch by looking at the runtime it finds itself in, and a
  // bundled copy has already had that decision made for it.${emailNote}
  serverExternalPackages: [${external.map((name) => JSON.stringify(name)).join(", ")}],
  turbopack: {
    // Pin the workspace root to THIS project. Next walks up looking for a
    // lockfile, so a project generated anywhere below another one — a scratch
    // directory, a monorepo you happen to be sitting in — infers the wrong root
    // and warns on every build.
    root: import.meta.dirname,
  },
};

export default config;
`;
}

/**
 * A ready-to-run `.env.local`.
 *
 * Every credential is present but commented out, with where to get it. An empty
 * file would boot equally well and tell you nothing; a file listing what is
 * missing turns "read the README" into "uncomment the line".
 */
export function renderEnvLocal(answers: Answers): string {
  const port = 3000;
  const lines = [
    "# Local development. Gitignored, and already valid — `pnpm dev` runs as is.",
    "#",
    "# Everything below is commented out. Uncomment and fill one in whenever you",
    "# want the feature it unlocks; visit /setup to see what is on and what is off.",
    "# A malformed value still fails at boot, so a half-pasted key is caught here",
    "# rather than three screens later.",
    "",
    `NEXT_PUBLIC_APP_URL=http://localhost:${port}`,
    "",
    "# APP_ENV names the environment on any host that is not Vercel. Deliberately",
    "# NOT set here: `pnpm dev` is already recognised as local from NODE_ENV, and",
    "# a value in this file would follow a `next start` you ran to check the",
    "# production build. Set it in the DEPLOYMENT's own configuration —",
    "# APP_ENV=production or APP_ENV=staging on Docker, Fly, Railway, Render, ECS",
    "# or a VPS. A deployment that names itself gets deferred credentials",
    "# enforced, the localhost-URL guard, live-key acceptance on production, and",
    "# the first-admin grant bound to BOOTSTRAP_ADMIN_EMAIL. One that does not is",
    "# treated as an unlabelled deployment: safe, but with all of that off.",
    "",
    "# --- Neon -----------------------------------------------------------------",
    "# console.neon.tech -> your STAGING project -> Connection Details.",
    "# Two different strings: the pooled host contains `-pooler`, the direct one",
    "# does not. They are not interchangeable and boot validation checks which is",
    "# which, so a swap fails immediately instead of hanging drizzle-kit later.",
    "# DATABASE_URL=",
    "# DATABASE_URL_UNPOOLED=",
    "",
    "# --- Clerk ----------------------------------------------------------------",
    "# dashboard.clerk.com -> API keys. Test mode.",
    "# The webhook secret is only needed once you have a public URL; on localhost",
    "# the user row is created from the session instead.",
    "# NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=",
    "# CLERK_SECRET_KEY=",
    "# CLERK_WEBHOOK_SIGNING_SECRET=",
    "",
    "# Who becomes the first administrator once DEPLOYED. On localhost the first",
    "# person to sign in gets it automatically; on a deployment the sign-up page",
    "# is public, so it grants nobody unless the email matches this.",
    "# BOOTSTRAP_ADMIN_EMAIL=",
    "",
    "# --- Observability ----------------------------------------------------------",
    "# Both optional, and both change behaviour rather than switching a feature",
    "# off. Without SENTRY_DSN, errors are still fingerprinted into `error_log` and",
    "# listed in the admin panel. Without the Upstash pair, every rate limit counts",
    "# in one process's memory — exactly right for one dev server, and wrong on a",
    "# fleet, where N instances means N counters and every cold start resets them.",
    "# The URL is the REST one (https://…upstash.io), NOT the redis:// string.",
    "# SENTRY_DSN=",
    "# UPSTASH_REDIS_REST_URL=",
    "# UPSTASH_REDIS_REST_TOKEN=",
  ];

  if (answers.businessModel !== "none") {
    lines.push(
      "",
      "# --- Stripe ---------------------------------------------------------------",
      "# dashboard.stripe.com -> Developers -> API keys, with Test mode ON.",
      "# STRIPE_WEBHOOK_SECRET is printed by `stripe listen`, which `pnpm dev`",
      "# starts for you — it is NOT the one in the dashboard.",
      "# NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=",
      "# STRIPE_SECRET_KEY=",
      "# STRIPE_WEBHOOK_SECRET=",
      "",
      "# Books orders with no payment, so the whole funnel works before Stripe",
      "# exists. Needed NOWHERE locally — `pnpm dev` already qualifies — and it",
      "# is never available on production. Set it to true only on a staging",
      "# deployment you are about to demo.",
      "# ALLOW_SIMULATED_CHECKOUT=true",
    );
  }
  if (answers.includeEmail) {
    lines.push(
      "",
      "# --- Resend ---------------------------------------------------------------",
      "# Without RESEND_API_KEY, sends are recorded as `skipped` and logged, so you",
      "# can see exactly what would have gone out.",
      "# RESEND_API_KEY=",
      "# EMAIL_FROM=Your Name <hello@yourdomain.com>",
    );
  }
  if (answers.includeAi) {
    lines.push(
      "",
      "# --- AI ---------------------------------------------------------------------",
      "# ANTHROPIC_API_KEY=",
    );
  }

  return `${lines.join("\n")}\n`;
}

export function renderEnvExample(answers: Answers): string {
  const lines = [
    "# Copy to .env.local and fill in. Every value is validated at boot;",
    "# a missing or malformed one stops the server rather than failing later.",
    "#",
    "# TEST-MODE KEYS ONLY, here and in the Vercel Preview scope. A live key",
    "# outside production throws KeyModeMismatchError at boot, by design, and",
    "# no environment variable can switch that check off.",
    "",
  ];
  for (const name of requiredEnvFor(answers)) lines.push(`${name}=`);

  // Listed, not omitted. These are the variables an app can read and does not
  // need, and a variable absent from this file is one nobody discovers exists —
  // which is how a project runs for a year with a rate limiter counting in one
  // process's memory because nothing ever mentioned UPSTASH_REDIS_REST_URL.
  // Empty counts as unset, so copying this file wholesale still produces a
  // working .env.local.
  lines.push(
    "",
    "# Optional. The app boots and runs without every line below; each one is a",
    "# documented behaviour rather than a switched-off feature, and /setup says",
    "# what each one changes. An empty value counts as unset.",
    "",
  );
  for (const name of optionalEnvFor(answers)) lines.push(`${name}=`);

  return `${lines.join("\n")}\n`;
}

/**
 * What was generated, and from what — the readable view of `adminigloo.json`.
 *
 * Copied source stops receiving upstream fixes the moment it is copied. A year
 * later the only way to tell a deliberate edit from a stale default is to diff
 * against the version that produced it, which requires knowing that version.
 *
 * TAKES THE MANIFEST, not the answers. Both files state the same facts, and
 * deriving each of them separately from `answers` is two implementations of one
 * truth: the day somebody adds a question and updates one renderer, the two
 * disagree and the human-readable one is the copy people believe. Reading the
 * manifest means this file cannot say anything the manifest does not.
 *
 * The exception is the fork list at the bottom, which is the one thing here
 * that no tool can know and the one thing a person is asked to maintain. It is
 * in this file rather than the manifest precisely so the manifest can stay
 * entirely derived and therefore rebuildable.
 */
export function renderScaffoldRecord(manifest: ProjectManifest): string {
  const answers = manifest.answers;
  return [
    `# ${answers.projectName}`,
    "",
    `Generated by \`${manifest.generator.name}\` ${manifest.generator.version}.`,
    "",
    "Everything above the fork list is read from `adminigloo.json`, which the",
    "generator wrote and tooling reads. Do not edit either by hand — change an",
    "answer by regenerating.",
    "",
    "| Answer | Value |",
    "| --- | --- |",
    `| Customer organisation | ${answers.tenantNoun} |`,
    `| Business model | ${answers.businessModel} |`,
    `| Admin shell | ${answers.adminShell} |`,
    `| AI routes | ${answers.includeAi ? "yes" : "no"} |`,
    `| Transactional email | ${answers.includeEmail ? "yes" : "no"} |`,
    `| Personal-workspace only | ${isPersonalWorkspaceOnly(answers) ? "yes" : "no"} |`,
    "",
    "## Installed packages",
    "",
    ...Object.entries(manifest.packages).map(
      ([name, range]) => `- \`${name}\` ${range}`,
    ),
    "",
    "## Overlays applied",
    "",
    "Copied source. These files are yours now and receive no upstream fixes,",
    "which is why the generator version above matters.",
    "",
    ...(manifest.overlays.length === 0
      ? ["_none — this project is the base template only_"]
      : manifest.overlays.map((name) => `- \`${name}\``)),
    "",
    "## Capabilities",
    "",
    "What tooling will assume this project has. Derived from the answers, not",
    "declared separately.",
    "",
    ...manifest.capabilities.map((key) => `- \`${key}\``),
    "",
    "## Forked modules",
    "",
    "THE ONE SECTION A PERSON MAINTAINS. Record any base module copied into this",
    "repo and no longer imported, with the version it was forked from. Forking",
    "is legitimate; forking silently is what turns the next upgrade into a",
    "negotiation. It is not in `adminigloo.json` because nothing can infer it,",
    "and a manifest with one hand-written field can no longer be rebuilt and",
    "compared against itself.",
    "",
    "_none yet_",
    "",
  ].join("\n");
}

/**
 * `src/env.ts` for this project.
 *
 * Derived rather than templated because the fragments an app composes are
 * exactly the packages it installed. A static file would either demand a Stripe
 * key from a project with no Stripe, or omit it from one that needs it — and
 * the second failure only surfaces at the first payment.
 */
export function renderEnvModule(answers: Answers): string {
  const takesMoney = answers.businessModel !== "none";
  const scope = answers.scope;

  const imports = [
    `import { authClient, authServer, AUTH_MODE_BOUND_KEYS } from "${scope}/auth";`,
    `import { dbServer, DB_OPTIONAL_UNTIL_DEPLOYED } from "${scope}/db";`,
    `import { coreClient, coreServer, defineEnv } from "${scope}/env";`,
    // Unconditional, because observability is in the base package set. It was
    // the one installed package whose fragment was never spread, so SENTRY_DSN
    // and the Upstash pair existed in no project's contract: /setup could not
    // report on them and the rate limiter had no way to be pointed at a shared
    // store. OBSERVABILITY_ENV_GROUPS travels with it so the /setup rows name
    // the same members the package checks, rather than a retyped copy of them.
    `import { observabilityServer, OBSERVABILITY_ENV_GROUPS } from "${scope}/observability";`,
    `import { z } from "zod";`,
  ];
  if (takesMoney) {
    imports.push(
      `import { stripeClient, stripeServer, STRIPE_MODE_BOUND_KEYS } from "${scope}/stripe";`,
    );
  }
  if (answers.includeAi) imports.push(`import { aiServer } from "${scope}/ai";`);
  if (answers.includeEmail) imports.push(`import { emailServer } from "${scope}/email";`);

  const serverSpreads = [
    "...coreServer()",
    "...dbServer()",
    "...authServer()",
    "...observabilityServer()",
    // Who becomes the first administrator on a DEPLOYED environment. Optional:
    // unset means a deployment grants nobody automatically, which is the safe
    // default when the sign-up page is reachable from the public internet.
    "BOOTSTRAP_ADMIN_EMAIL: z.string().email().optional()",
  ];
  const clientSpreads = ["...coreClient()", "...authClient()"];
  const modeBound = ["...AUTH_MODE_BOUND_KEYS"];
  const runtime = [
    "NODE_ENV: process.env.NODE_ENV",
    "LOG_LEVEL: process.env.LOG_LEVEL",
    "DATABASE_URL: process.env.DATABASE_URL",
    "DATABASE_URL_UNPOOLED: process.env.DATABASE_URL_UNPOOLED",
    "CLERK_SECRET_KEY: process.env.CLERK_SECRET_KEY",
    "CLERK_WEBHOOK_SIGNING_SECRET: process.env.CLERK_WEBHOOK_SIGNING_SECRET",
    // Falls back to the URL Vercel assigns this deployment. A Preview URL is
    // not known until the deployment exists, so requiring the variable to be
    // set by hand makes every preview either fail the localhost guard or need
    // a value nobody can know in advance. VERCEL_URL is injected at build time,
    // which is when NEXT_PUBLIC_* is inlined, so the two line up.
    "NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL ?? (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : undefined)",
    "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY",
    "BOOTSTRAP_ADMIN_EMAIL: process.env.BOOTSTRAP_ADMIN_EMAIL",
    // All three optional. Absent, the logger writes to stdout and the rate
    // limiter counts in one process's memory — both real behaviours rather than
    // disabled ones, which is why none of them is deferred-until-deployed.
    "SENTRY_DSN: process.env.SENTRY_DSN",
    "UPSTASH_REDIS_REST_URL: process.env.UPSTASH_REDIS_REST_URL",
    "UPSTASH_REDIS_REST_TOKEN: process.env.UPSTASH_REDIS_REST_TOKEN",
  ];

  // Required on a deployment, deferrable on a laptop. Everything a service
  // account issues belongs here; NEXT_PUBLIC_APP_URL does not, because you
  // already know it and nothing has to be signed up for.
  const deferred = [
    "...DB_OPTIONAL_UNTIL_DEPLOYED",
    '"CLERK_SECRET_KEY"',
    '"NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY"',
  ];

  const features = [
    `{ name: "Database", vars: [...DB_OPTIONAL_UNTIL_DEPLOYED], disables: "Anything that reads or writes data." }`,
    `{ name: "Sign-in", vars: ["CLERK_SECRET_KEY", "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY", "CLERK_WEBHOOK_SIGNING_SECRET"], disables: "Signing in, and every permission check." }`,
  ];

  if (takesMoney) {
    serverSpreads.push("...stripeServer()");
    clientSpreads.push("...stripeClient()");
    modeBound.push("...STRIPE_MODE_BOUND_KEYS");
    // The one variable that authorises handing out paid goods without taking a
    // payment. Declared here rather than in @__SCOPE_NAME__/stripe's fragment
    // because it is not a Stripe credential — it is a statement about THIS
    // deployment, and `src/server/checkout-mode.ts` is the only reader.
    //
    // An enum with a default rather than `.optional()`. Unset means off, which
    // is what a deployment nobody configured must mean; and a value that is
    // neither "true" nor "false" fails at boot instead of being read as one of
    // them, because `ALLOW_SIMULATED_CHECKOUT=1` silently meaning "off" is how
    // somebody demos a shop that refuses every click.
    serverSpreads.push(
      'ALLOW_SIMULATED_CHECKOUT: z.enum(["true", "false"]).default("false")',
    );
    runtime.push(
      "STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY",
      "STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET",
      "NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY",
      "ALLOW_SIMULATED_CHECKOUT: process.env.ALLOW_SIMULATED_CHECKOUT",
    );
    features.push(
      `{ name: "Payments", vars: ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY"], disables: "Checkout, subscriptions and the webhook ledger." }`,
      `{ name: "Simulated checkout", vars: ["ALLOW_SIMULATED_CHECKOUT"], disables: "Nothing. Set it to true on a staging deployment that has no Stripe key, to record orders without taking a payment. Locally it is not needed, and on production the simulated checkout is never available." }`,
    );
  }

  if (answers.includeAi) {
    serverSpreads.push("...aiServer()");
    runtime.push(
      "ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY",
      "OPENAI_API_KEY: process.env.OPENAI_API_KEY",
      "GOOGLE_GENERATIVE_AI_API_KEY: process.env.GOOGLE_GENERATIVE_AI_API_KEY",
    );
    features.push(
      `{ name: "AI", vars: ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY"], disables: "Nothing else. /api/ai/chat answers 503 with the empty provider list; every other route is unaffected, and the rate limits still apply." }`,
    );
  }

  if (answers.includeEmail) {
    serverSpreads.push("...emailServer()");
    runtime.push(
      "RESEND_API_KEY: process.env.RESEND_API_KEY",
      "EMAIL_FROM: process.env.EMAIL_FROM",
      "EMAIL_REPLY_TO: process.env.EMAIL_REPLY_TO",
      "RESEND_WEBHOOK_SECRET: process.env.RESEND_WEBHOOK_SECRET",
    );
    deferred.push('"EMAIL_FROM"');
    features.push(
      `{ name: "Email", vars: ["RESEND_API_KEY", "EMAIL_FROM"], disables: "Sending mail. Sends are recorded as skipped instead." }`,
    );
  }

  // Last on /setup, and last here so it stays that way. Everything above
  // switches a product feature off; these two change only how well the running
  // app can be operated, and a reader working down the page should meet the
  // credentials that block a launch first.
  //
  // Named from OBSERVABILITY_ENV_GROUPS rather than retyped. The package
  // documents that constant as the reason an app cannot check a group and miss
  // a member, and spelling the strings out here would be that same mistake one
  // level up: a group that gained a third variable would gain it in the check
  // and not in the report.
  features.push(
    `{ name: "Error tracking", vars: [...OBSERVABILITY_ENV_GROUPS.sentry], disables: "Nothing on its own — errors are recorded in error_log either way. Validated here so adding a Sentry client is an install rather than a new environment contract." }`,
    `{ name: "Rate limiting", vars: [...OBSERVABILITY_ENV_GROUPS.upstash], disables: "Rate limits shared between instances. Without them every process counts alone, so a fleet allows N times the configured limit and a cold start resets it." }`,
  );

  return `${imports.join("\n")}

/**
 * The environment contract for ${answers.projectName}.
 *
 * HARD RULE: this is the only module allowed to read \`process.env\`. Everywhere
 * else imports \`env\`. Composed from the fragments of the packages actually
 * installed, so this project is never asked for a credential it has no use for.
 */
const server = {
  ${serverSpreads.join(",\n  ")},
};

const client = {
  ${clientSpreads.join(",\n  ")},
};

const runtimeEnv = {
  ${runtime.join(",\n  ")},
};

/**
 * Credentials you can add LATER.
 *
 * On a laptop these may be absent: the app boots, /setup lists what is missing,
 * and the feature each one unlocks stays off until you paste a value in. That
 * is the difference between a scaffold you can run and one you have to finish
 * shopping for first.
 *
 * On a deployment they are hard-required and the build fails without them,
 * because a forgotten Vercel variable should stop a release rather than reach a
 * customer as a broken page. A value that is PRESENT but malformed still fails
 * everywhere — a mistyped connection string is not a deferred credential.
 */
const optionalUntilDeployed = [
  ${deferred.join(",\n  ")},
] as const;

export const env = defineEnv({
  server,
  client,
  runtimeEnv,
  optionalUntilDeployed,
  // Their \`_test_\` / \`_live_\` mode must match the deployment. Checked outside
  // Zod on the raw values, so neither SKIP_ENV_VALIDATION nor deferring a key
  // above can switch it off.
  modeBoundKeys: [${modeBound.join(", ")}],
});

/**
 * Inputs for the /setup page, exported so it reads the SAME schemas boot
 * validation uses. A setup page with its own copy of the list drifts the first
 * time a package is added, and then confidently reports that everything is
 * configured.
 */
export const envDescription = {
  server,
  client,
  runtimeEnv,
  optionalUntilDeployed,
  features: [
    ${features.join(",\n    ")},
  ],
};
`;
}


/** The two catalogs a permission key can live in. Mirrors `Scope` in @…/permissions. */
export type PermissionScope = "staff" | "tenant";

/**
 * One package's permission fragment, and the scope the PACKAGE declares it for.
 *
 * ONE ROW PER FRAGMENT, and the scope is a property of the row rather than a
 * choice made again at the spread. That is the whole point of the table: which
 * catalog a fragment goes into is now read from here, so there is no second
 * place to type it and therefore no second place to type it wrongly.
 *
 * The scaffold has now shipped a permission in the wrong scope three times, and
 * every time the symptom was silence. A key declared under "tenant" and checked
 * with `requireStaff(...)` matches nothing: the feature is invisible to
 * everybody, forever, with no error anywhere. The catalog keys did it and the
 * conformance test caught them; commerce and billing did it and nothing did,
 * because `defaultFor: ["admin"]` names a real template in BOTH ladders — so
 * twelve of their fourteen defaults kept granting to the admin of the wrong
 * ladder and looked healthy, while `plans.manage` and `subscriptions.manage`,
 * which are owner-only, reached no role at all.
 *
 * The rule the `scope` column encodes: STAFF is you operating the product —
 * defining what is for sale, reading the audit log, impersonating a customer.
 * TENANT is your customer operating their own account. The tie-breaker when
 * that reads ambiguously is the package's own `defaultFor` values, because
 * those name templates from one ladder or the other and nothing else: owner,
 * member and viewer exist only in `TENANT_ROLE_TEMPLATES`; cs_lead and cs_agent
 * only in the staff ladder seeded by `scripts/seed-roles.ts`.
 */
export interface PackagePermissionFragment {
  /** Bare package name; the generated import is `${answers.scope}/${package}`. */
  readonly package: string;
  /** The binding the package exports. */
  readonly binding: string;
  /** The catalog it is declared for. */
  readonly scope: PermissionScope;
  /** True when these answers install the package that exports it. */
  installedBy(answers: Answers): boolean;
  /** Rendered as a comment above the import. */
  readonly why: string;
}

const SELLS = (answers: Answers): boolean => answers.businessModel !== "none";

export const PACKAGE_PERMISSION_FRAGMENTS: readonly PackagePermissionFragment[] = [
  {
    package: "tenancy",
    binding: "tenancyPermissions",
    scope: "tenant",
    installedBy: () => true,
    why:
      "Membership, invitations and ownership transfer. Tenancy is in the base " +
      "package set, so this fragment is in every project.",
  },
  {
    package: "catalog",
    binding: "catalogPermissions",
    scope: "staff",
    installedBy: SELLS,
    why:
      "Defining what is for sale is an operator activity: you author the " +
      "products, your customers buy them. Every default names admin, cs_lead " +
      "or cs_agent, and the admin router gates each key with requireStaff.",
  },
  {
    package: "stripe",
    binding: "stripePermissions",
    scope: "tenant",
    installedBy: SELLS,
    why:
      "A customer managing their own billing — the portal, their invoices, a " +
      "refund on their subscription. Theirs, not the firm's.",
  },
  {
    package: "commerce",
    binding: "commercePermissions",
    scope: "tenant",
    installedBy: SELLS,
    why:
      "Orders and discount codes, held by the organisation that owns them. " +
      "TENANT: every default here names owner, admin, member or viewer, and " +
      "the staff ladder has no owner, member or viewer to give them to.",
  },
  {
    package: "billing",
    binding: "billingPermissions",
    scope: "tenant",
    installedBy: SELLS,
    why:
      "Plans and subscriptions as the paying organisation sees them. TENANT " +
      "for the same reason commerce is: `plans.manage` and " +
      "`subscriptions.manage` are owner-only, and a staff catalog has no " +
      "owner — in one, those two keys reached no role at all.",
  },
  {
    package: "ai",
    binding: "aiPermissions",
    scope: "tenant",
    installedBy: (answers) => answers.includeAi,
    why: "A customer using the AI features inside their own account.",
  },
];

export class PermissionScopeMismatchError extends Error {
  readonly name = "PermissionScopeMismatchError";
  constructor(binding: string, declared: PermissionScope, spreadInto: PermissionScope) {
    super(
      `${binding} is declared for the ${declared} catalog and the generated ` +
        `src/permissions/catalog.ts spreads it into the ${spreadInto} one. A ` +
        `key in the wrong scope matches nothing and errors nowhere: the ` +
        `feature is invisible to everybody and no test in the generated ` +
        `project fails, because "admin" is a template in both ladders. Fix ` +
        `PACKAGE_PERMISSION_FRAGMENTS, or the catalog it is spread into.`,
    );
  }
}

/**
 * Read the emitted file back and check every spread landed in its own scope.
 *
 * AGAINST THE RENDERED TEXT, not against the table that produced it. Checking
 * the inputs against themselves would be a tautology that passes for ever; this
 * parses the `definePermissions("staff", { ...a, ...b })` calls actually
 * written and compares each binding to the scope its row declares, so a
 * hand-edit of the template string below is caught by the same assertion as a
 * mis-grouped row above. It runs on every single generation rather than only
 * under test, because the cost is one regex over a file we have just built and
 * the failure it prevents is a silent one.
 */
export function assertPermissionScopes(
  source: string,
  fragments: readonly PackagePermissionFragment[] = PACKAGE_PERMISSION_FRAGMENTS,
): void {
  const declared = new Map(fragments.map((f) => [f.binding, f.scope]));

  for (const call of source.matchAll(
    /definePermissions\(\s*"(staff|tenant)",\s*\{([^}]*)\}/g,
  )) {
    const spreadInto = call[1] as PermissionScope;
    for (const spread of (call[2] ?? "").matchAll(/\.\.\.(\w+)/g)) {
      const binding = spread[1] ?? "";
      const owns = declared.get(binding);
      // `appStaffPermissions` and `appTenantPermissions` are written here and
      // have no package to disagree with, so they are not in the table.
      if (owns !== undefined && owns !== spreadInto) {
        throw new PermissionScopeMismatchError(binding, owns, spreadInto);
      }
    }
  }
}

/**
 * `src/permissions/catalog.ts` for this project.
 *
 * Generated, because which packages contribute keys depends on what was
 * installed — and because SCOPE MATTERS AND IS EASY TO GET WRONG in a way
 * nothing downstream reports. See `PACKAGE_PERMISSION_FRAGMENTS` above for the
 * rule and for the three times this has now gone wrong.
 */
export function renderPermissionsCatalog(answers: Answers): string {
  const scope = answers.scope;
  const label = tenantLabel(answers);
  const plural = tenantLabelPlural(answers);

  // Grouped BY THE TABLE'S OWN `scope` column rather than by a second list per
  // catalog. There is nowhere here to put a fragment in the wrong one.
  const installed = PACKAGE_PERMISSION_FRAGMENTS.filter((f) => f.installedBy(answers));
  const inScope = (want: PermissionScope): string[] =>
    installed.filter((f) => f.scope === want).map((f) => f.binding);

  const imports = [
    `import { definePermissions, type PermissionKeyOf } from "${scope}/permissions";`,
    ...installed.map(
      (fragment) =>
        `${indentedComment(fragment.why).replace(/^ {2}/gm, "")}` +
        `import { ${fragment.binding} } from "${scope}/${fragment.package}";`,
    ),
  ];

  const staffFragments = inScope("staff");
  const tenantFragments = inScope("tenant");
  const staffSpread = [...staffFragments, "appStaffPermissions"];
  const tenantSpread = [...tenantFragments, "appTenantPermissions"];

  const source = `${imports.join("\n")}

/**
 * Permission keys for ${answers.projectName}.
 *
 * Packages contribute plain records; this file spreads them into one catalog
 * per scope. \`contributedBy\` is what catches two packages claiming the same
 * key — a bare spread lets the last one silently win, and which definition
 * survives is decided by import order.
 *
 * Adding a capability is two steps: a key here, and a grant in a role template.
 * Nothing is implicit — a key in no template is denied for everyone, including
 * you.
 *
 * SCOPE IS LOAD-BEARING. Check where the code that reads a key lives before you
 * add it: \`requireStaff\` reads the staff catalog, \`requireTenant\` reads the
 * tenant one, and a key in the wrong scope matches nothing and errors nowhere.
 */

const appTenantPermissions = {
  // "reports.export": { label: "Export reports", category: "Reports" },
} as const;

export const tenantCatalog = definePermissions(
  "tenant",
  { ${tenantSpread.map((f) => `...${f}`).join(", ")} },
  { contributedBy: [${tenantSpread.join(", ")}] },
);

const appStaffPermissions = {
  "staff.dashboard.view": {
    label: "View the admin dashboard",
    category: "Dashboard",
    defaultFor: ["admin", "cs_lead", "cs_agent"],
  },
  "staff.tenants.view": {
    label: "View ${plural}",
    category: "${plural}",
    defaultFor: ["admin", "cs_lead", "cs_agent"],
  },
  "staff.people.view": {
    label: "View people",
    category: "People",
    defaultFor: ["admin", "cs_lead"],
  },
  "staff.roles.view": {
    label: "View roles and permissions",
    category: "Access",
    defaultFor: ["admin", "cs_lead"],
  },
  "staff.roles.manage": {
    label: "Assign templates and set per-person overrides",
    description:
      "Grants and revokes individual capabilities on top of a role template.",
    category: "Access",
    defaultFor: ["admin"],
  },
  "staff.audit.view": {
    label: "View the audit log",
    category: "Access",
    defaultFor: ["admin", "cs_lead"],
  },
  "staff.tenants.impersonate": {
    label: "Open a customer's own screen",
    description: "Every entry is written to the audit log as sensitive access.",
    category: "${plural}",
    // Sealed: an override must not hand this to one person quietly.
    sealed: true,
  },
} as const;

export const staffCatalog = definePermissions(
  "staff",
  { ${staffSpread.map((f) => `...${f}`).join(", ")} },
  { contributedBy: [${staffSpread.join(", ")}] },
);

export type TenantPermission = PermissionKeyOf<typeof tenantCatalog>;
export type StaffPermission = PermissionKeyOf<typeof staffCatalog>;
`;

  // The last thing this function does, on the text it is about to hand back.
  // See `assertPermissionScopes` for why it reads the output rather than the
  // table: a check of the inputs against themselves cannot fail.
  assertPermissionScopes(source);
  return source;
}


/**
 * `src/server/invitation-mail.ts` for this project.
 *
 * TWO VARIANTS, ONE SIGNATURE, and the branch is here rather than in the file.
 * Tenancy is in the base package set, so every project can invite somebody;
 * @__SCOPE_NAME__/email is optional, so not every project can post the
 * invitation. The emitted module answers the same question either way —
 * `sendInvitationEmail(request)` resolves to an outcome — and the router that
 * calls it holds no `if` asking whether mail was installed. Without this split
 * the router would have to, and that is precisely the conditional the scaffold
 * refuses to put in a generated artifact.
 *
 * The no-mail variant is a real no-op with a real return value, not a throw and
 * not a null the caller has to remember to test: an invitation created on a
 * project with no email package still produces a working link, which the
 * members page then offers to copy. `createEmailSender` reaching outcome
 * `'skipped'` with no API key is the same pattern one level down, and both
 * exist so that "we have not set up mail yet" never blocks the feature that
 * happens to send some.
 */
export function renderInvitationMail(answers: Answers): string {
  const scope = answers.scope;

  const contract = `/**
 * One invitation, on its way out.
 *
 * \`url\` is absolute because a relative path is not a link in an inbox, and it
 * carries the one-time token — which is why this object never reaches the audit
 * log or a log line. \`invitationId\` is what the delivery log correlates on
 * instead: it is safe to store, and it is what somebody asking "did the mail
 * for this invitation ever go out" has in their hand.
 */
export interface InvitationMailRequest {
  readonly to: string;
  readonly tenantId: string;
  readonly tenantName: string;
  /** Who sent it, as a display name or an address. Null when unknown. */
  readonly invitedBy: string | null;
  readonly roleName: string;
  /** Absolute, and secret: the token is in it. */
  readonly url: string;
  readonly expiresAt: Date | null;
  readonly invitationId: string;
}

/**
 * What became of it.
 *
 * \`delivered\` is deliberately NOT \`status !== "failed"\`. It answers the only
 * question the caller acts on — did a provider accept this message, so that the
 * invitee will get the link without our help — and \`skipped\` answers no just
 * as firmly as \`failed\` does. The members page shows the link to copy exactly
 * when this is false, so collapsing the two would hide the link on a laptop
 * that cannot send mail at all.
 */
export interface InvitationMailOutcome {
  readonly status: "sent" | "skipped" | "failed";
  readonly delivered: boolean;
}
`;

  if (!answers.includeEmail) {
    return `${contract}
/**
 * ${answers.projectName} was generated without @${scope.replace(/^@/, "")}/email.
 *
 * There is no mail package installed and therefore nothing to send with, so
 * every invitation is recorded here as skipped and the link is handed back to
 * whoever created it. That is a complete feature rather than a degraded one:
 * copying a link to a colleague is how most invitations actually travel, and it
 * works with no credentials, no domain and no provider account.
 *
 * Re-generate with \`--email\` to post them instead. Nothing in the router
 * changes — the signature above is the same in both variants, which is the
 * whole reason this module is generated.
 */
export function sendInvitationEmail(
  _request: InvitationMailRequest,
): Promise<InvitationMailOutcome> {
  return Promise.resolve({ status: "skipped", delivered: false });
}
`;
  }

  return `import { createEmailSender, formatSenderAddress } from "${scope}/email";
import { emailEvents } from "${scope}/email/schema";
import { db } from "@/db";
import { renderInvitationEmail } from "@/emails/invitation";
import { env } from "@/env";

${contract}
/** Recorded in \`email_events.template\`, so the log can be filtered by kind. */
export const INVITATION_TEMPLATE = "tenant-invitation";

/**
 * One sender for the process.
 *
 * EMAIL_FROM is deferred until deployment, so on a laptop it is genuinely
 * undefined — and \`createEmailSender\` throws at construction for a From it
 * cannot parse, which at module scope means the whole app fails to import.
 * The fallback is an RFC 2606 reserved domain that can never receive anything,
 * chosen over a plausible-looking address on purpose: with no API key nothing
 * is dispatched anyway, and if somebody does set a key without a From, the
 * provider's rejection names an address that is obviously a placeholder rather
 * than one that looks like it should have worked.
 */
const sender = createEmailSender({
  apiKey: env.RESEND_API_KEY,
  from: env.EMAIL_FROM ?? "invitations@example.invalid",
  replyTo: env.EMAIL_REPLY_TO,
});

export async function sendInvitationEmail(
  request: InvitationMailRequest,
): Promise<InvitationMailOutcome> {
  const body = renderInvitationEmail({
    tenantName: request.tenantName,
    invitedBy: request.invitedBy,
    roleName: request.roleName,
    url: request.url,
    expiresAt: request.expiresAt,
    productName: "${answers.projectName}",
  });

  // The invitation row already exists by the time this runs, so nothing here
  // may throw: an exception would lose the only copy of the link before the
  // caller could hand it back, and the invitee would be waiting on a mail that
  // was never attempted. \`send\` returns a failed outcome for a provider that
  // is down; it THROWS for a message it refuses to build, which is the case
  // this catch covers — an address that satisfied Zod and not the stricter
  // header parser.
  try {
    const outcome = await sender.send({
      to: request.to,
      subject: body.subject,
      html: body.html,
      text: body.text,
      template: INVITATION_TEMPLATE,
      tenantId: request.tenantId,
      // The id, never the token. This column is jsonb in a table kept longer
      // than anything else here; a credential in it outlives the credential.
      metadata: { invitationId: request.invitationId },
    });

    await db.insert(emailEvents).values(outcome.log);
    return { status: outcome.status, delivered: outcome.status === "sent" };
  } catch (cause) {
    const error = cause instanceof Error ? cause : new Error(String(cause));
    // Written by hand because there is no outcome to take a log row from. The
    // alternative is no row at all, and a delivery log missing exactly the
    // sends that broke is a delivery log that answers the wrong question.
    await db.insert(emailEvents).values({
      messageId: null,
      toAddress: request.to,
      fromAddress: formatSenderAddress(sender.from),
      subject: body.subject,
      template: INVITATION_TEMPLATE,
      tenantId: request.tenantId,
      status: "failed",
      error: error.message,
      metadata: { invitationId: request.invitationId },
    });
    return { status: "failed", delivered: false };
  }
}
`;
}


/**
 * `src/server/audit.ts` for this project.
 *
 * Generated for the same reason `src/permissions/catalog.ts` is: which packages
 * contribute keys depends on what was installed. The catalog router only exists
 * in a project that sells something, so a hand-written file spreading its
 * actions would not compile in a project generated with `--model none`.
 *
 * ONE REGISTRY, composed from fragments, and the composition is the point.
 * Before this file there were two — `adminAuditedActions` in the admin router
 * and `catalogAuditedActions` in the catalog router — and two registries cannot
 * detect a collision between them. `admin.recentAudit` labels rows from the
 * registry it holds, so every catalog action rendered in the audit viewer as
 * its raw key: not broken, just quietly unreadable, in the one screen whose
 * entire job is to be read. Adding invitations would have made it three.
 *
 * Each router keeps writing through the registry it declares. `contributedBy`
 * is what makes that safe: a key claimed twice throws at boot rather than
 * letting whichever spread ran last decide the label and the `sensitive` flag.
 */
export function renderAuditRegistry(answers: Answers): string {
  const scope = answers.scope;
  const label = tenantLabel(answers).toLowerCase();
  const plural = tenantLabelPlural(answers).toLowerCase();

  const imports = [
    `import { defineAuditedActions } from "${scope}/observability";`,
    `import type { AuditActionKeyOf } from "${scope}/observability";`,
  ];
  const fragments = ["adminAuditedActions", "invitationAuditedActions"];

  if (answers.businessModel !== "none") {
    // One-way. `routers/catalog.ts` writes through its own registry and imports
    // nothing from here, so this file can read its fragment without the two
    // modules forming a cycle that would leave one of them half-initialised.
    imports.push('import { catalogAuditedActions } from "./routers/catalog";');
    fragments.push("catalogAuditedActions");
    // The customer side, on the same one-way terms and for the same reason.
    // Only one thing a customer does is worth a row — opening the billing
    // portal, which hands them the ability to cancel the subscription and read
    // every invoice, and which then happens at Stripe where this application
    // sees nothing further.
    imports.push('import { accountAuditedActions } from "./routers/account";');
    fragments.push("accountAuditedActions");
  }

  return `${imports.join("\n")}

/**
 * Everything ${answers.projectName} can write to the audit log.
 *
 * A key is a permanent commitment: it is what an indexed \`action\` column
 * holds, so renaming one orphans every historical row from the query that used
 * to find it. Add rather than rename, and delete only what was never written.
 *
 * The registry is the ONLY way to name an action. \`auditEntry\` refuses a key
 * it has not heard of, which is what stops an action from being written as a
 * string literal at a call site — an action nobody declared is invisible to
 * every audit query written against this file, and the sweep comes back
 * quietly short rather than wrong.
 */

/**
 * The admin panel's own actions.
 *
 * Three keys rather than one with the effect in metadata, because the first
 * question asked of an audit log is "who was granted what", and answering it
 * from \`action = 'permission.override.granted'\` reads an index while
 * answering it from a jsonb field reads the table.
 */
export const adminAuditedActions = {
  "permission.override.granted": {
    label: "Granted a permission to one person",
    // Sensitive, even though nothing was read. An override is how somebody
    // comes to hold access their role never gave them, so the review that asks
    // "who could have seen this data" has to start from the grants — and it
    // reads the same partial index the reads are recorded in.
    sensitive: true,
  },
  "permission.override.revoked": {
    label: "Revoked a permission from one person",
  },
  "permission.override.cleared": {
    label: "Removed an override, returning the person to their role template",
  },
} as const;

/**
 * Joining ${plural}, from both ends.
 *
 * Three keys because three different people do three different things, and an
 * incident review needs to separate them: an admin authorised the access, an
 * invitee took it up, and somebody withdrew it. One \`invitation.changed\` key
 * with the verb in metadata answers none of those without a table scan.
 *
 * Only \`invitation.accepted\` is sensitive, and the line is drawn there
 * deliberately. Sending an invitation grants nothing — it puts a hashed token
 * in a row and a link in somebody's inbox — while accepting one is the instant
 * a stranger becomes a member and the ${label}'s data becomes readable to them.
 * That is the event the "who could have seen this" review has to start from, so
 * that is the one on the partial index. Marking all three sensitive would put
 * two rows in that slice for every one that belongs there, and a slice that is
 * mostly noise is one nobody runs twice.
 *
 * The accepted row is written with the INVITEE as the actor, because they are
 * who acted. Who AUTHORISED it is a separate fact, already recorded on the
 * \`invitation.sent\` row naming the same ${label} — which is why it does not
 * have to be duplicated into the sensitive slice to stay reachable.
 */
export const invitationAuditedActions = {
  "invitation.sent": {
    label: "Invited somebody to join this ${label}",
  },
  "invitation.accepted": {
    label: "Accepted an invitation and joined this ${label}",
    sensitive: true,
  },
  "invitation.revoked": {
    label: "Revoked an invitation before it was accepted",
  },
} as const;

/**
 * The composed vocabulary.
 *
 * \`contributedBy\` re-reads the fragments rather than trusting the spread. A
 * duplicate key cannot survive an object literal — the parser keeps the last
 * one — so without this a second package claiming \`invitation.sent\` would
 * silently overwrite the label and, worse, the \`sensitive\` flag, and the row
 * would drop out of the compliance slice with nothing to show for it.
 */
export const auditedActions = {
  ${fragments.map((f) => `...${f}`).join(",\n  ")},
} as const;

export const auditRegistry = defineAuditedActions(auditedActions, {
  contributedBy: [${fragments.join(", ")}],
});

export type AuditAction = AuditActionKeyOf<typeof auditRegistry>;
`;
}


/**
 * `src/server/routers/_app.ts` for this project.
 *
 * Generated, because the routers that exist depend on what was installed. It
 * was a static file importing `./catalog` and `./checkout` unconditionally,
 * which meant a project generated with `--model none` referenced two modules
 * that were never emitted and would not compile. Nothing caught it, because the
 * only configuration anyone had generated was the full one.
 */
export function renderAppRouter(answers: Answers): string {
  const takesMoney = answers.businessModel !== "none";

  const imports = [
    'import { adminRouter } from "./admin";',
    'import { invitationsRouter } from "./invitations";',
    'import { createTRPCRouter, publicProcedure, requireTenant } from "../trpc";',
  ];
  if (answers.includeAi) imports.splice(1, 0, 'import { aiRouter } from "./ai";');
  if (takesMoney) {
    imports.splice(1, 0, 'import { accountRouter } from "./account";');
    imports.splice(2, 0, 'import { catalogRouter } from "./catalog";');
    imports.splice(3, 0, 'import { checkoutRouter } from "./checkout";');
  }

  // What the AI route cost, read back. The route itself is a plain handler —
  // a streamed response has no useful shape for tRPC to type — so this is the
  // only tRPC surface `--ai` adds, and it exists because a usage table nothing
  // reads is the error log all over again.
  const ai = answers.includeAi
    ? `
  // Spend per ${tenantLabel(answers).toLowerCase()}, summed in the database.
  // Gated on \`ai.chat.history.view\`, which is narrower than the
  // \`ai.chat.use\` the route checks: being allowed to spend money is not the
  // same capability as seeing what everybody spent.
  ai: aiRouter,
`
    : "";

  const shop = takesMoney
    ? `
  // The product builder. Staff-scoped, and mounted unconditionally alongside
  // \`admin\` for the same reason: the pages are copied source a client
  // restyles, while this router is where \`requireStaff(...)\` and the price
  // audit actually live.
  catalog: catalogRouter,

  // The public storefront and checkout. The only router here carrying \`public\`
  // procedures, deliberately — a shop nobody can browse without an account is a
  // shop nobody browses. What keeps it safe is that the amount, the currency
  // and the owning tenant are read from the catalog row, never from the
  // request.
  checkout: checkoutRouter,

  // The customer's own account. ONE PROCEDURE, because everything else the
  // account area does is a server-component read — pages read, routers mutate.
  // That one is opening the Stripe billing portal, and it is here rather than
  // in a page so the tenant rung and the audit write are somewhere the scope
  // audit can see them.
  account: accountRouter,
`
    : "";

  return `${imports.join("\n")}

/**
 * The root router for ${answers.projectName}.
 *
 * tRPC for CRUD and admin. AI, streaming and large payloads go through plain
 * route handlers instead — a streamed response has no useful shape for tRPC to
 * type, and a large upload should not be serialised through superjson.
 */
export const appRouter = createTRPCRouter({
  health: publicProcedure.meta({ scope: "public" }).query(() => ({ ok: true })),

  // Every tenant-scoped procedure goes through requireTenant, never an inline
  // check inside a handler. The rung is what the scope audit can actually see.
  members: createTRPCRouter({
    list: requireTenant("members.view")
      .meta({ scope: "tenant" })
      .query(({ ctx }) => ({ tenantId: ctx.tenantId, granted: ctx.can.toArray() })),
  }),

  // Adding a second person to a tenant. Mounted in EVERY project, because
  // tenancy is in the base package set and \`members.invite\` is in the tenant
  // catalog whatever else was installed — a project generated without
  // \`--email\` still issues invitations, it just hands the link back instead of
  // posting it. Four of its procedures are tenant-scoped; \`accept\` is one rung
  // lower, because an invitee is by definition not a member yet.
  invitations: invitationsRouter,

  // The admin panel's pages are copied source that every client restyles; this
  // router is not, and it is where the staff permission checks and the audit
  // writes actually live. Mounted even in a project generated without the admin
  // shell, so the panel can be added later without re-deriving its boundary.
  admin: adminRouter,
${ai}${shop}});

export type AppRouter = typeof appRouter;
`;
}

/**
 * `src/db/schema.ts` for this project.
 *
 * Re-exports the base tables so drizzle-kit sees ONE schema and a migration
 * covers base and app tables together. Copying a base table's definition here
 * instead would fork its migrations silently.
 */
export function renderSchemaModule(answers: Answers): string {
  const scope = answers.scope;
  // EVERY installed package that owns a table must appear here. drizzle.config
  // points drizzle-kit at this one file, so a package omitted from this list
  // has its tables silently excluded from every migration — the code compiles,
  // the app boots, and the first insert fails against a table that was never
  // created.
  const owners = ["auth", "tenancy", "permissions", "observability"];
  if (answers.businessModel !== "none") {
    owners.push("stripe", "catalog", "commerce", "billing");
  }
  if (answers.includeAi) owners.push("ai");
  if (answers.includeEmail) owners.push("email");

  /** `@scope/auth/schema` -> `authSchema`. */
  const binding = (owner: string): string => `${owner}Schema`;

  const imports = owners.map(
    (owner) => `import * as ${binding(owner)} from "${scope}/${owner}/schema";`,
  );
  const reExports = owners.map((owner) => `export * from "${scope}/${owner}/schema";`);
  const spread = owners.map((owner) => `  ...${binding(owner)},`);

  return `/**
 * ${answers.projectName} schema.
 *
 * Base tables come from the packages that own them. Do NOT copy a base table's
 * definition into this file — the package owns its migrations, and a local copy
 * forks them without anyone noticing until an upgrade fails.
 *
 * TWO SHAPES OF THE SAME THING, and both are load-bearing.
 *
 * The \`export *\` lines are what drizzle-kit reads. \`drizzle.config.ts\` points
 * it at this file and it takes every table it finds exported from it, so a
 * package missing from that list is a package missing from every migration.
 *
 * \`schema\` below is the same tables as ONE OBJECT, and it exists because
 * \`src/db/index.ts\` cannot hand drizzle this module's namespace. A module whose
 * exports are all re-exports compiles, under Turbopack, to a namespace backed
 * by a Proxy over a non-extensible target — and \`Object.keys\` on one of those
 * throws. Drizzle calls exactly that, in \`extractTablesRelationalConfig\`, the
 * moment a real DATABASE_URL means it builds the relational query API instead
 * of the unconfigured stand-in. The result was a generated project that built
 * and served perfectly with no database and failed \`next build\` outright with
 * one: \`TypeError: 'ownKeys' on proxy: trap returned extra keys but proxy
 * target is non-extensible\`, thrown from a driver, naming nothing. Spreading
 * each package's own namespace sidesteps it, because those modules export their
 * tables directly rather than passing them on.
 *
 * ADD YOUR OWN TABLES TO BOTH. The type of \`db\` is derived from this object, so
 * a table defined below and left out of it is a compile error the first time
 * you write \`db.query.yourTable\` — not a silent absence.
 */
${imports.join("\n")}

${reExports.join("\n")}

/** Every table above, as the one object \`createDb\` needs. */
export const schema = {
${spread.join("\n")}
};

// ---------------------------------------------------------------------------
// ${answers.projectName} tables go below. Use the shared column helpers so ids,
// timestamps and money follow the same rules everywhere:
//
//   import { idColumn, createdAt, updatedAt, amountMinor } from "${scope}/db";
//
// Then add each one to the \`schema\` object above.
// ---------------------------------------------------------------------------
`;
}

/**
 * One entry in a generated nav array, with the reason it is there.
 *
 * `why` is rendered as a comment above the entry in `src/nav.ts`. A generated
 * file is one nobody reviews line by line, so a link that appears in it with no
 * stated reason is a link the next person duplicates by hand somewhere else —
 * which is how a nav drifts away from the routes that actually exist.
 */
interface GeneratedLink {
  readonly href: string;
  readonly label: string;
  readonly why: string;
}

/** `// ...` lines, wrapped and indented one level into an array literal. */
function indentedComment(text: string): string {
  const lines: string[] = [];
  let current = "";
  for (const word of text.split(/\s+/)) {
    const next = current ? `${current} ${word}` : word;
    if (next.length > 72) {
      lines.push(current);
      current = word;
    } else {
      current = next;
    }
  }
  if (current) lines.push(current);
  return lines.map((line) => `  // ${line}\n`).join("");
}

/**
 * One `export const NAME: readonly SiteLink[] = [...]`.
 *
 * The empty case renders `[]` rather than a literal with a stray comma in it.
 * That case is not hypothetical: `APP_LINKS` is empty in every project
 * generated with `--admin none`, and a file that does not parse is a worse
 * failure than the dead link it was written to prevent.
 */
function renderLinkArray(
  name: string,
  doc: string,
  links: readonly GeneratedLink[],
): string {
  const body =
    links.length === 0
      ? "[]"
      : `[\n${links
          .map(
            (link) =>
              `${indentedComment(link.why)}  ` +
              `{ href: "${link.href}", label: "${link.label}" },\n`,
          )
          .join("\n")}]`;
  return `${doc}\nexport const ${name}: readonly SiteLink[] = ${body};\n`;
}

/**
 * `src/nav.ts` for this project.
 *
 * Generated for the same reason `_app.ts` is: which routes exist depends on
 * what was installed. The storefront ships in the stripe overlay and the admin
 * shell in another, so a project generated with `--model none --admin none` has
 * neither route — and a base template hardcoding either link puts a 404 in the
 * header of every page. The overlays cannot patch a link in from their side
 * either: overlays are strictly additive and the header is a base file, which
 * is exactly what `OverlayCollisionError` exists to prevent.
 *
 * The result was a shop that was live, correct and linked to by nothing: the
 * product was in the database, the storefront rendered it, and the only way to
 * reach it was to already know the URL. From the outside that is
 * indistinguishable from the shop never having been built. The Admin link was
 * the same bug pointing the other way — hardcoded into the header, so it was a
 * 404 in every project that had deliberately declined an admin panel.
 *
 * THREE ARRAYS, because there are three audiences and merging them is how the
 * bug comes back. `SITE_LINKS` is public and renders even signed out;
 * `APP_LINKS` renders only once there is a user; `FOOTER_LINKS` is the
 * secondary map that lets the header stay short without costing a route its
 * only way in.
 *
 * Emitting LISTS rather than flags is the whole point. Consumers map over them,
 * so no emitted page holds an `if` asking whether the shop or the admin panel
 * was installed, and there is no null to forget to test.
 */
export function renderSiteNav(answers: Answers): string {
  const label = tenantLabel(answers).toLowerCase();

  const site: GeneratedLink[] = [
    {
      href: "/",
      label: "Home",
      why:
        "Every project has a landing page. Not a formality: the admin sidebar " +
        'renders this list under a "Public site" heading, and a heading over ' +
        "an empty list is a defect that only shows up in the one configuration " +
        "nobody generates.",
    },
  ];

  // Every money-taking model gets the storefront, because every one of them
  // installs the stripe overlay. The one-time/subscription answer shapes what
  // is sold, not whether there is somewhere to sell it.
  if (answers.businessModel !== "none") {
    site.push({
      href: "/products",
      label: "Products",
      why:
        "The storefront, from the stripe overlay. Absent in a project that " +
        "sells nothing, which is why this list is generated rather than " +
        "written by hand.",
    });
  }

  const app: GeneratedLink[] = [
    {
      href: "/members",
      label: "Members",
      why:
        `Who is in this ${label} and who has been invited, with the invite ` +
        "form. In EVERY project, including a consumer-shaped one: tenancy is " +
        "in the base package set, a personal workspace is a tenant like any " +
        "other, and branching the nav on the tenant noun would put back the " +
        "is-there-an-organisation-yet fork that personal workspaces exist to " +
        "delete. Signed-in only, because a member list is not public.",
    },
  ];

  // The customer's own side of the line, from the account overlay. Present on
  // exactly the condition the shop is: something that can be bought needs
  // somewhere the buyer can look at it afterwards, and a project that sells
  // nothing contributes no entry — which is the generated-array pattern doing
  // the job a flag would otherwise do badly.
  //
  // IN `APP_LINKS` RATHER THAN `SITE_LINKS`, and that is not a style choice.
  // `/account` is meaningless signed out: every page under it opens by asking
  // who is calling and shows a sign-in prompt when nobody is. Advertising it to
  // a signed-out visitor from the public nav would put a link in the header
  // whose only content is "you are not signed in", next to a Sign in button
  // that says the same thing better.
  if (answers.businessModel !== "none") {
    app.push({
      href: "/account",
      label: "Your account",
      why:
        "Orders, licence keys, allowances and billing — the read half of " +
        "everything `fulfilPurchase` writes. It was the gap: a person could " +
        "buy something and had nowhere at all to see it afterwards, because " +
        "the only reader in the project was keyed on a reference in the URL " +
        "Stripe returned them to.",
    });
  }

  // `app/admin` ships in the admin-minimal overlay and admin-full layers on top
  // of it, so anything other than "none" means the route exists. With "none"
  // this array stays empty and the header renders nothing — no flag, no null,
  // and nothing in the header that has to know an admin panel is a thing.
  if (answers.adminShell !== "none") {
    app.push({
      href: "/admin",
      label: "Admin",
      why:
        "The admin shell, from the admin overlay. Not permission-filtered: " +
        "reaching it without a staff role renders AdminUnavailable, which " +
        "says so, and hiding the link would mean loading the permission set " +
        "on every page view to decide whether to draw it.",
    });
  }

  const footer: GeneratedLink[] = [
    {
      href: "/setup",
      label: "Setup",
      why:
        "Which credentials are set, and what each missing one switches off. " +
        "In every project. In the footer rather than the header because it is " +
        "a diagnostics page and not somewhere a customer goes, but it has to " +
        "be reachable from everywhere: whoever needs it has just hit a page " +
        "that did not work, and that page is rarely the landing page.",
    },
    {
      href: "/sign-up",
      label: "Create an account",
      why:
        "The Clerk catch-all route, which every project has. The header " +
        "offers Sign in and nothing offers this — Clerk renders its own " +
        "sign-up link inside its card, but only once it is configured, so " +
        "until then the route exists with nothing at all pointing at it.",
    },
  ];

  // Only in a project that installed the mail package: the page it points at
  // ships in the email overlay and does not exist otherwise. Beside /setup for
  // the same reason /setup is here — it is a diagnostics surface rather than
  // somewhere a customer goes, and it has to be reachable from wherever
  // somebody has just noticed that a message read wrong.
  if (answers.includeEmail) {
    footer.push({
      href: "/setup/email",
      label: "Email templates",
      why:
        "Every message this project can send, rendered from sample data. An " +
        "email template is the one piece of UI with no way to look at it — the " +
        "loop is otherwise edit, deploy, invite somebody, wait — so without a " +
        "link nobody finds the page and the copy stays as it was first written.",
    });
  }

  // Nothing else in a generated project earns a footer entry, and inventing one
  // would be worse than leaving it out. /checkout means nothing without a
  // product in its query string, /checkout/success is reached by redirect after
  // a payment, a product page needs a slug, /sign-in is already the header's
  // signed-out affordance, /admin belongs to APP_LINKS and would be advertised
  // to signed-out visitors from here — and there are no legal or social pages
  // because this scaffold does not generate any.

  const arrays = [
    renderLinkArray(
      "SITE_LINKS",
      "/** Public top-level destinations, in nav order. */",
      site,
    ),
    renderLinkArray(
      "APP_LINKS",
      [
        "/**",
        " * Destinations for a signed-in user, in nav order.",
        " *",
        " * Rendered only once there is a user, so nobody signed out is shown a link",
        " * they cannot follow. What is IN it still depends on what was installed —",
        " * a project generated without an admin shell contributes no Admin entry —",
        " * and the header maps over whatever is here rather than asking whether a",
        " * panel exists.",
        " */",
      ].join("\n"),
      app,
    ),
    renderLinkArray(
      "FOOTER_LINKS",
      [
        "/**",
        " * Secondary destinations, in footer order.",
        " *",
        " * Reachable from every page and deliberately out of the header. The primary",
        " * nav stays short enough to read at a glance; everything else a visitor can",
        " * legitimately open lives down here, so keeping the header tidy never costs",
        " * a route its only way in.",
        " */",
      ].join("\n"),
      footer,
    ),
  ];

  return `/**
 * Where the parts of ${answers.projectName} are.
 *
 * Generated from the answers this project was created with, and that is the
 * only way it can be correct: a link to a route the project never installed is
 * a 404 in the header of every page, and a route installed with nothing linking
 * to it is a feature nobody can find.
 *
 * Map over these. There is no flag here and no null — a feature that was not
 * installed contributes no entry, and whatever is left is the nav. Add your own
 * routes as you build them, to the array whose audience matches: SITE_LINKS is
 * seen by everyone including signed-out visitors, APP_LINKS only once somebody
 * is signed in, FOOTER_LINKS by everyone but out of the way. Anything that
 * depends on which permissions the viewer holds belongs in a permission-
 * filtered nav instead, next to the pages it gates.
 */
export interface SiteLink {
  readonly href: string;
  readonly label: string;
}

${arrays.join("\n")}`;
}

/**
 * One item in the generated admin sidebar, with the reason it is there.
 *
 * Separate from `GeneratedLink` because a sidebar item carries a permission and
 * a nav link does not: `SITE_LINKS` is public and `APP_LINKS` needs only a
 * signed-in user, whereas everything in the admin shell is gated on a key the
 * server has already resolved. Merging the two shapes would put an optional
 * `permission` on every public link, which is an invitation to leave it off.
 */
interface GeneratedNavItem {
  readonly href: string;
  readonly label: string;
  /** A key from the STAFF catalog. Without it the item is not rendered. */
  readonly permission: string;
  readonly why: string;
}

interface GeneratedNavGroup {
  readonly heading: string;
  readonly items: readonly GeneratedNavItem[];
}

/**
 * One `{ heading, items: [...] }` literal, each item under its reason.
 *
 * Indented two levels deeper than `renderLinkArray`'s output because these sit
 * inside a group rather than at the top of an array, and a generated file whose
 * comments do not line up with the code they describe is one people stop
 * reading.
 */
function renderNavGroup(group: GeneratedNavGroup): string {
  const items = group.items
    .map(
      (item) =>
        indentedComment(item.why)
          .split("\n")
          .map((line) => (line.length > 0 ? `    ${line}` : line))
          .join("\n") +
        `      { href: "${item.href}", label: "${item.label}", permission: "${item.permission}" },\n`,
    )
    .join("\n");

  return `  {
    heading: "${group.heading}",
    items: [
${items}    ],
  },`;
}

/**
 * `src/components/admin/AdminNav.tsx` for this project.
 *
 * GENERATED, and it had to become generated for the reason `src/nav.ts` already
 * is: which admin routes exist depends on the answers, and a sidebar written by
 * hand inside one overlay cannot see the others. `admin-minimal` ships /admin,
 * /admin/audit and /admin/tenants; `admin-full` layers /admin/people,
 * /admin/roles, /admin/errors and /admin/support on top; `catalog-admin`
 * contributes /admin/products only when the project sells something. No single
 * hardcoded list is right for all of those, and the list that was hardcoded was
 * wrong in both directions at once.
 *
 * IT ARGUED ITSELF INTO THE FIRST FAULT. The claim was that every item is
 * permission-gated, so an item whose page ships in a different overlay hides
 * itself. That is true of `catalog.products.view`, which exists only once the
 * catalog package is installed. It is FALSE of `staff.people.view` and
 * `staff.roles.view`, which `renderPermissionsCatalog` writes into every
 * project unconditionally and `seed-roles.ts` grants to `admin` and `cs_lead`.
 * A seeded administrator on an `--admin minimal` project therefore saw People
 * and Roles & permissions in the sidebar and got a 404 from both.
 *
 * AND THE DEFENCE AGAINST IT CAUSED THE SECOND. Leaving /admin/errors and
 * /admin/support out entirely — because neither has a permission key that could
 * hide them on a minimal shell — stranded two real pages in every `--admin full`
 * project: they build, they serve, and nothing anywhere links to them.
 *
 * Both faults are the same missing distinction. WHICH ITEMS EXIST is a fact
 * about how the project was generated, and is settled here. WHO SEES THEM is a
 * fact about one viewer at one moment, and is settled at runtime by the filter
 * below. Neither substitutes for the other.
 */
export function renderAdminNav(answers: Answers): string {
  const plural = tenantLabelPlural(answers);
  const sells = answers.businessModel !== "none";
  const full = answers.adminShell === "full";

  const groups: GeneratedNavGroup[] = [
    {
      heading: "Overview",
      items: [
        {
          href: "/admin",
          label: "Dashboard",
          permission: "staff.dashboard.view",
          why:
            "The shell's own index, generated beside this file. Present " +
            "wherever an admin panel is, which is the only circumstance in " +
            "which either of them is written at all.",
        },
        {
          href: "/admin/access",
          label: "Your access",
          permission: "staff.dashboard.view",
          why:
            "The resolved staff permission set for whoever is signed in, from " +
            "admin-minimal. It used to BE the dashboard, which is why it needs " +
            "an entry now: a page nothing links to is a page nobody finds, and " +
            "this is the one that settles \"why can they do that\" during a " +
            "support call. On the shell's own key rather than a key of its own, " +
            "because it shows the viewer nothing they are not already holding.",
        },
      ],
    },
  ];

  // The product builder lives in `catalog-admin`, which is copied only when the
  // project sells something AND asked for a shell to put it in. Absence here is
  // that overlay not having been copied — not a key nobody happens to hold.
  if (sells) {
    groups.push({
      heading: "Catalog",
      items: [
        {
          href: "/admin/products",
          label: "Products",
          permission: "catalog.products.view",
          why:
            "The product builder, from the catalog-admin overlay. The key is " +
            "contributed by the catalog package, so a project without a shop " +
            "has neither the page nor the permission — but what keeps this " +
            "entry out of one is the overlay that was not copied.",
        },
      ],
    });
  }

  const accounts: GeneratedNavItem[] = [
    {
      href: "/admin/tenants",
      label: plural,
      permission: "staff.tenants.view",
      why:
        `Every customer ${tenantLabel(answers).toLowerCase()} the firm can ` +
        "see, from the admin-minimal overlay. Tenancy is in the base package " +
        "set, so this route exists wherever the shell does.",
    },
  ];

  if (full) {
    accounts.push(
      {
        href: "/admin/people",
        label: "People",
        permission: "staff.people.view",
        why:
          "admin-full only. `staff.people.view` is declared and seeded in " +
          "EVERY project, so this entry cannot be left to the permission " +
          "filter: on a minimal shell a seeded administrator holds the key " +
          "and the page is not there. That was the 404.",
      },
      {
        href: "/admin/support",
        label: "Support",
        permission: "staff.dashboard.view",
        why:
          "admin-full only, and a placeholder on purpose — the scaffold ships " +
          "no ticket model because every business already has one. Gated on " +
          "the key that says you may use this shell rather than on a key of " +
          "its own: the page enforces nothing, and declaring " +
          '"staff.support.view" here would advertise a control that does not ' +
          "exist. Give it a real key when you give it a real queue.",
      },
    );
  }

  groups.push({ heading: "Accounts", items: accounts });

  const governance: GeneratedNavItem[] = [];

  if (full) {
    governance.push({
      href: "/admin/roles",
      label: "Roles & permissions",
      permission: "staff.roles.view",
      why:
        "admin-full only, and the same trap as People: `staff.roles.view` is " +
        "seeded in every project, so the permission filter on its own would " +
        "put this link in a minimal shell with no page behind it.",
    });
  }

  governance.push({
    href: "/admin/audit",
    label: "Audit log",
    permission: "staff.audit.view",
    why:
      "admin-minimal, so it is in every shell. Who did what, including the " +
      "sensitive-access rows impersonation writes.",
  });

  if (full) {
    governance.push({
      href: "/admin/errors",
      label: "Errors",
      permission: "staff.audit.view",
      why:
        "admin-full only. Beside the audit log and on the SAME key, which is " +
        "what the page itself checks: a stack trace routinely carries " +
        "customer data, so reading one is the audit privilege rather than a " +
        "lesser one. Until the sidebar was generated this page had no entry " +
        "anywhere, and the only way to reach it was to know the URL.",
    });
  }

  groups.push({ heading: "Governance", items: governance });

  return `"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { SITE_LINKS } from "@/nav";

/**
 * The admin sidebar for ${answers.projectName}.
 *
 * GENERATED FROM THE ANSWERS THIS PROJECT WAS CREATED WITH, exactly like
 * \`src/nav.ts\` and for the same reason: which admin routes exist is a fact
 * about how the project was generated, and a hand-written list cannot see it.
 * A minimal shell has no /admin/people and no /admin/roles; a full one has
 * both; /admin/products arrives only with a catalog. One list covering every
 * case is a 404 in the sidebar of the smaller projects and an unreachable page
 * in the larger ones.
 *
 * WHICH ITEMS EXIST was decided when this file was written. WHO SEES THEM is
 * decided below, on every render, from the permission set the server resolved.
 * Both are load-bearing and neither replaces the other — a permission key can
 * be declared in a project whose pages were never copied in, which is exactly
 * how People and Roles & permissions came to point at nothing.
 *
 * \`granted\` is the server's answer, passed down; the client never re-derives it
 * from role templates. That is deliberate: askLou's client hook preferred
 * custom role permissions while ~20 of its routers ignored them, so the UI and
 * the server disagreed by construction. One resolver, one answer, and the
 * browser is only ever told the result.
 *
 * THIS FILE IS YOURS NOW. It was written once, at generation, and nothing
 * rewrites it — so a section you add here stays added.
 */
export interface AdminNavProps {
  readonly granted: readonly string[];
}

interface NavItem {
  readonly href: string;
  readonly label: string;
  /** Hidden unless the viewer holds this. */
  readonly permission: string;
}

interface NavGroup {
  readonly heading: string;
  readonly items: readonly NavItem[];
}

/**
 * Grouped, and the grouping is the point: a flat list of eight links makes
 * every section look equally likely, and the two people actually use — the
 * dashboard and whatever they came to change — get no more weight than the
 * audit log.
 */
const GROUPS: readonly NavGroup[] = [
${groups.map(renderNavGroup).join("\n")}
];

export function AdminNav({ granted }: AdminNavProps) {
  const pathname = usePathname();
  const allowed = new Set(granted);

  const visible = GROUPS.map((group) => ({
    ...group,
    items: group.items.filter((item) => allowed.has(item.permission)),
  })).filter((group) => group.items.length > 0);

  return (
    <nav aria-label="Admin" className="flex-1 overflow-y-auto px-2 py-3">
      {visible.map((group) => (
        <div key={group.heading} className="mb-4 last:mb-0">
          <p className="px-2 pb-1 text-[10px] font-medium uppercase tracking-wider text-ink-muted">
            {group.heading}
          </p>
          <ul>
            {group.items.map((item) => {
              // Exact match only. A \`startsWith\` test lights up "Dashboard" on
              // every page, because every admin route begins with /admin.
              const active = pathname === item.href;
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    aria-current={active ? "page" : undefined}
                    className={
                      active
                        ? "block rounded-[--radius-card] bg-accent-soft px-2 py-1.5 text-sm font-medium text-accent no-underline"
                        : "block rounded-[--radius-card] px-2 py-1.5 text-sm text-ink-muted no-underline hover:bg-canvas hover:text-ink"
                    }
                  >
                    {item.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}

      {visible.length === 0 && (
        <p className="px-2 text-[13px] text-ink-muted">
          You have staff access but no sections have been granted yet. Someone
          holding <code className="font-mono">staff.roles.manage</code> can grant
          them on the Roles page.
        </p>
      )}

      {/*
        The way out, and deliberately not another group.

        A staff user who has just created a product needs to look at it, and
        until this existed there was no route from the admin to the thing the
        admin edits — you had to know the URL. It sits under a rule rather than
        inside the list above because it is a different KIND of destination:
        everything above is a page in this shell, everything here is the public
        site, which the person reading is not the audience for.

        Driven by SITE_LINKS, which is generated from the same answers as the
        groups above and carries a shop entry only in a project that has a shop.
        No emptiness check either — every project has a public home page, so the
        array always has something in it.
      */}
      <div className="mt-4 border-t border-line pt-3">
        <p className="px-2 pb-1 text-[10px] font-medium uppercase tracking-wider text-ink-muted">
          Public site
        </p>
        <ul>
          {SITE_LINKS.map((link) => (
            <li key={link.href}>
              {/* A plain <a>, not next/link: a new tab opens a fresh document
                  either way, so Link would add a prefetch of a page this tab
                  never shows. New tab because the admin is a working context —
                  a half-filled form, a filtered list — and checking the public
                  page should not cost you the place you were in. */}
              <a
                href={link.href}
                target="_blank"
                rel="noreferrer"
                className="flex items-center gap-1 rounded-[--radius-card] px-2 py-1.5 text-sm text-ink-muted no-underline hover:bg-canvas hover:text-ink"
              >
                {link.label}
                <span aria-hidden="true">↗</span>
                <span className="sr-only">(opens in a new tab)</span>
              </a>
            </li>
          ))}
        </ul>
      </div>
    </nav>
  );
}
`;
}

/**
 * `app/admin/page.tsx` for this project.
 *
 * GENERATED, for the reason `src/components/admin/AdminNav.tsx` is: which
 * panels can exist is a fact about how the project was generated, and no single
 * hand-written file is right for all of them. A dashboard shipped inside
 * `admin-minimal` cannot import the commerce schema — a project generated with
 * `--model none` never installs that package, so the file would not compile —
 * and a dashboard that asked at runtime whether commerce was installed would be
 * exactly the conditional the artifact is forbidden to carry. Absence here is a
 * query that was never written.
 *
 * WHAT IT REPLACED: "Signed in as", and eighteen permission chips. That is a
 * debug view, and it was the first thing every client saw. It answers a real
 * support question and it answers nothing an operator opens a panel to find
 * out, so it has moved to /admin/access intact and this page now carries the
 * queues.
 *
 * EVERY NUMBER IS A COUNT OF ROWS THIS PROJECT ACTUALLY WRITES. No MRR, no
 * churn, no ARPU, no invented trend percentage beside a figure. The firm ships
 * to clients in different businesses and not one of those means the same thing
 * twice; a generated dashboard full of them is a screenshot in somebody's board
 * deck within the week. That refusal is the one the old page made and it
 * survives — what changes is that the alternative is no longer a list of
 * permission keys.
 *
 * IT READS `db` DIRECTLY, unlike /admin/audit which goes through the tRPC
 * caller. Deliberate and narrow: the counts span four packages, routing them
 * would mean generating a router as well, every one of them is gated
 * immediately above the query by the same key a rung would have checked, and
 * nothing here writes. Anything that writes still goes through a procedure.
 */
export function renderAdminDashboard(answers: Answers): string {
  const scope = answers.scope;
  const sells = answers.businessModel !== "none";
  const full = answers.adminShell === "full";
  const plural = tenantLabelPlural(answers);
  const lower = tenantLabel(answers).toLowerCase();
  const lowerPlural = tenantLabelPlural(answers).toLowerCase();

  // Every import the panels below need, and none that a panel which was not
  // written would need. A missing import fails the build; an unused one fails
  // lint in any project that turns the rule on — so the list is assembled from
  // the same conditions the panels are.
  const drizzle = sells
    ? "and, count, eq, gte, inArray, isNull, like, ne, not, sum"
    : "and, count, isNull, ne";

  const imports = [
    `import Link from "next/link";`,
    `import { ${drizzle} } from "drizzle-orm";`,
    `import { users } from "${scope}/auth/schema";`,
    `import { isDbConfigured } from "${scope}/db";`,
    `import { errorLog } from "${scope}/observability/schema";`,
    `import { tenantInvitations, tenants } from "${scope}/tenancy/schema";`,
  ];
  if (sells) {
    imports.push(
      `import { formatMinor } from "${scope}/catalog";`,
      `import { products } from "${scope}/catalog/schema";`,
      `import { orders, orderShipments } from "${scope}/commerce/schema";`,
    );
  }
  imports.push(
    `import {`,
    `  Card,`,
    `  CardBody,`,
    `  EmptyState,`,
    `  Notice,`,
    `  PageHeader,`,
    `} from "@/components/ui";`,
    `import { db } from "@/db";`,
    `import { currentPrincipal } from "@/server/auth";`,
  );
  if (sells) {
    // The prefix every fulfilment idempotency key starts with. Imported rather
    // than retyped: "was this actually paid for" is a string match, and a copy
    // of that string here would be a second place the answer lives.
    imports.push(`import { FULFILMENT_KEY_PREFIX } from "@/server/fulfilment";`);
  }
  imports.push(`import { loadStaffPermissions } from "@/server/permissions";`);

  const queries: string[] = [
    `    // Unresolved errors. The partial index \`error_log_unresolved_idx\` exists
    // for exactly this count, and it is the one number here that means
    // "somebody has to do something today".
    counted(can.can("staff.audit.view"), async () =>
      rows(
        await db
          .select({ n: count() })
          .from(errorLog)
          .where(isNull(errorLog.resolvedAt)),
      ),
    ),`,
    `    // Invitations nobody has accepted or withdrawn. Expired ones are counted
    // too, on purpose: an invitation that quietly timed out is still a person
    // waiting to be let in, and it is the case nobody notices.
    counted(can.can("staff.tenants.view"), async () =>
      rows(
        await db
          .select({ n: count() })
          .from(tenantInvitations)
          .where(
            and(
              isNull(tenantInvitations.acceptedAt),
              isNull(tenantInvitations.revokedAt),
            ),
          ),
      ),
    ),`,
    `    // Customer ${lowerPlural} only. A personal workspace is minted for every
    // signed-in user and they outnumber real customers by an order of
    // magnitude, so counting them would make this a sign-up counter wearing the
    // wrong label.
    counted(can.can("staff.tenants.view"), async () =>
      rows(
        await db
          .select({ n: count() })
          .from(tenants)
          .where(ne(tenants.kind, "personal")),
      ),
    ),`,
    `    // People, excluding soft-deleted rows. A deleted user keeps their row
    // because their audit history references it; counting them would make this
    // number one that only ever goes up.
    counted(can.can("staff.people.view"), async () =>
      rows(
        await db
          .select({ n: count() })
          .from(users)
          .where(isNull(users.deletedAt)),
      ),
    ),`,
  ];

  if (sells) {
    queries.push(
      `    // Shipments booked and not despatched. A NULL \`shipped_at\` means the row
    // exists so the warehouse has something to pick up, not that anything has
    // moved — which is precisely the queue.
    counted(can.can("catalog.products.view"), async () =>
      rows(
        await db
          .select({ n: count() })
          .from(orderShipments)
          .where(isNull(orderShipments.shippedAt)),
      ),
    ),`,
      `    // Orders paid for in the window, simulated ones excluded.
    counted(can.can("catalog.products.view"), async () =>
      rows(
        await db
          .select({ n: count() })
          .from(orders)
          .where(and(paidInWindow(since), not(wasSimulated()))),
      ),
    ),`,
      `    // Orders recorded with no payment behind them — all time, not the
    // window. This should be zero on the day payments go live, and only an
    // all-time count can still say so a month later.
    counted(can.can("catalog.products.view"), async () =>
      rows(
        await db
          .select({ n: count() })
          .from(orders)
          .where(wasSimulated()),
      ),
    ),`,
      `    // Products a customer can buy right now. Drafts and archived rows are
    // deliberately not folded in — "12 products" over a storefront showing
    // three is the kind of number that gets believed.
    counted(can.can("catalog.products.view"), async () =>
      rows(
        await db
          .select({ n: count() })
          .from(products)
          .where(and(eq(products.status, "active"), isNull(products.deletedAt))),
      ),
    ),`,
    );
  }

  const destructure = sells
    ? `  const [
    unresolvedErrors,
    openInvitations,
    customerTenants,
    peopleCount,
    awaitingDespatch,
    paidOrders,
    simulatedOrders,
    activeProducts,
  ] = await Promise.all([`
    : `  const [unresolvedErrors, openInvitations, customerTenants, peopleCount] =
    await Promise.all([`;

  const windowConstant = sells
    ? `
/** The window every "recently" on this page means. */
const WINDOW_DAYS = 30;
`
    : "";

  const sinceLine = sells
    ? `  const since = new Date(Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000);

`
    : "";

  const revenueRead = sells
    ? `
  /**
   * Takings in the window, one row per currency.
   *
   * NOT a single total. Summing 1000 JPY and 1000 GBP produces 2000 of nothing,
   * and it would look entirely plausible on the way to a board meeting.
   * Simulated orders are excluded here as well as counted separately: money
   * that never moved must not appear in a revenue figure at all.
   */
  const takings = can.can("catalog.products.view")
    ? await db
        .select({
          currency: orders.currency,
          // A \`sum\` over a bigint column comes back as a numeric string, or
          // NULL for an empty group. Parsed back to bigint rather than to a
          // number, because minor units are exact and a float is not.
          totalMinor: sum(orders.totalMinor),
        })
        .from(orders)
        .where(and(paidInWindow(since), not(wasSimulated())))
        .groupBy(orders.currency)
    : [];
`
    : "";

  const attentionTiles: string[] = [
    `    tile({
      label: "Errors to triage",
      value: unresolvedErrors,
      permission: "staff.audit.view",
      hint: "Unresolved rows in error_log, deduplicated by fingerprint.",${
        full ? '\n      href: "/admin/errors",' : ""
      }
    }),`,
  ];
  if (sells) {
    attentionTiles.push(`    tile({
      label: "Awaiting despatch",
      value: awaitingDespatch,
      permission: "catalog.products.view",
      hint: "Shipments a purchase booked and nobody has handed to a carrier.",
    }),`);
  }
  attentionTiles.push(`    tile({
      label: "Open invitations",
      value: openInvitations,
      permission: "staff.tenants.view",
      hint: "Sent, not accepted, not withdrawn. Expired ones are included.",
    }),`);

  const activityTiles: string[] = sells
    ? [
        `    tile({
      label: "Orders",
      value: paidOrders,
      permission: "catalog.products.view",
      hint: "Paid or fulfilled in the window. Refunds and cancellations are not counted.",
    }),`,
        `    tile({
      label: "Simulated orders",
      value: simulatedOrders,
      permission: "catalog.products.view",
      hint: "All time. Booked with no payment while Stripe is unconfigured.",
      href: "/admin/audit?sensitive=1",
    }),`,
      ]
    : [];

  const shapeTiles: string[] = [
    `    tile({
      label: "${plural}",
      value: customerTenants,
      permission: "staff.tenants.view",
      hint: "Customer ${lowerPlural}. Personal workspaces are not counted.",
      href: "/admin/tenants",
    }),`,
    `    tile({
      label: "People",
      value: peopleCount,
      permission: "staff.people.view",
      hint: "Signed-in users, excluding soft-deleted rows.",${
        full ? '\n      href: "/admin/people",' : ""
      }
    }),`,
  ];
  if (sells) {
    shapeTiles.push(`    tile({
      label: "Products for sale",
      value: activeProducts,
      permission: "catalog.products.view",
      hint: "Active and not deleted — exactly what the storefront lists.",
      href: "/admin/products",
    }),`);
  }

  const activitySection = sells
    ? `
      <section className="mt-6">
        <h2 className="mb-2 text-[11px] font-medium uppercase tracking-wider text-ink-muted">
          Last {WINDOW_DAYS} days
        </h2>
        <TileGrid tiles={activity} />
      </section>
`
    : "";

  const takingsPanel = sells
    ? `
      {takings.length > 0 && (
        <section className="mt-6">
          <h2 className="mb-2 text-[11px] font-medium uppercase tracking-wider text-ink-muted">
            Taken in the last {WINDOW_DAYS} days
          </h2>
          <Card>
            <CardBody className="flex flex-wrap gap-6">
              {takings.map((row) => (
                <p
                  key={row.currency}
                  className="text-2xl font-semibold tabular-nums text-ink"
                >
                  {/* formatMinor, never a division by 100. JPY has no minor
                      unit, so dividing renders 1,000 yen as 10 — a hundredfold
                      error that still looks like a plausible amount. */}
                  {formatMinor(BigInt(row.totalMinor ?? "0"), row.currency)}
                </p>
              ))}
            </CardBody>
          </Card>
        </section>
      )}
`
    : "";

  const simulatedBanner = sells
    ? `simulatedOrders !== null && simulatedOrders > 0 ? (
        <Notice
          tone="warn"
          title={
            simulatedOrders +
            (simulatedOrders === 1 ? " order was" : " orders were") +
            " recorded without a payment"
          }
        >
          The simulated checkout books a real order and applies every grant with
          no money moving. It exists only while{" "}
          <code className="font-mono">STRIPE_SECRET_KEY</code> is unset, and is
          refused outright on a production deployment — so this number should
          reach zero and stay there once payments are live.{" "}
          <Link
            href="/admin/audit?sensitive=1"
            className="text-accent underline underline-offset-2"
          >
            Every one of them is in the audit log
          </Link>
          .
        </Notice>
      ) : null`
    : "null";

  const seedHint = sells
    ? `a ${lower}, five people, an audit trail, an error queue and a small shop`
    : `a ${lower}, five people, an audit trail and an error queue`;

  const helpers = sells
    ? `
/**
 * Money that actually arrived, in the window.
 *
 * \`fulfilled\` is the same money one step later, so it counts. \`refunded\` and
 * \`cancelled\` do not, and \`pending\` least of all — a bank debit that has not
 * cleared is not takings.
 */
function paidInWindow(since: Date) {
  return and(
    inArray(orders.status, ["paid", "fulfilled"]),
    gte(orders.placedAt, since),
  );
}

/**
 * Was this order booked without a payment?
 *
 * Read off \`idempotency_key\`, which is \`fulfilment:\` followed by the
 * reference, and a simulated reference always begins \`sim_\`. NOT off a NULL
 * \`stripe_payment_intent_id\`: that is also NULL for a real Checkout order
 * whose PaymentIntent has not been attached yet, so it would report genuine
 * takings as simulated for as long as a webhook is in flight.
 *
 * The pattern stops at \`sim\` rather than \`sim_\` because \`_\` is a
 * single-character wildcard in LIKE and would need escaping to mean itself. A
 * Stripe reference begins \`pi_\`, so there is nothing here to collide with.
 */
function wasSimulated() {
  return like(orders.idempotencyKey, FULFILMENT_KEY_PREFIX + "sim%");
}
`
    : "";

  return `${imports.join("\n")}

/**
 * The first screen somebody opens in the morning.
 *
 * GENERATED FROM THE ANSWERS THIS PROJECT WAS CREATED WITH, exactly like
 * \`src/nav.ts\` and \`src/components/admin/AdminNav.tsx\`, and for the same
 * reason: a panel that counts orders cannot exist in a project with no orders
 * table, and asking at runtime whether one was installed is the conditional
 * this scaffold refuses to emit. What is absent here is a query that was never
 * written, not a feature switched off.
 *
 * WHAT IT IS NOT. No MRR tile, no churn, no ARPU, no trend percentage. This
 * shell ships to businesses that do not resemble each other, and a number whose
 * definition was guessed is worse than no number, because it gets screenshotted
 * into a board deck. Every figure below is a count of rows this application
 * writes and each one names the table it came from.
 *
 * WHAT IT IS. Three questions in the order an operator asks them — what needs
 * doing, what happened, how big is this thing — with every number that has
 * somewhere to go rendered as a link to the page that manages the thing it
 * counts. A tile you cannot click is a fact; a tile you can click is a task.
 *
 * ZERO IS A REAL ANSWER AND READS AS ONE. On a project generated this morning
 * every number here is 0, which is correct and looks exactly like a page that
 * failed to load — so when nothing has happened at all, this says so in words
 * and names the command that changes it.
 *
 * PERMISSIONS ARE VISIBLE RATHER THAN INVISIBLE. A viewer who does not hold a
 * key sees the tile with the key printed where the number would be, and the
 * query behind it never runs. Hiding the tile would be tidier and would also
 * mean nobody ever discovers that a permission is the reason — which is the
 * support question this panel should be answering rather than generating.
 *
 * THIS FILE IS YOURS NOW. It was written once, at generation, and nothing
 * rewrites it.
 */
export const dynamic = "force-dynamic";
${windowConstant}
interface TileProps {
  readonly label: string;
  /** NULL means "you may not see this". It never means zero. */
  readonly value: number | null;
  readonly hint: string;
  readonly permission: string;
  readonly href?: string;
}

export default async function AdminDashboard() {
  const principal = await currentPrincipal();
  const can = principal ? await loadStaffPermissions({ principal }) : null;

  // Gated again here rather than relying on the layout: a page can be rendered
  // by a route that does not sit under this layout, and "the parent checked" is
  // not a property the type system enforces.
  if (!can) {
    return (
      <>
        <PageHeader title="Dashboard" />
        <Notice tone="warn">
          You are signed in but hold no staff role, so there is nothing here to
          count.
        </Notice>
      </>
    );
  }

  // Asked before anything queries, exactly as every other admin page asks it.
  // Catching the throw instead cannot work — a caller wraps it and the name
  // does not survive — and this page would 500 on a project with no
  // credentials at all.
  if (!isDbConfigured(db)) {
    return (
      <>
        <PageHeader title="Dashboard" />
        <Notice tone="warn" title="DATABASE_URL is not set">
          Every number on this page is a count of rows in Postgres, and this
          deployment has no connection to one. Add the variable to{" "}
          <code className="font-mono">.env.local</code> and restart —{" "}
          <Link href="/setup" className="text-accent underline underline-offset-2">
            /setup
          </Link>{" "}
          lists what else is outstanding.
        </Notice>
      </>
    );
  }

${sinceLine}  // ONE ROUND OF QUERIES for the whole screen. Each is a count over an indexed
  // predicate, none depends on another, and issuing them in sequence would make
  // the panel's first page its slowest.
${destructure}
${queries.join("\n")}
  ]);
${revenueRead}
  const attention: readonly TileProps[] = [
${attentionTiles.join("\n")}
  ];

  const activity: readonly TileProps[] = [
${activityTiles.join("\n")}
  ];

  const shape: readonly TileProps[] = [
${shapeTiles.join("\n")}
  ];

  // Every number THIS viewer is allowed to see. Withheld ones are excluded
  // rather than counted as zero: telling somebody that nothing has happened
  // when they simply cannot see what happened is a lie with a friendly tone.
  const visible = [...attention, ...activity, ...shape]
    .map((entry) => entry.value)
    .filter((value): value is number => value !== null);
  const nothingHasHappened =
    visible.length > 0 && visible.every((value) => value === 0);

  return (
    <>
      <PageHeader
        title="Dashboard"
        description="Counts of rows this application writes. Copied source — replace it with whatever this business opens first in the morning."
      />

      {/*
        ONE BANNER, CHOSEN BY STATE, never two stacked. Two banners is how a
        page teaches people to scroll past the one that mattered.
      */}
      {nothingHasHappened ? (
        <EmptyState title="Nothing has happened here yet">
          Every number below is real and every one of them is zero, which on a
          project this new is the correct answer rather than a broken page. Run{" "}
          <code className="font-mono">pnpm db:seed:demo</code> to put ${seedHint}{" "}
          behind them.
        </EmptyState>
      ) : (
        ${simulatedBanner}
      )}

      <section className="mt-6">
        <h2 className="mb-2 text-[11px] font-medium uppercase tracking-wider text-ink-muted">
          Needs attention
        </h2>
        <TileGrid tiles={attention} />
      </section>
${activitySection}${takingsPanel}
      <section className="mt-6">
        <h2 className="mb-2 text-[11px] font-medium uppercase tracking-wider text-ink-muted">
          What is here
        </h2>
        <TileGrid tiles={shape} />
      </section>
    </>
  );
}

/**
 * Run a count, or decline to.
 *
 * The query does NOT run when the viewer may not see the answer. That is the
 * difference between a permission and a display rule: a permission that only
 * hides the rendering still reads the rows, and the first person to open a
 * network trace finds the number anyway.
 */
async function counted(
  allowed: boolean,
  run: () => Promise<number>,
): Promise<number | null> {
  return allowed ? await run() : null;
}

/** \`select count(*)\` returns one row, and \`noUncheckedIndexedAccess\` is on. */
function rows(result: readonly { readonly n: number }[]): number {
  return result[0]?.n ?? 0;
}
${helpers}
function TileGrid({ tiles }: { readonly tiles: readonly TileProps[] }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {tiles.map((entry) => (
        <Tile key={entry.label} {...entry} />
      ))}
    </div>
  );
}

/**
 * One number, or the reason it is not there.
 *
 * A withheld tile keeps its position and names the key it needs. Dropping it
 * from the grid would look cleaner and would leave the viewer no way to
 * discover that a permission is why — which is exactly the ticket this panel
 * should be answering rather than generating.
 */
function Tile({ label, value, hint, permission, href }: TileProps) {
  const figure = (
    <p className="text-2xl font-semibold tabular-nums text-ink">
      {value === null ? "\\u2014" : value.toLocaleString()}
    </p>
  );

  return (
    <Card>
      <CardBody>
        <p className="text-[11px] font-medium uppercase tracking-wider text-ink-muted">
          {label}
        </p>
        {href && value !== null ? (
          <Link href={href} className="block no-underline hover:text-accent">
            {figure}
          </Link>
        ) : (
          figure
        )}
        <p className="mt-1 text-xs text-ink-muted">
          {value === null ? (
            <>
              Hidden — you do not hold{" "}
              <code className="font-mono">{permission}</code>
            </>
          ) : (
            hint
          )}
        </p>
      </CardBody>
    </Card>
  );
}

/** Named so the arrays above read as a list of tiles rather than of objects. */
function tile(props: TileProps): TileProps {
  return props;
}
`;
}

/**
 * `app/(site)/page.tsx` for this project.
 *
 * A static landing page could not mention the shop. `/products` only exists
 * once the stripe overlay is selected, so the base template hardcoding it would
 * 404 for every project generated with `--model none` — and the overlay is
 * forbidden from rewriting a base file to add it. Generating the page is the
 * same answer `_app.ts` reached for the same reason.
 *
 * It renders no header of its own. It used to mount `<AuthHeader />` directly,
 * which was the only reason any page had a nav at all — and therefore the
 * reason every other route had none. `app/(site)/layout.tsx` mounts the header
 * and the footer now, so this page is just the page.
 */
export function renderHomePage(answers: Answers): string {
  const sells = answers.businessModel !== "none";

  const uiImports = sells
    ? "Card, CardBody, PageHeader, buttonClass"
    : "Card, CardBody, PageHeader";

  const shop = sells
    ? `
      <h2 className="mt-10 mb-2 text-[11px] font-medium uppercase tracking-wider text-ink-muted">
        Your shop
      </h2>
      {/* Not a call to action. This is the only place a product created in the
          admin panel becomes visible, and with nothing pointing at it the
          storefront renders perfectly at a URL nobody has been told about —
          which from the outside is indistinguishable from having no shop. */}
      <Card>
        <CardBody className="flex flex-wrap items-center justify-between gap-3">
          <p className="max-w-[46ch] text-sm text-ink-muted">
            Published products appear here &mdash; this is the page a customer sees.
          </p>
          <Link href="/products" className={buttonClass("primary")}>
            Open the shop
          </Link>
        </CardBody>
      </Card>
`
    : "";

  return `import Link from "next/link";
import type { ReactNode } from "react";
import { HealthCheck } from "@/components/HealthCheck";
import { ${uiImports} } from "@/components/ui";

/**
 * Where the files are. Nothing more.
 *
 * A generated project's landing page has one job — get whoever just ran the
 * generator to the file they are about to edit. Marketing copy here is copy
 * that gets deleted in the first hour, and a hero image is a hero image nobody
 * asked for.
 */
const STARTING_POINTS: readonly { readonly path: string; readonly what: string }[] = [
  { path: "src/permissions/catalog.ts", what: "Permission keys" },
  { path: "src/db/schema.ts", what: "Your tables" },
  { path: "src/server/routers/_app.ts", what: "Your API" },
  { path: "src/trpc/client.tsx", what: "Calling it from a client component" },
  { path: "src/trpc/server.ts", what: "Calling it from a server component" },
  { path: "app/globals.css", what: "Colours, radius, dark mode" },
];

export default function Home() {
  return (
    <main className="mx-auto max-w-3xl px-6 py-12">
      <PageHeader
        title="${answers.projectName}"
        description="Auth, tenancy, permissions, tRPC and the environment contract are wired. Start building features."
      />

      <Card>
        <CardBody className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-ink-muted">
            <HealthCheck />
          </p>
          <Link href="/setup" className="text-sm text-accent underline underline-offset-2">
            What is configured, and what is not
          </Link>
        </CardBody>
      </Card>

      <p className="mt-4 max-w-[62ch] text-sm text-ink-muted">
        Add credentials to <Code>.env.local</Code> whenever you want the feature
        they unlock. Nothing here blocks you from building.
      </p>
${shop}
      <h2 className="mt-10 mb-2 text-[11px] font-medium uppercase tracking-wider text-ink-muted">
        Where to start
      </h2>
      <Card>
        <ul>
          {STARTING_POINTS.map((entry) => (
            <li
              key={entry.path}
              className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-line px-4 py-2.5 last:border-0"
            >
              <span className="text-sm text-ink">{entry.what}</span>
              <Code>{entry.path}</Code>
            </li>
          ))}
        </ul>
      </Card>
    </main>
  );
}

function Code({ children }: { children: ReactNode }) {
  return (
    <code className="rounded-[3px] bg-accent-soft px-1 py-px font-mono text-xs text-accent">
      {children}
    </code>
  );
}
`;
}
