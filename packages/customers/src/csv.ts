/**
 * CSV, read and written (customers 0.1). Pure: no database, safe in a browser.
 *
 * Reading follows RFC 4180 as spreadsheets write it: commas (or semicolons,
 * when the header row has more of them), quoted cells with "" for a quote,
 * line breaks inside quotes, CRLF or LF, a byte-order mark. Writing quotes
 * every cell that needs it, and puts a ' in front of a cell a spreadsheet
 * would run as a formula (=, +, -, @), so an exported list can't run anything
 * when it's opened.
 */

/** The rows of a CSV file, each a list of cells. Blank lines are dropped. */
export function parseCsv(text: string): string[][] {
  const source = text.replace(/^﻿/, "");
  const firstLine = source.split(/\r?\n/, 1)[0] ?? "";
  const delimiter = (firstLine.match(/;/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? ";" : ",";
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i]!;
    if (quoted) {
      if (char === '"') {
        if (source[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else quoted = false;
      } else cell += char;
      continue;
    }
    if (char === '"' && cell === "") quoted = true;
    else if (char === delimiter) {
      row.push(cell);
      cell = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && source[i + 1] === "\n") i += 1;
      row.push(cell);
      if (row.some((value) => value.trim() !== "")) rows.push(row);
      row = [];
      cell = "";
    } else cell += char;
  }
  row.push(cell);
  if (row.some((value) => value.trim() !== "")) rows.push(row);
  return rows;
}

/** Phone numbers as stored ("+14155550123", or several with "; "): a spreadsheet reads them as text, never a formula. */
const PHONES_ONLY = /^\+[1-9]\d{7,14}(?:; \+[1-9]\d{7,14})*$/;

/** One cell, as a spreadsheet can open it safely. */
export function csvCell(value: string | number | null | undefined): string {
  let text = value === null || value === undefined ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(text) && !PHONES_ONLY.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Rows to CSV text (CRLF, as spreadsheets expect). */
export function toCsv(rows: ReadonlyArray<ReadonlyArray<string | number | null | undefined>>): string {
  return rows.map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

/** The columns an import reads, and the headings each answers to (any case, any spacing). */
export const CSV_COLUMNS = {
  name: ["name", "full name", "customer", "customer name", "client", "client name", "contact", "contact name"],
  firstName: ["first name", "firstname", "given name"],
  lastName: ["last name", "lastname", "surname", "family name"],
  companyName: ["company", "company name", "business", "business name", "organization", "organisation"],
  email: ["email", "e-mail", "email address", "e-mail address", "emails"],
  phone: ["phone", "phone number", "telephone", "tel", "mobile", "cell", "cell phone", "phones"],
  address: ["address", "street address", "billing address", "service address", "job address"],
  notes: ["notes", "note", "comments"],
  tags: ["tags", "tag", "labels"],
} as const;

export type CsvColumn = keyof typeof CSV_COLUMNS;

/** Which column each heading is (or null for a column the import ignores). */
export function mapCsvHeader(header: readonly string[]): (CsvColumn | null)[] {
  const fold = (value: string) => value.toLowerCase().replace(/[_\s]+/g, " ").trim();
  const taken = new Set<CsvColumn>();
  return header.map((heading) => {
    const folded = fold(heading);
    for (const [column, names] of Object.entries(CSV_COLUMNS) as [CsvColumn, readonly string[]][]) {
      if (!taken.has(column) && names.includes(folded)) {
        taken.add(column);
        return column;
      }
    }
    return null;
  });
}

/**
 * A chosen file's bytes as text: UTF-8 when they are UTF-8, else Windows-1252
 * (what Excel's plain "CSV" saves on Windows), so "José" stays "José".
 */
export function decodeCsvBytes(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("windows-1252").decode(bytes);
  }
}

/** Text that was read with the wrong encoding somewhere along the way (U+FFFD where letters were). */
export function hasReplacementCharacters(text: string): boolean {
  return text.includes(String.fromCharCode(0xfffd));
}
