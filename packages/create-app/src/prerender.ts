/**
 * THE ROUTES THIS SCAFFOLD REFUSES TO PRERENDER, AND WHY THE CHECK IS HERE.
 *
 * `app/(site)/layout.tsx` mounts `AuthHeader`, which reads the Clerk session.
 * A route rendered with `export const dynamic = "force-static"` is rendered at
 * BUILD time, where no proxy has run and there is no request to read — so the
 * session read fails, and `next build` exits 1 on a page whose own source says
 * nothing about authentication. The message Clerk produces, "auth() was called
 * but Clerk can't detect usage of clerkMiddleware()", names the framework, the
 * middleware, and nothing that appears anywhere in the offending file.
 *
 * IT WAS INVISIBLE BECAUSE OF WHERE THE BRANCH IS. With no Clerk keys the
 * header returns before it reads anything, so the prerender succeeds — and
 * every check this repository runs generated a project with no credentials.
 * `/setup/email`, the one page in the scaffold that forced static rendering,
 * therefore built green in every harness run and could not build at all in a
 * project with keys in `.env.local`. The defect was never that page. It was
 * that the configured path had nothing pointed at it.
 *
 * SO THE CHECK READS THE PLAN, not a build. It costs a pass over files already
 * in memory, it runs inside `planEmit` on every generation exactly as
 * `assertCapabilitiesAreProvable` does, and it fails at the moment somebody
 * ADDS the offending file rather than the moment somebody with credentials
 * tries to deploy it. Nothing about it can be satisfied by a project that
 * happens to have no credentials, which is the only property that matters.
 *
 * WHAT IT DOES NOT DO. It says nothing about whether a route works — only that
 * a page under a layout which reads the session has not asked to be rendered
 * without one. Everything after generation is the header's problem, and
 * `viewerId` in `AuthHeader` degrades to the signed-out nav rather than
 * throwing. Between them the class is shut at both ends: at generation for the
 * routes this emits, and at render for the ones a person adds afterwards.
 */

import type { EmitPlan } from "./emit.js";

/** Plan keys carry the host separator; every path in here is `/`-separated. */
function posix(path: string): string {
  return path.split(/[\\/]/).join("/");
}

/**
 * The file with its comments removed.
 *
 * Load-bearing, and in both directions. This module's own explanation names
 * `force-static` and `auth()` in prose, and so does the doc comment on
 * `viewerId`; a substring check over raw source would flag the sentences that
 * exist to prevent the bug. What a project RUNS is what is left after this.
 */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/**
 * Every module a file imports AT RUNTIME.
 *
 * `import type` is dropped, and dropping it is what makes this a walk rather
 * than a dragnet. `app/layout.tsx` imports `@/trpc/client`, which imports the
 * router's TYPE from `@/server/routers/_app`, which reaches `@/server/auth` —
 * so counting type imports made the ROOT layout look like it read a session,
 * and every page in the project sat under it. The rule would then have been a
 * blanket ban on static rendering wearing an explanation that named three files
 * with nothing to do with the problem. A type is erased before the render.
 */
function importsOf(source: string): readonly string[] {
  const runtime = code(source)
    .replace(/\bimport\s+type\s[\s\S]*?\bfrom\s*["'][^"']+["']/g, "")
    .replace(/\bexport\s+type\s[\s\S]*?\bfrom\s*["'][^"']+["']/g, "");
  return [...runtime.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)].flatMap(
    (match) => match[1] ?? [],
  );
}

/**
 * The module runs in the browser, so the walk stops here.
 *
 * A `"use client"` module cannot call `auth()` — there is no request in a
 * browser and no secret key to read one with — and the modules it imports are
 * reached from the client bundle rather than from the render on the server. The
 * root layout's path to `src/server/auth.ts` goes through exactly one of these.
 */
function isClientModule(source: string): boolean {
  return /^\s*["']use client["']/.test(code(source));
}

/**
 * A specifier as the emitted project resolves it, or undefined for anything
 * that is not a file in this plan.
 *
 * `@/x` is `src/x` — the tsconfig alias every emitted file uses. A bare
 * specifier is a package: `@__SCOPE__/auth` lives in `node_modules` and cannot
 * be walked from here, which costs nothing, because a runtime package cannot
 * read a request either unless something in this plan hands it one.
 */
function resolveInPlan(
  sources: ReadonlyMap<string, string>,
  fromPath: string,
  specifier: string,
): string | undefined {
  let base: string;
  if (specifier.startsWith("@/")) {
    base = `src/${specifier.slice(2)}`;
  } else if (specifier.startsWith("./") || specifier.startsWith("../")) {
    const dir = fromPath.slice(0, fromPath.lastIndexOf("/"));
    const stack: string[] = [];
    for (const part of `${dir}/${specifier}`.split("/")) {
      if (part === "." || part === "") continue;
      if (part === "..") stack.pop();
      else stack.push(part);
    }
    base = stack.join("/");
  } else {
    return undefined;
  }

  for (const candidate of [
    `${base}.tsx`,
    `${base}.ts`,
    `${base}/index.tsx`,
    `${base}/index.ts`,
  ]) {
    if (sources.has(candidate)) return candidate;
  }
  return undefined;
}

/** The file reads the signed-in user itself, rather than through something else. */
function readsSession(source: string): boolean {
  const body = code(source);
  return body.includes("@clerk/nextjs/server") && /\bauth\s*\(\s*\)/.test(body);
}

export interface AuthScopedLayout {
  /** `app/(site)/layout.tsx`. */
  readonly layout: string;
  /** The segment it wraps — `app/(site)`. Every page below this is inside it. */
  readonly segment: string;
  /** The emitted module where the session read actually happens. */
  readonly reads: string;
}

/**
 * Every layout in the plan whose render reaches a session read, and where.
 *
 * TRANSITIVELY, because the read is never in the layout itself.
 * `app/(site)/layout.tsx` imports `AuthHeader`; the admin shell's layout
 * reaches `currentPrincipal` two hops away. A one-hop check would find the
 * first and miss the second, and a check that knew the name `AuthHeader` would
 * be a check that stops working the day the component is renamed — silently,
 * and in the direction that passes.
 *
 * Exported so a test can assert the detector still FINDS something. A project
 * with no auth-scoped layout at all satisfies the assertion below vacuously,
 * and that is precisely what a refactor of the header would produce.
 */
export function authScopedLayouts(plan: EmitPlan): readonly AuthScopedLayout[] {
  const sources = new Map<string, string>();
  for (const [path, contents] of plan.files) sources.set(posix(path), contents);

  const found: AuthScopedLayout[] = [];

  for (const path of sources.keys()) {
    if (!/^app\/.*layout\.tsx$/.test(path)) continue;

    // Breadth-first with a visited set. `@/components/ui` is a barrel that half
    // the project imports and several of its members import each other, so an
    // unguarded walk does not terminate.
    const seen = new Set<string>([path]);
    const queue: string[] = [path];
    let reads: string | undefined;

    while (queue.length > 0) {
      const current = queue.shift();
      if (current === undefined) break;
      const source = sources.get(current);
      if (source === undefined) continue;
      if (isClientModule(source)) continue;
      if (readsSession(source)) {
        reads = current;
        break;
      }
      for (const specifier of importsOf(source)) {
        const next = resolveInPlan(sources, current, specifier);
        if (next !== undefined && !seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }

    if (reads !== undefined) {
      found.push({ layout: path, segment: path.slice(0, path.lastIndexOf("/")), reads });
    }
  }

  return found;
}

/**
 * The two segment configs that take the request away.
 *
 * `force-static` renders at build time and hands `headers()` an empty set;
 * `dynamic = "error"` refuses to render at all the moment anything asks for a
 * request. Both are incompatible with a layout that reads a session, and no
 * other segment config is — `revalidate` still renders per request on a route
 * that is dynamic, and `fetchCache` is about fetches rather than the request.
 */
const FORCES_A_PRERENDER = /export\s+const\s+dynamic\s*=\s*["'](force-static|error)["']/;

export class PrerenderedAuthRouteError extends Error {
  readonly name = "PrerenderedAuthRouteError";
  constructor(page: string, layout: AuthScopedLayout, directive: string) {
    super(
      `${page} declares \`export const dynamic = "${directive}"\`, and it sits ` +
        `under ${layout.layout} — which renders ${layout.reads}, and that reads ` +
        `the signed-in user.\n\n` +
        `A route forced to render statically is rendered at BUILD time, where ` +
        `proxy.ts has not run and there is no request to read a session from. ` +
        `Clerk answers that by throwing "auth() was called but Clerk can't ` +
        `detect usage of clerkMiddleware()", so \`next build\` fails on this ` +
        `page and names neither this file nor the layout above it. It happens ` +
        `only once Clerk keys are present, which is why a project with none of ` +
        `them builds perfectly and proves nothing.\n\n` +
        `Drop the directive, or use "force-dynamic". A page under this layout ` +
        `cannot both be prerendered and show who is signed in, and the header ` +
        `is the half that has to be right on every route.`,
    );
  }
}

/**
 * Refuse to emit a page the project receiving it will not be able to build.
 *
 * Called from `planEmit` before anything reaches disk, for the same reason
 * `assertCapabilitiesAreProvable` is: the cost is a pass over files already in
 * memory, and the failure it prevents is one the checks around it are
 * structurally unable to see.
 */
export function assertNoPrerenderedAuthRoutes(plan: EmitPlan): void {
  const scoped = authScopedLayouts(plan);
  if (scoped.length === 0) return;

  for (const [rawPath, contents] of plan.files) {
    const path = posix(rawPath);
    if (!path.startsWith("app/") || !path.endsWith("page.tsx")) continue;

    const directive = FORCES_A_PRERENDER.exec(code(contents));
    if (directive === null) continue;

    // The INNERMOST matching layout, so the message names the one whose header
    // is actually in the way rather than whichever happened to be walked first.
    const layout = scoped
      .filter((candidate) => path.startsWith(`${candidate.segment}/`))
      .sort((a, b) => b.segment.length - a.segment.length)[0];

    if (layout !== undefined) {
      throw new PrerenderedAuthRouteError(path, layout, directive[1] ?? "force-static");
    }
  }
}
