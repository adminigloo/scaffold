import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // `template/` and `overlays/` are DATA, not code. Their .test.ts files are
    // emitted verbatim into a generated project and still contain unrendered
    // tokens like `__SCOPE__/permissions`, which is not a resolvable package
    // name here and never will be. Vitest's default include walks the whole
    // package, so without this the CLI's own suite fails on files that are
    // working exactly as intended.
    //
    // They ARE executed — as part of the generated project, which the CI
    // `generate` job builds and runs. That is the only place they can resolve.
    exclude: ["**/node_modules/**", "**/dist/**", "template/**", "overlays/**"],
  },
});
