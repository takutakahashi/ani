import { describe, expect, it } from "vitest";
import { parseConfig } from "./load";

describe("parseConfig", () => {
  it("parses equivalent YAML and TOML configurations", () => {
    const yaml = parseConfig(
      `version: 1
defaults:
  model: ani-test
rules: []
`,
      ".yaml",
    );
    const toml = parseConfig(
      `version = 1
rules = []
[defaults]
model = "ani-test"
`,
      ".toml",
    );
    expect(toml).toEqual(yaml);
  });

  it("rejects unknown keys and invalid durations", () => {
    expect(() => parseConfig("version: 1\nunknown: true\n", ".yaml")).toThrow();
    expect(() => parseConfig("version: 1\ndefaults:\n  latency: tomorrow\n", ".yaml")).toThrow();
  });

  it("rejects duplicate rule ids and invalid regular expressions", () => {
    expect(() =>
      parseConfig(
        `version: 1
rules:
  - id: duplicate
    match: {}
    response: {}
  - id: duplicate
    match: {}
    response: {}
`,
        ".yaml",
      ),
    ).toThrow(/duplicate rule id/);
    expect(() =>
      parseConfig(
        `version: 1
rules:
  - id: bad-regex
    match:
      text:
        regex: "["
    response: {}
`,
        ".yaml",
      ),
    ).toThrow(/invalid regex/);
  });
});
