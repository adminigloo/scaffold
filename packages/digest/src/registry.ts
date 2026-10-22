import type { SafeHtml } from "./html.js";
import type { DigestDay } from "./time.js";

/**
 * THE EMAILS A PERSON CAN CHOOSE (digest 0.1), declared once by the project:
 *
 *   digests  sent at most once a day, at the person's hour in their zone,
 *            built from SECTIONS: each a server function of the person and
 *            the day that returns a title, plain text and HTML — or null when
 *            it has nothing to say that day. A day where every section is
 *            null sends nothing.
 *   alerts   sent when something happens (a price crossed a line, a result
 *            was posted), through `digests.sendAlert`, only to the people who
 *            chose that kind.
 *
 * Every kind is OFF until the person says yes, and each has its own
 * unsubscribe: stopping one never touches another.
 *
 * A KIND KEY IS PERMANENT. It is stored on every choice a person makes and
 * on every row of the ledger; rename a title freely, never a key.
 */

/** Who a digest or an alert is for, as the host describes them. */
export interface DigestPerson {
  readonly userId: string;
  /** Where it goes: their verified sign-in address. */
  readonly email: string;
  readonly name: string | null;
}

/** A person with the clock their digest runs on. */
export interface DigestRecipient extends DigestPerson {
  /** Their zone, or the site's when they have none. */
  readonly timeZone: string;
  /** The local hour their digests come at or after. */
  readonly deliveryHour: number;
}

/** What one section says on one day. */
export interface DigestSectionContent {
  /** Its heading in the email. One line. */
  readonly title: string;
  /** The plain-text body. */
  readonly text: string;
  /** The HTML body: made with the `html` tag, so every value in it is escaped. */
  readonly html: SafeHtml;
}

export interface DigestSection {
  /** Unique within its digest; recorded on the ledger. */
  readonly key: string;
  /**
   * The section for this person on this day, or null when it has nothing to
   * say. A throw leaves the section out (and is reported); the rest still go.
   */
  readonly render: (person: DigestRecipient, day: DigestDay) => DigestSectionContent | null | Promise<DigestSectionContent | null>;
}

export interface DigestSpec {
  readonly key: string;
  /** "Morning summary": its name in the preferences, the email and the unsubscribe page. */
  readonly title: string;
  /** One sentence: what it brings. Shown beside its checkbox at sign-up and in the preferences. */
  readonly description: string;
  /** In order. A digest with none is listed nowhere. */
  readonly sections: readonly DigestSection[];
  /** The email's subject. Default "{title}: {day}" ("Morning summary: Tuesday, October 21"). */
  readonly subject?: (person: DigestRecipient, day: DigestDay) => string;
}

export interface AlertKindSpec {
  readonly key: string;
  /** "Price alerts". */
  readonly title: string;
  /** One sentence: when it comes. */
  readonly description: string;
}

/** One email kind, as the preferences, the links and the ledger know it. */
export interface EmailKind {
  readonly type: "digest" | "alert";
  readonly key: string;
  readonly title: string;
  readonly description: string;
}

export interface EmailKinds {
  readonly digests: readonly DigestSpec[];
  readonly alerts: readonly AlertKindSpec[];
  /** Every kind a person can choose (digests with at least one section, then alerts). */
  readonly offered: readonly EmailKind[];
  kind(key: string): EmailKind | null;
  digest(key: string): DigestSpec | null;
}

export class InvalidEmailKindError extends Error {
  readonly name = "InvalidEmailKindError";
}

export const KIND_KEY = /^[a-z][a-z0-9-]{0,39}$/;
const SECTION_KEY = /^[a-z][a-z0-9-]{0,39}$/;

function line(value: unknown, what: string): string {
  if (typeof value !== "string" || value.trim() === "" || /[\r\n]/.test(value)) {
    throw new InvalidEmailKindError(`${what} must be one line of text`);
  }
  return value.trim();
}

/** The project's emails, checked once at load: a bad or repeated key is refused here, not on the first send. */
export function defineEmailKinds(input: { readonly digests?: readonly DigestSpec[]; readonly alerts?: readonly AlertKindSpec[] }): EmailKinds {
  const digests = [...(input.digests ?? [])];
  const alerts = [...(input.alerts ?? [])];
  const keys = new Set<string>();
  const claim = (key: unknown, what: string): string => {
    if (typeof key !== "string" || !KIND_KEY.test(key)) {
      throw new InvalidEmailKindError(`${what} key ${JSON.stringify(key)} must be lowercase letters, digits and hyphens, starting with a letter (at most 40)`);
    }
    if (keys.has(key)) throw new InvalidEmailKindError(`"${key}" is used twice: every digest and alert kind needs its own key`);
    keys.add(key);
    return key;
  };
  for (const digest of digests) {
    const key = claim(digest.key, "a digest's");
    line(digest.title, `digest "${key}"'s title`);
    line(digest.description, `digest "${key}"'s description`);
    if (!Array.isArray(digest.sections)) throw new InvalidEmailKindError(`digest "${key}" needs a list of sections`);
    const sections = new Set<string>();
    for (const section of digest.sections) {
      if (typeof section?.key !== "string" || !SECTION_KEY.test(section.key)) {
        throw new InvalidEmailKindError(`digest "${key}" has a section key ${JSON.stringify(section?.key)} that isn't lowercase letters, digits and hyphens`);
      }
      if (sections.has(section.key)) throw new InvalidEmailKindError(`digest "${key}" has two sections called "${section.key}"`);
      sections.add(section.key);
      if (typeof section.render !== "function") throw new InvalidEmailKindError(`section "${section.key}" of digest "${key}" needs a render function`);
    }
  }
  for (const alert of alerts) {
    const key = claim(alert.key, "an alert kind's");
    line(alert.title, `alert kind "${key}"'s title`);
    line(alert.description, `alert kind "${key}"'s description`);
  }
  const offered: EmailKind[] = [
    ...digests
      .filter((digest) => digest.sections.length > 0)
      .map((digest) => ({ type: "digest" as const, key: digest.key, title: digest.title.trim(), description: digest.description.trim() })),
    ...alerts.map((alert) => ({ type: "alert" as const, key: alert.key, title: alert.title.trim(), description: alert.description.trim() })),
  ];
  const byKey = new Map(offered.map((kind) => [kind.key, kind]));
  const digestByKey = new Map(digests.map((digest) => [digest.key, digest]));
  return Object.freeze({
    digests: Object.freeze(digests),
    alerts: Object.freeze(alerts),
    offered: Object.freeze(offered),
    kind: (key: string) => byKey.get(key) ?? null,
    digest: (key: string) => digestByKey.get(key) ?? null,
  });
}
