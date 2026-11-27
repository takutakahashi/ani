import type { PromptPart } from "@/src/prompt/normalize";

export const FUNCTION_HELP = `Available functions:

echo
  Usage: echo(text)
  Inputs:
    text: text to return exactly as provided
  Example: echo(Hello, world!)

return
  Usage: return(code=..., latency=..., retry=..., response_text="...", return_debug_response=...)
  Inputs (all optional):
    code: HTTP status code from 200 to 599
    latency: response delay using ms, s, or m
    retry: Retry-After header value in seconds
    response_text: response body as a JSON string
    return_debug_response: return request details instead of response_text (true or false)
  Example: return(code=429, latency=500ms, retry=3, response_text="Try again")`;

export function findEchoDirective(parts: PromptPart[]): string | undefined {
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const text = parts[index].rawText;
    if (!text.startsWith("echo(") || !text.endsWith(")")) continue;
    return text.slice("echo(".length, -1);
  }
  return undefined;
}
