#!/usr/bin/env node
//
// Generate a project the way a customer gets one, and prove it serves.
//
// WHY THIS EXISTS, AND WHY IT PACKS RATHER THAN LINKS. The obvious way to try a
// generated project against unreleased packages is to rewrite its dependencies
// to `link:../../scaffold/packages/*`. That is a different product. A linked
// package resolves to a path outside `node_modules`, and Next decides several
// things by exactly that test: `serverExternalPackages` matches on a resolved
// path containing `node_modules/<name>/` and silently declines to externalise
// anything else, and Turbopack applies its `react-dom/server` rule to a linked
// package as though it were project source. A `--email` project built that way
// fails with "You're importing a component that imports react-dom/server" and
// no configuration rescues it — `transpilePackages` included, because
// transpiling is bundling. The same project, installed, builds and serves.
//
// So a link-based harness reports failures a customer will never see and hides
// the ones they will. `pnpm pack` produces the tarball that would be published,
// with `workspace:` and `catalog:` ranges already resolved, and installing it
// puts the package where a registry install puts it. That is the only topology
// worth testing against, and it is the one both CI jobs use.
//
// It ends with the route sweep, because a build that exits 0 is not evidence
// that a page renders — the regression this script was written after did both.
//
//   node scripts/verify-generated.mjs <out-dir> <name> [-- <generator flags>]
//
// Example:
//   node scripts/verify-generated.mjs /tmp/verify max -- \
//     --model both --admin full --ai --email

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const argv = process.argv.slice(2);
const split = argv.indexOf("--");
const [outArg, name] = split === -1 ? argv : argv.slice(0, split);
const flags = split === -1 ? [] : argv.slice(split + 1);

if (!outArg || !name) {
  console.error("usage: node scripts/verify-generated.mjs <out-dir> <name> [-- <generator flags>]");
  process.exit(2);
}

const out = resolve(outArg);
const app = join(out, name);
const tarballDir = join(out, "tarballs");

/** Run something, echo it first, and stop on failure. */
function run(label, command, args, options = {}) {
  process.stdout.write(`\n=== ${label}\n$ ${command} ${args.join(" ")}\n`);
  const result = spawnSync(command, args, { stdio: "inherit", shell: true, ...options });
  const code = result.status ?? 1;
  process.stdout.write(`--- ${label}: exit ${code}\n`);
  if (code !== 0) process.exit(code);
  return code;
}

// ---------------------------------------------------------------- build
if (!process.env.SKIP_BUILD) {
  run("build the workspace", "pnpm", ["-r", "--filter", '"./packages/**"', "build"], { cwd: REPO });
} else {
  console.log("SKIP_BUILD set — using the dist/ directories as they are.");
}

// ----------------------------------------------------------------- pack
// Every package except the generator itself, which is run from dist rather
// than installed. `pnpm pack` resolves `workspace:` and `catalog:` ranges into
// the concrete ones the published manifest would carry.
mkdirSync(tarballDir, { recursive: true });
const tarballs = {};
for (const dir of readdirSync(join(REPO, "packages"))) {
  const manifestPath = join(REPO, "packages", dir, "package.json");
  if (!existsSync(manifestPath)) continue;
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (!manifest.name.startsWith("@adminigloo/")) continue;
  if (manifest.name === "@adminigloo/create-app") continue;

  execFileSync("pnpm", ["pack", "--pack-destination", tarballDir], {
    cwd: join(REPO, "packages", dir),
    stdio: "pipe",
    shell: true,
  });
  const tarball = join(tarballDir, `adminigloo-${dir}-${manifest.version}.tgz`);
  if (!existsSync(tarball)) throw new Error(`pnpm pack produced no ${tarball}`);
  tarballs[manifest.name] = `file:${tarball.replace(/\\/g, "/")}`;
}
console.log(`\n=== packed ${Object.keys(tarballs).length} packages into ${tarballDir}`);

// ------------------------------------------------------------- generate
run("build the generator", "pnpm", ["--filter", "@adminigloo/create-app", "build"], { cwd: REPO });
rmSync(app, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
run(
  "generate",
  "node",
  [JSON.stringify(join(REPO, "packages", "create-app", "dist", "index.js")), name, "--yes", ...flags],
  { cwd: out },
);

// ------------------------------------------------------------ point at the
// tarballs. The overrides matter as much as the direct dependencies: a packed
// @adminigloo/email depends on @adminigloo/db by version range, and that range
// names a release that may not exist yet.
const manifestPath = join(app, "package.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
for (const field of ["dependencies", "devDependencies"]) {
  for (const dep of Object.keys(manifest[field] ?? {})) {
    if (tarballs[dep]) manifest[field][dep] = tarballs[dep];
  }
}
manifest.pnpm = { ...(manifest.pnpm ?? {}) };
manifest.pnpm.overrides = { ...(manifest.pnpm.overrides ?? {}), ...tarballs };
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`\n=== rewrote ${manifestPath} to install the tarballs`);

// ------------------------------------------------------------- and prove it
// --ignore-workspace so pnpm does not walk up and adopt this repository's
// workspace, which would resolve `catalog:` ranges a real user cannot see.
run("install", "pnpm", ["install", "--no-frozen-lockfile", "--ignore-workspace"], { cwd: app });
run("typecheck", "pnpm", ["exec", "tsc", "--noEmit"], { cwd: app });
run("next build", "pnpm", ["exec", "next", "build"], { cwd: app });

const sweep = join(REPO, ".github", "scripts", "route-sweep.sh");
run("serve — next start", "bash", [JSON.stringify(sweep), JSON.stringify(app), '"next start"', "3200", "pnpm", "exec", "next", "start", "-p", "3200"]);
run("serve — next dev", "bash", [JSON.stringify(sweep), JSON.stringify(app), '"next dev"', "3201", "pnpm", "exec", "next", "dev", "-p", "3201"]);

console.log(`\n=== ${name} generated, installed, built and served from ${app}`);
