import type { Storage } from "./instance.js";
import type { StoredFile } from "./types.js";

/**
 * `checkHostSeams` (section 6.14, review G19): the list a host's developer
 * shows the business owner.
 *
 * On a foreign install, isolation rests on the HOST's `resolveTenant`,
 * `authorize` and `signing.stillValid`, which the package's own tests can
 * only fake. This runs the host's real, mounted handlers against two of the
 * host's real companies and says, in plain words, whether each promise
 * holds:
 *
 *   1. `usage` in A answers 200 (the member really is signed in to A);
 *   2. `usage` and `files` in B answer 401, 403 or 404, never 200;
 *   3. B's URL with `?tenantId={A}&tenant={A}` is still refused (the company
 *      can't be steered by a query string);
 *   4. A's id spelled another way ("0" in front: "017" for 17) is refused
 *      (review FH-5): a host that looks its companies up with `Number()`
 *      would otherwise give every spelling its own files and its own
 *      allowance;
 *   5. B's file asked for under A answers 404 while A's own answers 200 (the
 *      company is in the lookup, and the member could open A's files at all);
 *   6. someone in A who holds NO files permission (`withoutFiles`) is refused
 *      A's usage, its files and A's file (review FH-4): an `authorize` that
 *      only checks membership passes every line above;
 *   7. with links on: a link the member makes opens, and one "made" by
 *      someone who isn't a member doesn't (review FH-4: a `stillValid` that
 *      always says yes passes every line above);
 *   8. with links on and `withoutFiles`: a link "made" by that person, who
 *      can't open the file, doesn't open it (review SEC-03: `stillValid`
 *      re-runs the file's own rule for the maker, with `mayView`);
 *   9. with `suspendedCompany`: its usage is refused and a link the member
 *      made there doesn't open;
 *  10. no answer's body or headers carry any stored file's key.
 *
 * It stores one small file in A and one in B (and one in the suspended
 * company) (`library`, a 1×1 PNG) and removes them in a `finally`. It never
 * throws: a throw is a failed line. A line it couldn't check is a failed
 * line too, saying what to pass: an owner is never told "passed" about a
 * promise that wasn't checked.
 */

/** Declared here, never imported: the same shape as @adminigloo/notifications/testing's. */
export interface HostSeamsCheckResult {
  readonly ok: boolean;
  /** One line per check, in plain words. */
  readonly checks: readonly { readonly name: string; readonly ok: boolean; readonly detail: string }[];
}

/** Builds a request to `path` in company `tenantId`, signed in as one person. May be async (review FH-10: it can sign a session cookie first). */
export type HostSeamsRequest = (
  tenantId: string,
  path: string,
  init?: { readonly method?: string; readonly query?: Readonly<Record<string, string>>; readonly body?: unknown },
) => Request | Promise<Request>;

export interface CheckStorageHostSeamsInput {
  /** The host's mounted signed-in handlers (`createStorageHandlers(…)`). */
  readonly handlers: { handle(req: Request): Promise<Response> };
  /** The instance those handlers use: the check stores one small file in each company it checks, and removes them after. */
  readonly storage: Storage;
  /** A request to `path` (e.g. "v1/admin/usage") in company `tenantId`, signed in as `member` (of A only), the way the host routes a company. */
  readonly request: HostSeamsRequest;
  readonly companyA: string;
  readonly companyB: string;
  /** An active member of A (and not of B) holding `files.view`. */
  readonly member: { readonly userId: string };
  /**
   * Review FH-4: an active member of A who holds NO files permission (a crew
   * member, a technician), and a request builder signed in as them. Without
   * it, that line fails with "Not checked".
   */
  readonly withoutFiles?: { readonly userId: string; readonly request: HostSeamsRequest };
  /** Review FH-4: a company of yours that is suspended (`member` may belong to it). Checked when given. */
  readonly suspendedCompany?: string;
}

/** A 1×1 transparent PNG: the smallest real image (the proof and the checks plant it). */
export const ONE_PIXEL_PNG: Uint8Array = Uint8Array.from(
  atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="),
  (c) => c.charCodeAt(0),
);

/** A person who is nobody's member: an id a whole-number column still accepts, so the host's lookup answers "no" rather than failing. */
export const NOT_A_MEMBER_ID = "2147483646";

const refused = (status: number) => status === 401 || status === 403 || status === 404;

export async function checkHostSeams(input: CheckStorageHostSeamsInput): Promise<HostSeamsCheckResult> {
  const checks: { name: string; ok: boolean; detail: string }[] = [];
  const seen: string[] = [];
  const planted: StoredFile[] = [];

  async function call(build: HostSeamsRequest, tenantId: string, path: string, init?: Parameters<HostSeamsRequest>[2]) {
    try {
      const res = await input.handlers.handle(await build(tenantId, path, init));
      const text = await res.text().catch(() => "");
      seen.push(text, [...res.headers.entries()].map(([k, v]) => `${k}: ${v}`).join("\n"));
      return { status: res.status, text };
    } catch (error) {
      return { status: -1, text: error instanceof Error ? error.message : String(error) };
    }
  }
  const asMember = (tenantId: string, path: string, init?: Parameters<HostSeamsRequest>[2]) => call(input.request, tenantId, path, init);
  const said = (r: { status: number }) => (r.status === -1 ? "threw" : `answered ${r.status}`);

  async function plant(tenantId: string): Promise<StoredFile | string> {
    try {
      const file = await input.storage.store({
        tenantId,
        purpose: "library",
        bytes: ONE_PIXEL_PNG,
        filename: "install-check.png",
        addedBy: tenantId === input.companyA ? input.member.userId : null,
      });
      planted.push(file);
      return file;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  /** Does a link `userId` made to `file` open? A string: why it couldn't be checked. */
  async function linkOpens(file: StoredFile, userId: string): Promise<boolean | string> {
    try {
      const link = await input.storage.signedLink({ tenantId: file.tenantId, fileId: file.id, userId });
      if (!link) return "the link couldn't be made";
      const token = link.url.split("/v1/f/")[1] ?? "";
      return (await input.storage.resolveLink(decodeURIComponent(token))) !== null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  try {
    const fileA = await plant(input.companyA);
    const fileB = await plant(input.companyB);

    const usageA = await asMember(input.companyA, "v1/admin/usage");
    checks.push({
      name: "A member of Company A can see Company A's files",
      ok: usageA.status === 200,
      detail: usageA.status === 200 ? "passed" : `Company A's usage ${said(usageA)}: is the member signed in, and do they hold files.view?`,
    });

    const usageB = await asMember(input.companyB, "v1/admin/usage");
    const filesB = await asMember(input.companyB, "v1/admin/files");
    checks.push({
      name: "A member of Company A can't see Company B's files",
      ok: refused(usageB.status) && refused(filesB.status),
      detail:
        refused(usageB.status) && refused(filesB.status)
          ? "passed"
          : `Company B's usage ${said(usageB)} and its files ${said(filesB)}; both must be refused (401, 403 or 404).`,
    });

    const steered = { tenantId: input.companyA, tenant: input.companyA };
    const steeredUsage = await asMember(input.companyB, "v1/admin/usage", { query: steered });
    const steeredFiles = await asMember(input.companyB, "v1/admin/files", { query: steered });
    checks.push({
      name: "The company can't be changed from the address's query string",
      ok: refused(steeredUsage.status) && refused(steeredFiles.status),
      detail:
        refused(steeredUsage.status) && refused(steeredFiles.status)
          ? "passed"
          : `Company B's address with ?tenantId=A ${said(steeredUsage)}: resolveTenant must read the company from the path or the session, never the query.`,
    });

    // Review FH-5: "017" is not company 17. A host whose resolveTenant passes
    // the path through, and whose authorize looks the company up by Number(),
    // gives each spelling its own (unseen) files and its own allowance.
    const alias = `0${input.companyA}`;
    const aliased = await asMember(alias, "v1/admin/usage");
    checks.push({
      name: "Company A can't be reached under another spelling of its id",
      ok: refused(aliased.status),
      detail: refused(aliased.status)
        ? "passed"
        : `Company A's id written as "${alias}" ${said(aliased)}: resolveTenant must take the id only exactly as you write it (for whole-number ids, /^[1-9][0-9]*$/) and answer null for anything else.`,
    });

    if (typeof fileA === "string" || typeof fileB === "string") {
      checks.push({
        name: "Company B's file can't be opened from Company A",
        ok: false,
        detail: `The check couldn't store its test files: ${typeof fileA === "string" ? fileA : (fileB as string)}`,
      });
    } else {
      const own = await asMember(input.companyA, `v1/admin/files/${encodeURIComponent(fileA.id)}/content`);
      const cross = await asMember(input.companyA, `v1/admin/files/${encodeURIComponent(fileB.id)}/content`);
      const ok = own.status === 200 && cross.status === 404;
      checks.push({
        name: "Company B's file can't be opened from Company A",
        ok,
        detail: ok
          ? "passed"
          : own.status !== 200
            ? `Company A's own file ${said(own)}, so this proves nothing: use a member who holds files.view.`
            : `Company B's file asked for under Company A ${said(cross)}; it must be 404 (the company has to be in the lookup).`,
      });
    }

    // Review FH-4 (a): the permission, not only the membership.
    const noFilesName = "Someone in Company A without files permissions can't see its files";
    if (!input.withoutFiles) {
      checks.push({
        name: noFilesName,
        ok: false,
        detail:
          "Not checked: pass withoutFiles (a member of Company A who holds no files permission, and a request signed in as them), so a permission check that only asks whether someone is a member can't pass.",
      });
    } else {
      const without = input.withoutFiles;
      const theirUsage = await call(without.request, input.companyA, "v1/admin/usage");
      const theirFiles = await call(without.request, input.companyA, "v1/admin/files");
      const theirOpen = typeof fileA === "string" ? null : await call(without.request, input.companyA, `v1/admin/files/${encodeURIComponent(fileA.id)}/content`);
      const ok = refused(theirUsage.status) && refused(theirFiles.status) && (theirOpen === null || refused(theirOpen.status));
      checks.push({
        name: noFilesName,
        ok,
        detail: ok
          ? "passed"
          : `Their usage ${said(theirUsage)}, the files ${said(theirFiles)}${theirOpen ? ` and a file ${said(theirOpen)}` : ""}; each must be refused. authorize must answer false for a permission the person doesn't hold, not only check that they're a member.`,
      });
    }

    // Review FH-4 (b), SEC-03: every open of a link asks about its maker.
    const linkName = "A link opens for the member who made it, and for nobody who isn't a member";
    if (!input.storage.linksEnabled) {
      checks.push({ name: linkName, ok: true, detail: "passed (links to files aren't switched on)" });
    } else if (typeof fileA === "string") {
      checks.push({ name: linkName, ok: false, detail: `The check couldn't store its test file: ${fileA}` });
    } else {
      const mine = await linkOpens(fileA, input.member.userId);
      const stranger = await linkOpens(fileA, NOT_A_MEMBER_ID);
      const ok = mine === true && stranger === false;
      checks.push({
        name: linkName,
        ok,
        detail: ok
          ? "passed"
          : mine !== true
            ? `The member's own link ${mine === false ? "didn't open" : `couldn't be checked (${mine})`}: signing.stillValid must say yes for an active member of an active company.`
            : `A link "made" by someone who isn't a member (user ${NOT_A_MEMBER_ID}) ${stranger === true ? "opened" : `couldn't be checked (${stranger})`}: signing.stillValid must check that the person who made it is still a member.`,
      });
      if (input.withoutFiles) {
        const theirs = await linkOpens(fileA, input.withoutFiles.userId);
        checks.push({
          name: "A link made by someone who can't open the file doesn't open it",
          ok: theirs === false,
          detail:
            theirs === false
              ? "passed"
              : `A link "made" by ${input.withoutFiles.userId}, who holds no files permission, ${theirs === true ? "opened" : `couldn't be checked (${theirs})`}: signing.stillValid must also ask mayView with what the person holds now.`,
        });
      }
    }

    // Review FH-4 (c): a suspended company.
    if (input.suspendedCompany !== undefined) {
      const fileS = await plant(input.suspendedCompany);
      const usageS = await asMember(input.suspendedCompany, "v1/admin/usage");
      const linkS = typeof fileS === "string" || !input.storage.linksEnabled ? false : await linkOpens(fileS, input.member.userId);
      const ok = refused(usageS.status) && linkS === false;
      checks.push({
        name: "A suspended company's files can't be reached",
        ok,
        detail: ok
          ? "passed"
          : !refused(usageS.status)
            ? `The suspended company's usage ${said(usageS)}; it must be refused (authorize must refuse a suspended company).`
            : `A link made in the suspended company ${linkS === true ? "opened" : `couldn't be checked (${linkS})`}: signing.stillValid must say no for a suspended company.`,
      });
    }

    const keys = planted.map((file) => file.key).filter((key) => key !== "");
    const leaked = keys.some((key) => seen.some((text) => text.includes(key)));
    checks.push({
      name: "No answer carries a file's storage key",
      ok: keys.length >= 2 && !leaked,
      detail: keys.length < 2 ? "The check couldn't store its test files, so this couldn't be checked." : leaked ? "An answer contained a storage key." : "passed",
    });
  } catch (error) {
    checks.push({ name: "The check ran to the end", ok: false, detail: error instanceof Error ? error.message : String(error) });
  } finally {
    for (const file of planted) {
      try {
        await input.storage.remove({ tenantId: file.tenantId, fileId: file.id });
      } catch {
        /* a leftover 1×1 test file is harmless; the result already says what ran */
      }
    }
  }
  return { ok: checks.length > 0 && checks.every((check) => check.ok), checks };
}
