import { readdirSync, readFileSync } from "node:fs";
import { join, posix, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * THE PACKAGE STANDS ALONE (README.md): nothing in it leans on an app, so it
 * installs into any app — an AdminIgloo project, or somebody else's — and
 * works there. Every source file is read and every import checked:
 *
 *   - no "@/…" (an app's own code), no relative path out of src/, and no
 *     other @adminigloo package: this one installs by itself;
 *   - only the dependencies it declares: React (screens and cards), drizzle
 *     (the table and the queue), zod (the card addresses), Node's crypto, fs
 *     and path, and the Anthropic SDK as TYPES only (the app builds the client);
 *   - the core (every file outside ui/ and cards/) is plain TypeScript: no
 *     React, no Next.js, and it imports neither ui/ nor cards/;
 *   - ui/ (the screens) may use React, never Next.js, and reaches the
 *     server modules (the store, the table, the handler) for types only, so
 *     it drops into any React app's browser bundle;
 *   - cards/ (the image renderer) may use React (a card is a React element
 *     tree) but no Next.js: the app hands it the painter (next/og's
 *     ImageResponse), so it moves to any app;
 *   - no reading the environment: the app hands the package what it needs.
 */
const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** The two framework folders, and what each may use beyond the core's plain TypeScript. */
const FOLDERS: Readonly<Record<string, { readonly react: boolean }>> = {
  "ui/": { react: true },
  "cards/": { react: true },
};

/** What the package may import from outside itself (it declares each). */
const ALLOWED = /^(react|react\/jsx-runtime|drizzle-orm|drizzle-orm\/pg-core|zod|node:crypto|node:fs\/promises|node:path)$/;
/** The core modules ui/ may reach for types only: they hold a database. */
const SERVER_ONLY = /^\.\.\/(store|schema|handlers|forget|server|anthropic)\.js$/;

function filesIn(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? (e.name === "__tests__" ? [] : filesIn(join(dir, e.name))) : /\.(ts|tsx)$/.test(e.name) ? [join(dir, e.name)] : [],
  );
}

/** Every import of a source file: the module, and whether the whole statement is type-only. */
function importsOf(source: string): { spec: string; typeOnly: boolean }[] {
  const found: { spec: string; typeOnly: boolean }[] = [];
  for (const m of source.matchAll(/\b(import|export)\s+(type\s+)?[^;'"]*?\bfrom\s*["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)|\brequire\s*\(\s*["']([^"']+)["']|^import\s+["']([^"']+)["']/gm)) {
    const spec = m[3] ?? m[4] ?? m[5] ?? m[6];
    if (spec) found.push({ spec, typeOnly: Boolean(m[2]) });
  }
  return found;
}

const ENV = ["process", "env"].join(".");

/** Source with comments removed, so a usage example in a doc comment isn't read as an import. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

/** What's wrong with one file, by its path inside src/ ("store.ts", "ui/PostCard.tsx"). */
export function boundaryProblems(file: string, raw: string): string[] {
  const source = code(raw);
  const problems: string[] = [];
  const home = Object.keys(FOLDERS).find((f) => file.startsWith(f)) ?? null;
  const react = home ? FOLDERS[home]!.react : false;
  for (const { spec, typeOnly } of importsOf(source)) {
    if (spec.startsWith("@/")) problems.push(`${file} imports ${spec}: an app's own code`);
    else if (spec.startsWith(".")) {
      const target = posix.normalize(posix.join(posix.dirname(file), spec));
      const into = Object.keys(FOLDERS).find((f) => target.startsWith(f));
      if (target.startsWith("..")) problems.push(`${file} imports ${spec}: outside the package`);
      else if (into && into !== home) problems.push(`${file} imports ${spec}: ${into === "ui/" ? "the screens" : "the card renderer"}, from outside ${into}`);
      else if (home === "ui/" && SERVER_ONLY.test(spec) && !typeOnly) problems.push(`${file} imports ${spec}: a server module, from the screens (types only)`);
    } else if (/^next(\/|$)/.test(spec) || spec === "server-only") problems.push(`${file} imports ${spec}: Next.js only`);
    else if (/^react(-dom)?(\/|$)/.test(spec) && !react) problems.push(`${file} imports ${spec}: React, outside ui/ and cards/`);
    else if (spec.startsWith("@adminigloo/")) problems.push(`${file} imports ${spec}: another AdminIgloo package (this one stands alone)`);
    else if (spec === "@anthropic-ai/sdk") {
      if (!typeOnly) problems.push(`${file} imports ${spec}: the SDK, for more than its types (the app builds the client)`);
    } else if (!ALLOWED.test(spec)) problems.push(`${file} imports ${spec}: a dependency the package doesn't declare`);
  }
  if (source.includes(ENV)) problems.push(`${file} reads the environment`);
  return problems;
}

describe("the package's boundary", () => {
  it("holds in every file of src/", () => {
    const files = filesIn(ROOT);
    expect(files.length).toBeGreaterThan(20);
    const problems = files.flatMap((f) => boundaryProblems(relative(ROOT, f).split(sep).join("/"), readFileSync(f, "utf8")));
    expect(problems).toEqual([]);
  });

  it("catches each kind of leak (the check itself, on made-up files)", () => {
    // Spelled in pieces: this file is scanned too, and these are not its own imports.
    const imp = (spec: string) => `import { x } from "${spec}";`;
    const at = "@" + "/";
    expect(boundaryProblems("store.ts", imp(`${at}db`))).toEqual([`store.ts imports ${at}db: an app's own code`]);
    expect(boundaryProblems("writer.ts", imp("../server/ai"))).toEqual(["writer.ts imports ../server/ai: outside the package"]);
    expect(boundaryProblems("ui/PostCard.tsx", imp("next/link"))).toEqual(["ui/PostCard.tsx imports next/link: Next.js only"]);
    expect(boundaryProblems("guard.ts", `${"import"} "server-only";`)).toEqual(["guard.ts imports server-only: Next.js only"]);
    expect(boundaryProblems("types.ts", imp("react"))).toEqual(["types.ts imports react: React, outside ui/ and cards/"]);
    expect(boundaryProblems("writer.ts", imp("./ui/PostQueue.js"))).toEqual(["writer.ts imports ./ui/PostQueue.js: the screens, from outside ui/"]);
    expect(boundaryProblems("handlers.ts", imp("./cards/render.js"))).toEqual(["handlers.ts imports ./cards/render.js: the card renderer, from outside cards/"]);
    expect(boundaryProblems("platforms.ts", `const key = ${ENV}.KEY;`)).toEqual(["platforms.ts reads the environment"]);
    expect(boundaryProblems("ui/PostQueue.tsx", `${imp("react")}\n${imp("../platforms.js")}`)).toEqual([]);
    expect(boundaryProblems("ui/PostQueue.tsx", imp("../store.js"))).toEqual(["ui/PostQueue.tsx imports ../store.js: a server module, from the screens (types only)"]);
    expect(boundaryProblems("ui/PostQueue.tsx", `import type { X } from "../store.js";`)).toEqual([]);
    expect(boundaryProblems("store.ts", imp("@adminigloo/db"))).toEqual(["store.ts imports @adminigloo/db: another AdminIgloo package (this one stands alone)"]);
    expect(boundaryProblems("store.ts", imp("lodash"))).toEqual(["store.ts imports lodash: a dependency the package doesn't declare"]);
    expect(boundaryProblems("anthropic.ts", imp("@anthropic-ai/sdk"))).toEqual(["anthropic.ts imports @anthropic-ai/sdk: the SDK, for more than its types (the app builds the client)"]);
    expect(boundaryProblems("anthropic.ts", `import type Anthropic from "@anthropic-ai/sdk";`)).toEqual([]);
    // The card renderer may use React, but its painter (next/og) comes from the app.
    expect(boundaryProblems("cards/elements.tsx", imp("react"))).toEqual([]);
    expect(boundaryProblems("cards/render.tsx", imp("next/og"))).toEqual(["cards/render.tsx imports next/og: Next.js only"]);
    expect(boundaryProblems("ui/PostCard.tsx", imp("next/og"))).toEqual(["ui/PostCard.tsx imports next/og: Next.js only"]);
  });
});
