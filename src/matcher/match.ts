import type { Rule } from "@/src/config/schema";
import type { PromptPart } from "@/src/prompt/normalize";

export interface MatchInput {
  model: string;
  headers: Headers;
  parts: PromptPart[];
}

export function selectRule(rules: Rule[], input: MatchInput): Rule | undefined {
  return rules
    .map((rule, index) => ({ rule, index }))
    .sort((a, b) => b.rule.priority - a.rule.priority || a.index - b.index)
    .find(({ rule }) => matches(rule, input))?.rule;
}

function matches(rule: Rule, input: MatchInput): boolean {
  const condition = rule.match;
  if (condition.model !== undefined && !globMatches(condition.model, input.model)) return false;
  if (condition.headers !== undefined) {
    for (const [name, expected] of Object.entries(condition.headers)) {
      if (input.headers.get(name) !== expected) return false;
    }
  }

  let parts = input.parts;
  if (condition.roles !== undefined) parts = parts.filter((part) => condition.roles?.includes(part.role));
  if (condition.text === undefined) return condition.roles === undefined || parts.length > 0;

  const text = parts.map((part) => part.text).join("\n");
  const textRule = condition.text;
  const actual = textRule.case_sensitive ? text : text.toLocaleLowerCase();
  const normalize = (value: string): string => (textRule.case_sensitive ? value : value.toLocaleLowerCase());

  if (textRule.equals !== undefined && actual !== normalize(textRule.equals)) return false;
  if (textRule.contains !== undefined) {
    const results = textRule.contains.map((value) => actual.includes(normalize(value)));
    if (textRule.mode === "all" ? !results.every(Boolean) : !results.some(Boolean)) return false;
  }
  if (textRule.regex !== undefined) {
    const regex = new RegExp(textRule.regex, textRule.case_sensitive ? "" : "i");
    if (!regex.test(text)) return false;
  }
  return true;
}

function globMatches(pattern: string, value: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*").replaceAll("?", ".");
  return new RegExp(`^${escaped}$`).test(value);
}
