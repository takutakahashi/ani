import { getConfig } from "@/src/config/runtime";
import { selectRule } from "@/src/matcher/match";
import { normalizeChatMessages, normalizeResponseInput, type PromptPart } from "@/src/prompt/normalize";
import { findReturnDirective, type ReturnDirective } from "@/src/prompt/return-directive";
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
    const directive = findReturnDirective(parts);
    if (directive !== undefined) applyReturnDirective(plan, directive, request, body);
    await delay(plan.latencyMs, request.signal);
    const response = render(plan, body.model, endpoint, body.stream === true);
    logRequest(request, endpoint, body.model, plan, performance.now() - started);
    return response;
  } catch (error) {
    if (error instanceof BodyError) return apiError(error.status, error.message, "invalid_request_error", error.code);
    if (request.signal.aborted) return new Response(null, { status: 499 });
    console.error(JSON.stringify({ event: "request.error", message: error instanceof Error ? error.message : String(error) }));
    return apiError(500, "internal server error", "api_error", "internal_error");
  }
}

function applyReturnDirective(
  plan: ResponsePlan,
  directive: ReturnDirective,
  request: Request,
  body: RequestBody,
): void {
  if (directive.status !== undefined) plan.status = directive.status;
  if (directive.latencyMs !== undefined) plan.latencyMs = directive.latencyMs;
  if (directive.retryAfter !== undefined) plan.headers["retry-after"] = directive.retryAfter;
  if (directive.responseText !== undefined) plan.text = directive.responseText;
  if (directive.debugResponse === true) plan.text = createDebugResponse(request, body);
  plan.outputTokens = Math.ceil([...plan.text].length / 4);
  if (plan.error !== undefined) plan.error = { ...plan.error, message: plan.text };
}

function createDebugResponse(request: Request, body: RequestBody): string {
  const headers = Object.fromEntries(
    [...request.headers].filter(([name]) => !isSensitiveHeader(name)),
  );
  return JSON.stringify({ method: request.method, url: request.url, headers, body });
}

function isSensitiveHeader(name: string): boolean {
  return /(?:authorization|cookie|credential|secret|token|api[-_]?key)/i.test(name);
}

function render(plan: ResponsePlan, model: string, endpoint: "chat" | "responses", stream: boolean): Response {
  const headers = new Headers(plan.headers);
  if (plan.ruleId !== undefined) headers.set("x-ani-rule-id", plan.ruleId);
  if (plan.status === 204 || plan.status === 205 || plan.status === 304) {
    return new Response(null, { status: plan.status, headers });
  }
  if (plan.status < 200 || plan.status >= 300) {
    const error = plan.error ?? {
      message: plan.text || `mock HTTP ${plan.status}`,
      type: "api_error",
      param: null,
      code: null,
    };
    return json({ error }, { status: plan.status, headers });
  }

  const created = Math.floor(Date.now() / 1_000);
  if (endpoint === "chat") {
    const id = `chatcmpl_${randomId()}`;
    if (stream) return renderChatStream(plan, model, id, created, headers);
    return json(createChatResponse(plan, model, id, created), { status: plan.status, headers });
  }

  const responseId = `resp_${randomId()}`;
  const messageId = `msg_${randomId()}`;
  const response = createResponsesResponse(plan, model, responseId, messageId, created);
  if (stream) return renderResponsesStream(response, plan.text, messageId, headers);
  return json(response, { status: plan.status, headers });
}

function randomId(): string {
  return crypto.randomUUID().replaceAll("-", "");
}

function createChatResponse(plan: ResponsePlan, model: string, id: string, created: number): Record<string, unknown> {
  return {
    id,
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
  };
}

function createResponsesResponse(
  plan: ResponsePlan,
  model: string,
  responseId: string,
  messageId: string,
  created: number,
): Record<string, unknown> {
  return {
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
    output: [createOutputMessage(messageId, plan.text, "completed")],
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
  };
}

function createOutputMessage(id: string, text: string, status: "in_progress" | "completed"): Record<string, unknown> {
  return {
    id,
    type: "message",
    status,
    role: "assistant",
    content: status === "completed" ? [{ type: "output_text", text, annotations: [], logprobs: [] }] : [],
  };
}

function renderChatStream(plan: ResponsePlan, model: string, id: string, created: number, headers: Headers): Response {
  const base = { id, object: "chat.completion.chunk", created, model };
  const chunks = [
    { ...base, choices: [{ index: 0, delta: { role: "assistant", content: "" }, logprobs: null, finish_reason: null }] },
    { ...base, choices: [{ index: 0, delta: { content: plan.text }, logprobs: null, finish_reason: null }] },
    { ...base, choices: [{ index: 0, delta: {}, logprobs: null, finish_reason: "stop" }] },
  ];
  return sse([...chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`), "data: [DONE]\n\n"], headers);
}

function renderResponsesStream(
  response: Record<string, unknown>,
  text: string,
  messageId: string,
  headers: Headers,
): Response {
  const initialResponse = { ...response, completed_at: null, status: "in_progress", output: [], output_text: "", usage: null };
  const pendingMessage = createOutputMessage(messageId, "", "in_progress");
  const completedMessage = createOutputMessage(messageId, text, "completed");
  const emptyPart = { type: "output_text", text: "", annotations: [], logprobs: [] };
  const completedPart = { ...emptyPart, text };
  const events = [
    { type: "response.created", response: initialResponse },
    { type: "response.output_item.added", output_index: 0, item: pendingMessage },
    { type: "response.content_part.added", item_id: messageId, output_index: 0, content_index: 0, part: emptyPart },
    { type: "response.output_text.delta", item_id: messageId, output_index: 0, content_index: 0, delta: text, logprobs: [] },
    { type: "response.output_text.done", item_id: messageId, output_index: 0, content_index: 0, text, logprobs: [] },
    { type: "response.content_part.done", item_id: messageId, output_index: 0, content_index: 0, part: completedPart },
    { type: "response.output_item.done", output_index: 0, item: completedMessage },
    { type: "response.completed", response },
  ];
  return sse(
    events.map((event, sequenceNumber) => {
      const data = { ...event, sequence_number: sequenceNumber };
      return `event: ${event.type}\ndata: ${JSON.stringify(data)}\n\n`;
    }),
    headers,
  );
}

function sse(events: string[], headers: Headers): Response {
  headers.set("content-type", "text/event-stream; charset=utf-8");
  headers.set("cache-control", "no-cache");
  return new Response(events.join(""), { status: 200, headers });
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
