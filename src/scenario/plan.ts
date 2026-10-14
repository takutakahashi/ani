import type { AniConfig, LatencySpec, ResponseSpec, Rule } from "@/src/config/schema";
import type { PromptPart } from "@/src/prompt/normalize";

export interface ResponsePlan {
  status: number;
  headers: Record<string, string>;
  latencyMs: number;
  text: string;
  inputTokens: number;
  outputTokens: number;
  error?: { type: string; code: string | null; message: string; param: string | null };
  ruleId?: string;
}

export function createPlan(config: AniConfig, rule: Rule | undefined, model: string, parts: PromptPart[]): ResponsePlan {
  const defaults = config.defaults.response;
  const selected = rule?.response;
  const response: ResponseSpec = {
    ...defaults,
    ...selected,
    headers: { ...defaults.headers, ...selected?.headers },
  };
  const requestFingerprint = `${model}\n${parts.map((part) => `${part.role}:${part.text}`).join("\n")}`;
  const random = randomValue(config.server.seed, `${rule?.id ?? "default"}\n${requestFingerprint}`);
  const baseText = chooseText(response, random);
  const requestedOutputTokens = response.output_tokens ?? estimateTokens(baseText);
  const text = response.token_mode === "padded" ? padToTokens(baseText, requestedOutputTokens) : baseText;
  const latency = response.latency ?? config.defaults.latency;

  return {
    status: response.status,
    headers: response.headers,
    latencyMs: latency === undefined ? 0 : latencyMilliseconds(latency, random),
    text,
    inputTokens: response.input_tokens ?? estimateTokens(parts.map((part) => part.text).join("\n")),
    outputTokens: requestedOutputTokens,
    error: response.error,
    ruleId: rule?.id,
  };
}

function chooseText(response: ResponseSpec, random: number): string {
  if (response.random === undefined) return response.text ?? "";
  const total = response.random.reduce((sum, candidate) => sum + candidate.weight, 0);
  let cursor = random * total;
  for (const candidate of response.random) {
    cursor -= candidate.weight;
    if (cursor < 0) return candidate.text;
  }
  return response.random.at(-1)?.text ?? "";
}

export function parseDuration(value: string | number): number {
  if (typeof value === "number") return value;
  const match = /^(\d+(?:\.\d+)?)(ms|s|m)$/.exec(value);
  if (match === null) throw new Error(`invalid duration: ${value}`);
  const amount = Number(match[1]);
  return amount * (match[2] === "ms" ? 1 : match[2] === "s" ? 1_000 : 60_000);
}

function latencyMilliseconds(spec: LatencySpec, random: number): number {
  if (typeof spec === "string" || typeof spec === "number") return parseDuration(spec);
  if (spec.distribution === "fixed") return parseDuration(spec.value);
  if (spec.distribution === "uniform") {
    const min = parseDuration(spec.min);
    return min + random * (parseDuration(spec.max) - min);
  }
  const mean = parseDuration(spec.mean);
  const stddev = parseDuration(spec.stddev);
  const second = Math.max(randomValue("normal", String(random)), Number.EPSILON);
  const normal = Math.sqrt(-2 * Math.log(Math.max(random, Number.EPSILON))) * Math.cos(2 * Math.PI * second);
  return Math.max(0, Math.min(mean + normal * stddev, spec.max === undefined ? Infinity : parseDuration(spec.max)));
}

function randomValue(seed: string | number | undefined, input: string): number {
  if (seed === undefined) return crypto.getRandomValues(new Uint32Array(1))[0] / 0x1_0000_0000;
  let hash = 2_166_136_261;
  for (const char of `${seed}\0${input}`) {
    hash ^= char.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0) / 0x1_0000_0000;
}

export function estimateTokens(text: string): number {
  return text.length === 0 ? 0 : Math.ceil([...text].length / 4);
}

function padToTokens(text: string, target: number): string {
  let result = text;
  while (estimateTokens(result) < target) result += " x";
  return result;
}
