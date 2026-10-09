import { describe, expect, it } from "vitest";
import { definePaths, isIndexable, pathRule, robotsHeader } from "../index.js";
import { paths, site, staging } from "./fixtures.js";

describe("definePaths: one list, checked", () => {
  it("takes Riddler Go's NOINDEX_PREFIXES as written: the /x/ and /x pairs collapse to one entry each", () => {
    expect(paths.private).toEqual([
      "/admin",
      "/dashboard",
      "/events",
      "/staff",
      "/setup",
      "/play",
      "/e",
      "/api",
      "/sso-callback",
      "/qr",
      "/invite",
      "/dev",
      "/settings",
      "/event-builder",
      "/shared",
    ]);
    expect(paths.public[2]).toMatchObject({ path: "/pricing", priority: 0.9 });
    expect(Object.isFrozen(paths)).toBe(true);
    expect(() => definePaths({ public: ["/a", "/a/"] })).toThrow(/"\/a" is listed twice in public/);
  });

  it("refuses a public page inside a private or noindex area (Riddler Go's collision test, built in)", () => {
    expect(() => definePaths({ public: ["/admin/help"], private: ["/admin"] })).toThrow(/inside "\/admin", which is private/);
    expect(() => definePaths({ public: ["/join/faq"], noindex: ["/join"] })).toThrow(/which is noindex/);
    expect(() => definePaths({ public: ["/admin-guide"], private: ["/admin"] })).not.toThrow();
  });

  it("refuses a path in two lists, wildcards, relative paths, / as private, bad priorities", () => {
    const attempt = () =>
      definePaths({
        public: [{ path: "/x", priority: 2 }, "pricing"],
        private: ["/", "/a*", "/x"],
        noindex: ["/"],
      });
    expect(attempt).toThrow(/"\/" cannot be private/);
    expect(attempt).toThrow(/"\/a\*" must start with/);
    expect(attempt).toThrow(/"\/" cannot be noindex/);
    expect(attempt).toThrow(/priority must be between 0 and 1/);
    expect(attempt).toThrow(/public path "pricing"/);
    expect(attempt).toThrow(/"\/x" is listed as both private and public/);
  });
});

describe("pathRule and robotsHeader: the proxy's answer", () => {
  it("matches whole segments, most specific entry wins", () => {
    expect(pathRule(paths, "/admin")).toBe("private");
    expect(pathRule(paths, "/admin/users?x=1")).toBe("private");
    expect(pathRule(paths, "/admin-guide")).toBe("unlisted");
    expect(pathRule(paths, "/e/ABC123")).toBe("private");
    expect(pathRule(paths, "/elm-street-church/spring-hunt")).toBe("unlisted");
    expect(pathRule(paths, "/sign-in/factor-two")).toBe("noindex");
    expect(pathRule(paths, "/templates/bridal")).toBe("unlisted");
    expect(pathRule(paths, "https://riddlergo.com/join")).toBe("public");
    const nested = definePaths({ noindex: ["/account"], private: ["/account/billing"] });
    expect(pathRule(nested, "/account/billing/x")).toBe("private");
    expect(pathRule(nested, "/account/profile")).toBe("noindex");
  });

  it("gives the X-Robots-Tag value per path, and noindex for everything off production", () => {
    expect(robotsHeader(site, "/dashboard/events")).toBe("noindex, nofollow");
    expect(robotsHeader(site, "/sign-in")).toBe("noindex");
    expect(robotsHeader(site, "/pricing")).toBeNull();
    expect(robotsHeader(site, "/admin-guide")).toBeNull();
    expect(robotsHeader(staging, "/pricing")).toBe("noindex, nofollow");
  });

  it("adds extra directives to every header it sends (Riddler Go sends noarchive, nosnippet), and only known ones", () => {
    const extra = ["noarchive", "nosnippet"] as const;
    expect(robotsHeader(site, "/invite/abc", { extra })).toBe("noindex, nofollow, noarchive, nosnippet");
    expect(robotsHeader(site, "/sign-in", { extra })).toBe("noindex, noarchive, nosnippet");
    expect(robotsHeader(staging, "/pricing", { extra })).toBe("noindex, nofollow, noarchive, nosnippet");
    expect(robotsHeader(site, "/pricing", { extra })).toBeNull();
    expect(() => robotsHeader(site, "/admin", { extra: ["noindex, follow" as never] })).toThrow(/extra may only hold/);
  });
});

describe("isIndexable: production only, failing closed", () => {
  it("is true only for production on a real host", () => {
    expect(isIndexable({ env: "production", host: "riddlergo.com" })).toBe(true);
    expect(isIndexable({ env: "Production", host: "https://riddlergo.com/" })).toBe(true);
    expect(isIndexable({ env: "production", host: "riddlergo.com:443" })).toBe(true);
  });

  it("is false for every other environment, and for a missing one", () => {
    for (const env of ["preview", "staging", "development", "local", "test", "", undefined, null]) {
      expect([env, isIndexable({ env, host: "riddlergo.com" })]).toEqual([env, false]);
    }
  });

  it("is false on local, IP and platform preview hosts even in production", () => {
    for (const host of [
      "localhost",
      "http://localhost:3000",
      "127.0.0.1",
      "[::1]",
      "10.0.0.5:8080",
      "app.localhost",
      "riddler-go-git-main-dallin.vercel.app",
      "deploy-preview-3--site.netlify.app",
      "abc.pages.dev",
      "x.ngrok-free.app",
      "",
      undefined,
    ]) {
      expect([host, isIndexable({ env: "production", host })]).toEqual([host, false]);
    }
  });

  it("with productionHosts, only those hosts: a www duplicate refuses crawlers until it redirects", () => {
    expect(isIndexable({ env: "production", host: "riddlergo.com", productionHosts: "riddlergo.com" })).toBe(true);
    expect(isIndexable({ env: "production", host: "www.riddlergo.com", productionHosts: "riddlergo.com" })).toBe(false);
    expect(isIndexable({ env: "production", host: "staging.riddlergo.com", productionHosts: ["riddlergo.com"] })).toBe(false);
    expect(isIndexable({ env: "production", host: "my-app.vercel.app", productionHosts: ["my-app.vercel.app"] })).toBe(true);
  });
});
