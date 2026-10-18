/**
 * HOW TWO CONTACT DETAILS ARE "THE SAME" (customers 0.1). Pure: no database,
 * safe in a browser.
 *
 *   email   kept lower case and trimmed, as the customer typed it otherwise.
 *           For MATCHING only, a Gmail address also drops the dots and any
 *           "+tag" before the @ (googlemail.com reads as gmail.com), because
 *           Gmail delivers m.lee+quotes@gmail.com to mlee@gmail.com. Other
 *           providers are matched as written: folding them could make two
 *           different people one customer.
 *   phone   E.164 ("+14155550123"), read with the business's own country
 *           when the number has no "+" or "00" in front. A number that can't
 *           be read is no phone (null), never a guess.
 *
 * A match key is "e:<folded email>" or "p:<E.164>", so one list of keys holds
 * both kinds.
 */

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The email to keep (lower case, trimmed), or null when it isn't one. */
export function normaliseEmail(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase().replace(/^mailto:/, "");
  if (email.length > 254 || !EMAIL_SHAPE.test(email)) return null;
  return email;
}

const GMAIL = new Set(["gmail.com", "googlemail.com"]);

/** The email as it is matched: Gmail's dots and +tags folded away. Null when it isn't an email. */
export function emailMatchKey(value: string | null | undefined): string | null {
  const email = normaliseEmail(value);
  if (!email) return null;
  const at = email.lastIndexOf("@");
  let local = email.slice(0, at);
  let domain = email.slice(at + 1);
  if (GMAIL.has(domain)) {
    domain = "gmail.com";
    local = local.split("+")[0]!.replace(/\./g, "");
    if (local === "") return null;
  }
  return `e:${local}@${domain}`;
}

/**
 * Calling codes for the countries a business here is most likely in, and
 * whether a leading 0 is the trunk prefix dropped after the code. A country
 * not listed reads only numbers written with "+" (or "00").
 */
const COUNTRIES: Readonly<Record<string, { readonly code: string; readonly trunk: boolean; readonly national: readonly number[] }>> = {
  US: { code: "1", trunk: false, national: [10] },
  CA: { code: "1", trunk: false, national: [10] },
  GB: { code: "44", trunk: true, national: [9, 10] },
  IE: { code: "353", trunk: true, national: [7, 8, 9] },
  AU: { code: "61", trunk: true, national: [9] },
  NZ: { code: "64", trunk: true, national: [8, 9, 10] },
  DE: { code: "49", trunk: true, national: [6, 7, 8, 9, 10, 11] },
  FR: { code: "33", trunk: true, national: [9] },
  ES: { code: "34", trunk: false, national: [9] },
  IT: { code: "39", trunk: false, national: [6, 7, 8, 9, 10, 11] },
  NL: { code: "31", trunk: true, national: [9] },
  MX: { code: "52", trunk: false, national: [10] },
  ZA: { code: "27", trunk: true, national: [9] },
  IN: { code: "91", trunk: true, national: [10] },
};

/** The countries `normalisePhone` can read a national number in. */
export const PHONE_COUNTRIES: readonly string[] = Object.keys(COUNTRIES);

/**
 * The phone as E.164, or null when it can't be read. `defaultCountry` (ISO
 * 3166 alpha-2, default "US") reads a number written without "+".
 * Extensions ("x 12", "ext. 12") are dropped: they ring the same line.
 */
export function normalisePhone(value: string | null | undefined, defaultCountry = "US"): string | null {
  if (typeof value !== "string") return null;
  let text = value.trim().replace(/^tel:/i, "");
  text = text.replace(/\s*(?:ext\.?|extension|x|#)\s*\d{1,6}\s*$/i, "");
  if (text === "" || /[a-z]/i.test(text)) return null;
  const plus = text.startsWith("+");
  let digits = text.replace(/\D/g, "");
  if (digits === "") return null;
  let international = plus;
  const home = COUNTRIES[defaultCountry.toUpperCase()];
  if (!plus && digits.startsWith("00")) {
    digits = digits.slice(2);
    international = true;
  } else if (!plus && home?.code === "1" && digits.startsWith("011")) {
    // North America dials out with 011: "011 44 20 7946 0958" is +44 20 7946 0958.
    digits = digits.slice(3);
    international = true;
  }
  if (!international) {
    const country = home;
    if (!country) return null;
    let national = digits;
    // "1 415 555 0123" in North America: the 1 is the country code already.
    if (country.code === "1" && national.length === 11 && national.startsWith("1")) national = national.slice(1);
    else if (country.trunk && national.startsWith("0")) national = national.slice(1);
    if (!country.national.includes(national.length)) return null;
    if (country.code === "1" && !/^[2-9]\d{2}[2-9]/.test(national)) return null;
    digits = country.code + national;
  }
  if (digits.startsWith("0") || digits.length < 8 || digits.length > 15) return null;
  if (digits.startsWith("1") && (digits.length !== 11 || !/^1[2-9]\d{2}[2-9]/.test(digits))) return null;
  // A number in a listed country has that country's length after its code
  // (unless another listed code reads it whole).
  const listed = Object.values(COUNTRIES).filter((country) => country.code !== "1" && digits.startsWith(country.code));
  if (listed.length > 0 && !listed.some((country) => country.national.includes(digits.length - country.code.length))) return null;
  return `+${digits}`;
}

/** "+14155550123" and nothing else: a whole number written the way it is stored. */
export function isE164(value: string): boolean {
  return /^\+[1-9]\d{7,14}$/.test(value);
}

/** The digits of a search that looks like part of a phone number ("(415) 555"), or null. */
export function phoneSearchDigits(value: string): string | null {
  if (!/^[\d\s().+-]+$/.test(value)) return null;
  const digits = value.replace(/\D/g, "");
  return digits.length >= 3 ? digits : null;
}

/** The phone as it is matched. */
export function phoneMatchKey(value: string | null | undefined, defaultCountry = "US"): string | null {
  const phone = normalisePhone(value, defaultCountry);
  return phone ? `p:${phone}` : null;
}

/** An address as it is compared: lower case, punctuation and runs of space folded. */
export function addressMatchKey(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const key = value
    .toLowerCase()
    .replace(/[.,#]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return key === "" ? null : key.slice(0, 500);
}

/** One line of plain text, at most `max` characters (names, summaries). */
export function oneLine(value: string | null | undefined, max: number): string {
  if (typeof value !== "string") return "";
  return value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}
