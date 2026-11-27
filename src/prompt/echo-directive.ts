import type { PromptPart } from "@/src/prompt/normalize";

export const FUNCTION_HELP = `Available functions:
- echo(text): returns text exactly as provided
- return(code=..., latency=..., retry=..., response_text="..."): controls the mock response`;

export function findEchoDirective(parts: PromptPart[]): string | undefined {
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const text = parts[index].rawText;
    if (!text.startsWith("echo(") || !text.endsWith(")")) continue;
    return text.slice("echo(".length, -1);
  }
  return undefined;
}
