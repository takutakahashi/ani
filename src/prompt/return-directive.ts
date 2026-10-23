import type { PromptPart } from "@/src/prompt/normalize";

export interface ReturnDirective {
  status?: number;
  latencyMs?: number;
  retryAfter?: string;
  responseText?: string;
  debugResponse?: boolean;
}

const KEY_ALIASES: Record<string, keyof ReturnDirective> = {
  code: "status", status: "status", latency: "latencyMs", retry: "retryAfter", retry_after: "retryAfter",
  response_text: "responseText", return_debug_response: "debugResponse", return_debug_responce: "debugResponse",
};

export function findReturnDirective(parts: PromptPart[]): ReturnDirective | undefined {
  let result: ReturnDirective | undefined;
  for (const part of parts) {
    for (const argumentsText of findCalls(part.text)) {
      const parsed = parseArguments(argumentsText);
      if (parsed !== undefined) result = parsed;
    }
  }
  return result;
}

function findCalls(text: string): string[] {
  const calls: string[] = [];
  const startPattern = /(?:^|\s)return\s*\(/gi;
  for (const match of text.matchAll(startPattern)) {
    const start = (match.index ?? 0) + match[0].length;
    let quoted = false;
    let escaped = false;
    for (let index = start; index < text.length; index += 1) {
      const character = text[index];
      if (escaped) escaped = false;
      else if (character === "\\" && quoted) escaped = true;
      else if (character === '"') quoted = !quoted;
      else if (character === ")" && !quoted) {
        calls.push(text.slice(start, index));
        break;
      }
    }
  }
  return calls;
}

function parseArguments(source: string): ReturnDirective | undefined {
  const directive: ReturnDirective = {};
  let recognized = 0;
  for (const argument of splitArguments(source)) {
    const separator = argument.indexOf("=");
    if (separator < 1) return undefined;
    const key = KEY_ALIASES[argument.slice(0, separator).trim().toLowerCase()];
    if (key === undefined) continue;
    const value = argument.slice(separator + 1).trim();
    if (!assignValue(directive, key, value)) return undefined;
    recognized += 1;
  }
  return recognized === 0 ? undefined : directive;
}

function splitArguments(source: string): string[] {
  const result: string[] = [];
  let start = 0;
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (escaped) escaped = false;
    else if (character === "\\" && quoted) escaped = true;
    else if (character === '"') quoted = !quoted;
    else if (character === "," && !quoted) {
      result.push(source.slice(start, index).trim());
      start = index + 1;
    }
  }
  result.push(source.slice(start).trim());
  return result;
}

function assignValue(directive: ReturnDirective, key: keyof ReturnDirective, value: string): boolean {
  if (key === "status") {
    if (!/^\d{3}$/.test(value)) return false;
    const status = Number(value);
    if (status < 200 || status > 599) return false;
    directive.status = status;
    return true;
  }
  if (key === "latencyMs") {
    const match = /^(\d+(?:\.\d+)?)\s*(ms|m|s)$/i.exec(value);
    if (match === null) return false;
    directive.latencyMs = Number(match[1]) * (match[2].toLowerCase() === "s" ? 1_000 : 1);
    return true;
  }
  if (key === "retryAfter") {
    if (!/^\d+(?:\.\d+)?$/.test(value)) return false;
    directive.retryAfter = value;
    return true;
  }
  if (key === "responseText") {
    try {
      const parsed: unknown = JSON.parse(value);
      if (typeof parsed !== "string") return false;
      directive.responseText = parsed;
      return true;
    } catch { return false; }
  }
  if (!/^(?:true|false)$/i.test(value)) return false;
  directive.debugResponse = value.toLowerCase() === "true";
  return true;
}
