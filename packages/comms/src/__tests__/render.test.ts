import { describe, expect, it } from "vitest";
import { missingVariables, renderTemplate, templateVariables } from "../render.js";

describe("renderTemplate", () => {
  it("substitutes variables, tolerating inner whitespace", () => {
    expect(renderTemplate("Hi {{name}}, see you {{ date }}.", { name: "Sam", date: "Mon" })).toBe(
      "Hi Sam, see you Mon.",
    );
  });
  it("renders a missing variable as empty, never leaving braces", () => {
    expect(renderTemplate("Hi {{name}}{{missing}}!", { name: "Sam" })).toBe("Hi Sam!");
  });
  it("stringifies numbers and drops nulls", () => {
    expect(renderTemplate("{{count}} left, {{gone}}", { count: 3, gone: null })).toBe("3 left, ");
  });
});

describe("templateVariables", () => {
  it("lists the distinct placeholders", () => {
    expect(templateVariables("{{a}} {{b}} {{a}}").sort()).toEqual(["a", "b"]);
  });
});

describe("renderTemplate — own properties only", () => {
  it("never renders an inherited Object property into a message", () => {
    // `vars.constructor` walks the prototype chain to Object — the customer
    // used to receive "function Object() { [native code] }".
    expect(renderTemplate("Hi {{constructor}}{{toString}}!", {})).toBe("Hi !");
  });
});

describe("missingVariables", () => {
  it("lists the placeholders across subject and body that have no value", () => {
    expect(
      missingVariables(["Visit on {{date}}", "Hi {{name}}, {{time}} at {{address}}", null], {
        name: "Sam",
        time: null,
      }).sort(),
    ).toEqual(["address", "date", "time"]);
  });
});
