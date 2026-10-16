import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * Review FH-7: `createVercelBlobStore({ sdk: vercelBlob, … })` with
 * `import * as vercelBlob from "@vercel/blob"` (the README's quick start) is
 * a TYPE error against @vercel/blob 2.8 if `VercelBlobSdk` names its options
 * loosely (`Record<string, unknown>` doesn't satisfy `PutCommandOptions`,
 * which requires `access`), and `next build` type-checks. This compiles
 * fixtures/vercel-blob-sdk-check.ts, which assigns 2.8.2's real declarations
 * to `VercelBlobSdk`, and expects no error.
 */

const here = dirname(fileURLToPath(import.meta.url));

function diagnosticsOf(file: string): string[] {
  const configPath = resolve(here, "../../tsconfig.json");
  const config = ts.readConfigFile(configPath, (path) => ts.sys.readFile(path));
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, dirname(configPath));
  const program = ts.createProgram([file], { ...parsed.options, noEmit: true });
  return ts
    .getPreEmitDiagnostics(program)
    .filter((d) => d.file && resolve(d.file.fileName) === resolve(file))
    .map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
}

describe("VercelBlobSdk and @vercel/blob 2.8 (review FH-7)", () => {
  it("the SDK's own namespace is a VercelBlobSdk, with no cast", () => {
    expect(diagnosticsOf(resolve(here, "fixtures/vercel-blob-sdk-check.ts"))).toEqual([]);
  }, 60_000);
});
