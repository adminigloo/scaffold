/**
 * `@adminigloo/notifications/testing` (Tenancy 2b-1, 4.12; review G19).
 *
 * On a foreign install, keeping each company's alerts to itself rests on the
 * HOST's seams: `resolveTenant` (which company a request is for),
 * `authorize` (is this person a member of it, holding the permission) and
 * `people` (who in it holds a permission). The package's own tests fake
 * those. `checkHostSeams` runs a short list of checks against the host's REAL
 * seams, as mounted, so the host's developer can show the business owner a
 * passing list:
 *
 *   A member of Company A can see their alerts in Company A: passed
 *   A member of Company A can't read Company B's alerts: passed
 *   …
 *
 * It writes nothing, and never throws (a throw is a failed line).
 *
 * Review FH-4: the host's likeliest mistakes were all passing: an authorize
 * that checks membership but not the permission, and a people() (or an
 * authorize) that forgets a suspended company. Pass `authorize` and
 * `suspendedCompany` and those are checked too; leave either out and its
 * line FAILS, "Not checked: pass …", as storage's `withoutFiles` line does:
 * an owner is never shown a passing list for a promise nobody checked.
 * Review FH-5: a company looked up as a number (`Number("017")` is 17)
 * answers at look-alike addresses, each a second company with its own
 * alerts; that is always checked.
 */

export interface HostSeamsCheckResult {
  readonly ok: boolean;
  /** One line per check, in plain words: "A member of Company A can't read Company B's alerts: passed". */
  readonly checks: readonly { readonly name: string; readonly ok: boolean; readonly detail: string }[];
}

export interface CheckHostSeamsInput {
  /** The host's mounted handlers (`createNotificationHandlers(…)`, as the host builds them). */
  readonly handlers: { handle(req: Request): Promise<Response> };
  /**
   * Builds a request to `path` (e.g. "v1/admin/count") IN company `tenantId`,
   * the way the host routes a company (a path segment, a header, a cookie),
   * signed in as `member`: an active member of A and NOT of B. `init` may add
   * a query string or a body. It may be async, e.g. to mint a session cookie
   * (review FH-10).
   */
  readonly request: (
    tenantId: string,
    path: string,
    init?: { readonly method?: string; readonly query?: Readonly<Record<string, string>>; readonly body?: unknown },
  ) => Request | Promise<Request>;
  readonly companyA: string;
  readonly companyB: string;
  readonly member: { readonly userId: string };
  /** The host's `people` seam, checked directly. */
  readonly people?: (tenantId: string, permission: string) => Promise<readonly { readonly userId: string }[]>;
  /** A permission the member holds in A (default "alerts.view"). */
  readonly permission?: string;
  /**
   * The host's `authorize` seam, checked directly (review FH-4): asked, for
   * the member in A, about a permission they DON'T hold, it must refuse
   * (false, null or a Response). Without it that line fails with "Not
   * checked".
   */
  readonly authorize?: (req: Request, permission: string, tenantId: string) => unknown;
  /** A permission the member doesn't hold in A, for that line (default a made-up one no catalog has). */
  readonly withoutPermission?: string;
  /**
   * A company the member ALSO belongs to, which the host has suspended
   * (review FH-4): `people` must answer [] for it, and the handlers must
   * refuse it. Without it that line fails with "Not checked".
   */
  readonly suspendedCompany?: string;
}

/** No catalog has this key: an authorize that grants it isn't looking at the permission at all. */
export const CHECK_PERMISSION_NOBODY_HOLDS = "adminigloo.check.nobody-holds-this";

function describe(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}

async function errorCode(res: Response): Promise<string | null> {
  try {
    const body = (await res.clone().json()) as { error?: { code?: unknown } };
    return typeof body?.error?.code === "string" ? body.error.code : null;
  } catch {
    return null;
  }
}

const refused = (status: number) => status === 401 || status === 403 || status === 404;

/** An `authorize` answer that grants: true or an object (never a Response). The handlers' rule. */
const grants = (verdict: unknown) => verdict === true || (typeof verdict === "object" && verdict !== null && !(verdict instanceof Response));

export async function checkHostSeams(input: CheckHostSeamsInput): Promise<HostSeamsCheckResult> {
  const checks: { name: string; ok: boolean; detail: string }[] = [];
  const run = async (name: string, check: () => Promise<{ ok: boolean; detail: string }>) => {
    try {
      const outcome = await check();
      checks.push({ name, ...outcome });
    } catch (error) {
      checks.push({ name, ok: false, detail: `the check couldn't run: ${describe(error)}` });
    }
  };
  const A = input.companyA;
  const B = input.companyB;
  const request = (tenantId: string, path: string, init?: Parameters<CheckHostSeamsInput["request"]>[2]) => Promise.resolve(input.request(tenantId, path, init));
  const handle = async (tenantId: string, path: string, init?: Parameters<CheckHostSeamsInput["request"]>[2]) => input.handlers.handle(await request(tenantId, path, init));
  const permission = input.permission ?? "alerts.view";
  const member = String(input.member.userId);

  // 1. The member reaches their own company.
  await run("A member of Company A can see their alerts in Company A", async () => {
    const res = await handle(A, "v1/admin/count");
    return res.status === 200
      ? { ok: true, detail: "answered 200" }
      : { ok: false, detail: `answered ${res.status}: the member should get their alert count in their own company` };
  });

  // 2. …and never another company's.
  await run("A member of Company A can't read Company B's alerts", async () => {
    const res = await handle(B, "v1/admin/count");
    return refused(res.status)
      ? { ok: true, detail: `answered ${res.status}` }
      : { ok: false, detail: `answered ${res.status}: your authorize must check that the person is a member of the company in the request` };
  });

  // 3. The company can't be steered by a query string.
  await run("Naming Company A in the address doesn't open Company B's alerts", async () => {
    const res = await handle(B, "v1/admin/count", { query: { tenantId: A, tenant: A } });
    return refused(res.status)
      ? { ok: true, detail: `answered ${res.status}` }
      : { ok: false, detail: `answered ${res.status}: your resolveTenant must read the company from where you route it, never from ?tenantId=` };
  });

  // 4. One company, one id (review FH-5): "017" is not a second Company 17.
  const alias = `0${A}`;
  await run("Company A can't be opened at a look-alike address", async () => {
    const res = await handle(alias, "v1/admin/count");
    return refused(res.status)
      ? { ok: true, detail: `answered ${res.status} for "${alias}"` }
      : {
          ok: false,
          detail:
            `answered ${res.status} for "${alias}": your resolveTenant must take a company's id only exactly as you store it ` +
            `(whole numbers: /^[1-9]\\d*$/) and answer null otherwise; else every look-alike is a second company with its own alerts and choices`,
        };
  });

  // 5. The same-site check holds on a POST.
  await run("A request from another website is refused", async () => {
    const base = await request(A, "v1/admin/read-all", { method: "POST", body: {} });
    const headers = new Headers(base.headers);
    // The browser's own verdict would pass a same-origin request; this one
    // must look exactly like a page on another site posting to the host.
    headers.delete("sec-fetch-site");
    headers.set("sec-fetch-site", "cross-site");
    headers.set("origin", "https://elsewhere.example");
    headers.set("content-type", "application/json");
    const res = await input.handlers.handle(new Request(base.url, { method: "POST", headers, body: "{}" }));
    const code = await errorCode(res);
    return res.status === 403 && code === "cross_site"
      ? { ok: true, detail: "answered 403 cross_site" }
      : { ok: false, detail: `answered ${res.status}${code ? ` ${code}` : ""}: mount the package's handlers as they are, without a layer that rewrites the request's origin` };
  });

  // 6. people() keeps to the company.
  if (input.people) {
    await run("Your people() lists the member in Company A and not in Company B", async () => {
      const inA = await input.people!(A, permission);
      const inB = await input.people!(B, permission);
      const hasA = Array.isArray(inA) && inA.some((person) => String(person?.userId) === member);
      const hasB = Array.isArray(inB) && inB.some((person) => String(person?.userId) === member);
      if (hasA && !hasB) return { ok: true, detail: "the member is in A's list only" };
      if (!hasA) return { ok: false, detail: `people(A, "${permission}") doesn't list the member: alerts would never reach them` };
      return { ok: false, detail: `people(B, "${permission}") lists the member: your people() must keep to the company it is asked about` };
    });
  }

  // 7. authorize looks at the permission (review FH-4). Not passed: a
  // failed line saying what to pass, never a line left out (an authorize
  // that only asks "is this a member?" passes every line above).
  const authorizeName = "Your authorize refuses a permission the member doesn't hold";
  if (!input.authorize) {
    checks.push({
      name: authorizeName,
      ok: false,
      detail:
        "Not checked: pass authorize (your authorize seam, the one your handlers are built with), so an authorize that only checks that someone belongs to the company, and not the permission, can't pass.",
    });
  } else {
    const without = input.withoutPermission ?? CHECK_PERMISSION_NOBODY_HOLDS;
    await run(authorizeName, async () => {
      let verdict: unknown;
      try {
        verdict = await input.authorize!(await request(A, "v1/admin/count"), without, A);
      } catch (error) {
        // The handlers answer a throw with 500: refused, not granted.
        return { ok: true, detail: `threw (${describe(error)}), so it isn't granted` };
      }
      return grants(verdict)
        ? {
            ok: false,
            detail:
              `granted "${without}" to the member in Company A: your authorize must check that the person holds the permission it is asked about, ` +
              `not only that they belong to the company (or every member gets every alert, whatever their role)`,
          }
        : { ok: true, detail: `refused "${without}"` };
    });
  }

  // 8. A suspended company gets nothing (review FH-4). Not passed: a failed
  // line, as above.
  const suspendedName = "A suspended company gets no alerts";
  if (input.suspendedCompany === undefined) {
    checks.push({
      name: suspendedName,
      ok: false,
      detail:
        "Not checked: pass suspendedCompany (a company of yours that is suspended, which the member also belongs to), so a people() or an authorize that forgets a suspended company can't pass.",
    });
  } else {
    const S = input.suspendedCompany;
    await run(suspendedName, async () => {
      const problems: string[] = [];
      if (input.people) {
        const inS = await input.people(S, permission);
        if (Array.isArray(inS) && inS.length > 0) {
          problems.push(`your people() lists people in the suspended company (${inS.length} for "${permission}"): it must answer [] for a suspended company`);
        }
      }
      const res = await handle(S, "v1/admin/count");
      if (!refused(res.status)) problems.push(`the alerts count answered ${res.status} in the suspended company: your authorize must refuse a suspended company`);
      return problems.length === 0 ? { ok: true, detail: `answered ${res.status}` } : { ok: false, detail: problems.join("; ") };
    });
  }

  return { ok: checks.every((check) => check.ok), checks };
}
