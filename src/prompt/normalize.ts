export interface PromptPart {
  role: string;
  text: string;
  ordinal: number;
}

function textFromContent(content: unknown, textTypes: Set<string>): string[] {
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  const texts: string[] = [];
  for (const part of content) {
    if (typeof part !== "object" || part === null) continue;
    const value = part as Record<string, unknown>;
    if (typeof value.text === "string" && (value.type === undefined || textTypes.has(String(value.type)))) {
      texts.push(value.text);
    }
  }
  return texts;
}

export function normalizeChatMessages(messages: unknown): PromptPart[] {
  if (!Array.isArray(messages)) throw new Error("messages must be an array");
  const parts: PromptPart[] = [];
  for (const message of messages) {
    if (typeof message !== "object" || message === null) throw new Error("each message must be an object");
    const value = message as Record<string, unknown>;
    if (typeof value.role !== "string") throw new Error("each message must have a role");
    for (const text of textFromContent(value.content, new Set(["text", "input_text"]))) {
      parts.push({ role: value.role, text: normalizeNewlines(text), ordinal: parts.length });
    }
  }
  return parts;
}

export function normalizeAnthropicMessages(system: unknown, messages: unknown): PromptPart[] {
  const parts: PromptPart[] = [];
  for (const text of textFromContent(system, new Set(["text"]))) {
    parts.push({ role: "system", text: normalizeNewlines(text), ordinal: parts.length });
  }
  if (!Array.isArray(messages)) throw new Error("messages must be an array");
  for (const message of messages) {
    if (typeof message !== "object" || message === null) throw new Error("each message must be an object");
    const value = message as Record<string, unknown>;
    if (typeof value.role !== "string") throw new Error("each message must have a role");
    for (const text of textFromContent(value.content, new Set(["text"]))) {
      parts.push({ role: value.role, text: normalizeNewlines(text), ordinal: parts.length });
    }
  }
  return parts;
}

export function normalizeResponseInput(input: unknown): PromptPart[] {
  if (typeof input === "string") return [{ role: "user", text: normalizeNewlines(input), ordinal: 0 }];
  if (!Array.isArray(input)) throw new Error("input must be a string or array");
  const parts: PromptPart[] = [];
  for (const item of input) {
    if (typeof item === "string") {
      parts.push({ role: "user", text: normalizeNewlines(item), ordinal: parts.length });
      continue;
    }
    if (typeof item !== "object" || item === null) continue;
    const value = item as Record<string, unknown>;
    const role = typeof value.role === "string" ? value.role : "user";
    for (const text of textFromContent(value.content, new Set(["input_text", "text"]))) {
      parts.push({ role, text: normalizeNewlines(text), ordinal: parts.length });
    }
  }
  return parts;
}

function normalizeNewlines(value: string): string {
  return value.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
}
