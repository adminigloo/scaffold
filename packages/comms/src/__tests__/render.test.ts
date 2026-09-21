import { describe, expect, it } from "vitest";
import { renderTemplate, templateVariables } from "../render.js";

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
