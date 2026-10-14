import { getConfig } from "@/src/config/runtime";
import { selectRule } from "@/src/matcher/match";
import { normalizeChatMessages, normalizeResponseInput, type PromptPart } from "@/src/prompt/normalize";
import { createPlan, type ResponsePlan } from "@/src/scenario/plan";

interface RequestBody {
  model?: unknown;
  messages?: unknown;
  input?: unknown;
  stream?: unknown;
}

export async function handleChatCompletions(request: Request): Promise<Response> {
  return handleGeneration(request, "chat");
}

export async function handleResponses(request: Request): Promise<Response> {
  return handleGeneration(request, "responses");
}

export function handleModels(request: Request): Response {
  const config = getConfig();
  const unauthorized = authenticate(request, config.server.api_key);
  if (unauthorized !== undefined) return unauthorized;
  const now = Math.floor(Date.now() / 1_000);
  return json({
    object: "list",
    data: [{ id: config.defaults.model, object: "model", created: now, owned_by: "ani" }],
  });
}

async function handleGeneration(request: Request, endpoint: "chat" | "responses"): Promise<Response> {
  const started = performance.now();
  const config = getConfig();
  const unauthorized = authenticate(request, config.server.api_key);
  if (unauthorized !== undefined) return unauthorized;

  try {
    const body = await readJson(request, config.server.max_body_bytes);
    if (body.stream === true) return apiError(400, "streaming is not supported", "invalid_request_error", "unsupported_value");
    if (typeof body.model !== "string" || body.model.length === 0) {
      return apiError(400, "model must be a non-empty string", "invalid_request_error", "invalid_value", "model");
    }

    let parts: PromptPart[];
    try {
      parts = endpoint === "chat" ? normalizeChatMessages(body.messages) : normalizeResponseInput(body.input);
    } catch (error) {
      return apiError(400, error instanceof Error ? error.message : String(error), "invalid_request_error", "invalid_value");
    }

    const rule = selectRule(config.rules, { model: body.model, headers: request.headers, parts });
    const plan = createPlan(config, rule, body.model, parts);
    await delay(plan.latencyMs, request.signal);
    const response = render(plan, body.model, endpoint);
    logRequest(request, endpoint, body.model, plan, performance.now() - started);
    return response;
  } catch (error) {
    if (error instanceof BodyError) return apiError(error.status, error.message, "invalid_request_error", error.code);
    if (request.signal.aborted) return new Response(null, { status: 499 });
    console.error(JSON.stringify({ event: "request.error", message: error instanceof Error ? error.message : String(error) }));
    return apiError(500, "internal server error", "api_error", "internal_error");
  }
}

function render(plan: ResponsePlan, model: string, endpoint: "chat" | "responses"): Response {
  const headers = new Headers(plan.headers);
  if (plan.ruleId !== undefined) headers.set("x-ani-rule-id", plan.ruleId);
  if (plan.status < 200 || plan.status >= 300) {
    const error = plan.error ?? {
      message: `mock HTTP ${plan.status}`,
      type: "api_error",
      param: null,
      code: null,
    };
    return json({ error }, { status: plan.status, headers });
  }

  const created = Math.floor(Date.now() / 1_000);
  if (endpoint === "chat") {
    return json(
      {
        id: `chatcmpl_${crypto.randomUUID().replaceAll("-", "")}`,
        object: "chat.completion",
        created,
        model,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: plan.text, refusal: null, annotations: [] },
            logprobs: null,
            finish_reason: "stop",
          },
        ],
        usage: {
          prompt_tokens: plan.inputTokens,
          completion_tokens: plan.outputTokens,
          total_tokens: plan.inputTokens + plan.outputTokens,
        },
      },
      { status: plan.status, headers },
    );
  }

  const responseId = `resp_${crypto.randomUUID().replaceAll("-", "")}`;
  return json(
    {
      id: responseId,
      object: "response",
      created_at: created,
      completed_at: created,
      status: "completed",
      error: null,
      incomplete_details: null,
      instructions: null,
      max_output_tokens: null,
      model,
      output: [
        {
          id: `msg_${crypto.randomUUID().replaceAll("-", "")}`,
          type: "message",
          status: "completed",
          role: "assistant",
          content: [{ type: "output_text", text: plan.text, annotations: [], logprobs: [] }],
        },
      ],
      output_text: plan.text,
      parallel_tool_calls: true,
      previous_response_id: null,
      reasoning: { effort: null, summary: null },
      store: false,
      temperature: 1,
      text: { format: { type: "text" } },
      tool_choice: "auto",
      tools: [],
      top_p: 1,
      truncation: "disabled",
      usage: {
        input_tokens: plan.inputTokens,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens: plan.outputTokens,
        output_tokens_details: { reasoning_tokens: 0 },
        total_tokens: plan.inputTokens + plan.outputTokens,
      },
      user: null,
      metadata: {},
    },
    { status: plan.status, headers },
  );
}

class BodyError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function readJson(request: Request, maxBytes: number): Promise<RequestBody> {
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new BodyError(413, "request_too_large", `request body exceeds ${maxBytes} bytes`);
  }
  const source = await request.text();
  if (new TextEncoder().encode(source).byteLength > maxBytes) {
    throw new BodyError(413, "request_too_large", `request body exceeds ${maxBytes} bytes`);
  }
  try {
    const value: unknown = JSON.parse(source);
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("body must be an object");
    return value as RequestBody;
  } catch (error) {
    throw new BodyError(400, "invalid_json", error instanceof Error ? error.message : "invalid JSON");
  }
}

function authenticate(request: Request, expected: string | undefined): Response | undefined {
  if (expected === undefined) return undefined;
  const actual = request.headers.get("authorization") ?? "";
  if (!safeEqual(actual, `Bearer ${expected}`)) {
    return apiError(401, "Incorrect API key provided", "invalid_request_error", "invalid_api_key");
  }
  return undefined;
}

function safeEqual(left: string, right: string): boolean {
  const length = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (milliseconds <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

function apiError(status: number, message: string, type: string, code: string | null, param: string | null = null): Response {
  return json({ error: { message, type, param, code } }, { status });
}

function json(body: unknown, init?: ResponseInit): Response {
  const headers = new Headers(init?.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(body), { ...init, headers });
}

function logRequest(
  request: Request,
  endpoint: string,
  model: string,
  plan: ResponsePlan,
  elapsedMs: number,
): void {
  console.info(
    JSON.stringify({
      event: "request.completed",
      request_id: request.headers.get("x-request-id"),
      endpoint,
      model,
      rule_id: plan.ruleId ?? null,
      status: plan.status,
      latency_ms: Math.round(elapsedMs),
      input_tokens: plan.inputTokens,
      output_tokens: plan.outputTokens,
    }),
  );
}
