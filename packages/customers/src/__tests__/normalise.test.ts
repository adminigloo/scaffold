import { describe, expect, it } from "vitest";
import { csvCell, mapCsvHeader, parseCsv, toCsv } from "../csv.js";
import { addressMatchKey, emailMatchKey, normaliseEmail, normalisePhone } from "../normalise.js";

describe("emails", () => {
  it("keeps an email lower case and trimmed, and refuses what isn't one", () => {
    expect(normaliseEmail("  Mrs.Lee@Example.COM ")).toBe("mrs.lee@example.com");
    expect(normaliseEmail("mailto:a@b.co")).toBe("a@b.co");
    expect(normaliseEmail("bob@")).toBeNull();
    expect(normaliseEmail("no at sign")).toBeNull();
    expect(normaliseEmail(null)).toBeNull();
  });

  it("folds Gmail's dots and +tags for matching only", () => {
    expect(emailMatchKey("M.Lee+quotes@gmail.com")).toBe("e:mlee@gmail.com");
    expect(emailMatchKey("mlee@googlemail.com")).toBe("e:mlee@gmail.com");
    expect(normaliseEmail("M.Lee+quotes@gmail.com")).toBe("m.lee+quotes@gmail.com");
  });

  it("matches other providers as written, so two people never become one", () => {
    expect(emailMatchKey("m.lee@example.com")).not.toBe(emailMatchKey("mlee@example.com"));
    expect(emailMatchKey("lee+work@example.com")).toBe("e:lee+work@example.com");
  });
});

describe("phones", () => {
  it("reads North American numbers however they're written", () => {
    for (const written of ["(415) 555-0123", "415.555.0123", "1 415 555 0123", "+1 415-555-0123", "4155550123 x12", "tel:+14155550123"]) {
      expect(normalisePhone(written), written).toBe("+14155550123");
    }
  });

  it("reads a number in the business's own country, and any number written with + or 00", () => {
    expect(normalisePhone("020 7946 0958", "GB")).toBe("+442079460958");
    expect(normalisePhone("0412 345 678", "AU")).toBe("+61412345678");
    expect(normalisePhone("+44 20 7946 0958", "US")).toBe("+442079460958");
    expect(normalisePhone("0044 20 7946 0958", "US")).toBe("+442079460958");
  });

  it("refuses what it can't read rather than guessing", () => {
    expect(normalisePhone("555-0123")).toBeNull();
    expect(normalisePhone("12")).toBeNull();
    expect(normalisePhone("call me")).toBeNull();
    expect(normalisePhone("(055) 555-0123")).toBeNull();
    expect(normalisePhone("020 7946 0958", "ZZ")).toBeNull();
  });

  it("compares addresses without case or punctuation", () => {
    expect(addressMatchKey("12 Elm St., Apt #4")).toBe(addressMatchKey("12 elm st apt 4"));
    expect(addressMatchKey("   ")).toBeNull();
  });
});

describe("csv", () => {
  it("reads quotes, doubled quotes, line breaks inside quotes, CRLF and a BOM", () => {
    const rows = parseCsv('﻿Name,Notes\r\n"Lee, May","said ""hi""\nthen left"\r\n\r\nBo,x\n');
    expect(rows).toEqual([
      ["Name", "Notes"],
      ["Lee, May", 'said "hi"\nthen left'],
      ["Bo", "x"],
    ]);
  });

  it("reads a semicolon file when the heading row uses semicolons", () => {
    expect(parseCsv("Name;Email\nLee;l@x.co")).toEqual([
      ["Name", "Email"],
      ["Lee", "l@x.co"],
    ]);
  });

  it("writes cells a spreadsheet can't run as a formula", () => {
    expect(csvCell("=HYPERLINK(1)")).toBe("'=HYPERLINK(1)");
    expect(csvCell("+1 415")).toBe("'+1 415");
    expect(csvCell('a "b", c')).toBe('"a ""b"", c"');
    expect(toCsv([["a", null], [1, "x"]])).toBe("a,\r\n1,x\r\n");
  });

  it("knows the usual headings in any case", () => {
    expect(mapCsvHeader(["Full Name", "E-mail", "Mobile", "Street Address", "Favourite colour"])).toEqual(["name", "email", "phone", "address", null]);
  });
});
