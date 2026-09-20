import { describe, expect, it } from "vitest";
import { buildTakeoffPrompt, parseTakeoff } from "../takeoff.js";

describe("buildTakeoffPrompt", () => {
  it("walks a ramp through the ADA rise→run relationship", () => {
    const prompt = buildTakeoffPrompt("linear", "Modular aluminum ramp");
    expect(prompt).toContain("linearFt");
    expect(prompt).toContain("1:12");
    expect(prompt).toContain("Modular aluminum ramp");
  });

  it("asks for square feet in area mode and a count in unit mode", () => {
    expect(buildTakeoffPrompt("area")).toContain("sqFt");
    expect(buildTakeoffPrompt("unit")).toContain("units");
  });
});

describe("parseTakeoff", () => {
  it("reads a clean JSON object", () => {
    const result = parseTakeoff(
      '{"sqFt":null,"linearFt":24,"units":null,"confidence":"medium","summary":"About a 24 ft run.","assumptions":["~24in rise assumed"]}',
    );
    expect(result).not.toBeNull();
    expect(result?.linearFt).toBe(24);
    expect(result?.confidence).toBe("medium");
    expect(result?.assumptions).toEqual(["~24in rise assumed"]);
  });

  it("tolerates a code fence and leading prose", () => {
    const result = parseTakeoff('Here is my estimate:\n```json\n{"units":3,"sqFt":null,"linearFt":null,"confidence":"high","summary":"three","assumptions":[]}\n```');
    expect(result?.units).toBe(3);
  });

  it("defaults a bad confidence to low and rejects an all-null answer", () => {
    expect(parseTakeoff('{"sqFt":10,"linearFt":null,"units":null,"confidence":"???","summary":"","assumptions":[]}')?.confidence).toBe("low");
    expect(parseTakeoff('{"sqFt":null,"linearFt":null,"units":null,"confidence":"high","summary":"","assumptions":[]}')).toBeNull();
  });

  it("returns null on non-JSON", () => {
    expect(parseTakeoff("the model refused")).toBeNull();
  });
});
