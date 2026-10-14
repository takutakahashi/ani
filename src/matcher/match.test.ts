import { describe, expect, it } from "vitest";
import { parseConfig } from "@/src/config/load";
import { selectRule } from "./match";

describe("selectRule", () => {
  it("uses priority and filters text by role", () => {
    const config = parseConfig(
      `version: 1
rules:
  - id: low
    priority: 1
    match:
      text: { contains: [needle] }
    response: { text: low }
  - id: high
    priority: 2
    match:
      roles: [user]
      text: { contains: [needle] }
    response: { text: high }
`,
      ".yaml",
    );
    const rule = selectRule(config.rules, {
      model: "ani-1",
      headers: new Headers(),
      parts: [
        { role: "system", text: "needle", ordinal: 0 },
        { role: "user", text: "needle", ordinal: 1 },
      ],
    });
    expect(rule?.id).toBe("high");
  });

  it("matches model globs and headers", () => {
    const config = parseConfig(
      `version: 1
rules:
  - id: selected
    match:
      model: "gpt-*"
      headers: { x-test: yes }
    response: { text: ok }
`,
      ".yaml",
    );
    expect(
      selectRule(config.rules, {
        model: "gpt-mock",
        headers: new Headers({ "x-test": "yes" }),
        parts: [],
      })?.id,
    ).toBe("selected");
  });
});
