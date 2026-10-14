import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseConfig } from "@/src/config/load";
import { setConfigForTest } from "@/src/config/runtime";
import { handleChatCompletions, handleModels, handleResponses } from "./handlers";

const config = parseConfig(
  `version: 1
server:
  api_key: secret
  seed: 42
defaults:
  model: ani-test
  response: { text: default, output_tokens: 3 }
rules:
  - id: limited
    priority: 10
    match:
      text: { contains: [limit] }
    response:
      status: 429
      headers: { retry-after: "2" }
      error: { message: retry, type: rate_limit_error, code: rate_limit_exceeded }
  - id: random
    match:
      text: { contains: [random] }
    response:
      random:
        - { text: alpha, weight: 1 }
        - { text: beta, weight: 1 }
`,
  ".yaml",
);

function request(path: string, body?: unknown, apiKey = "secret"): Request {
  return new Request(`http://localhost${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe("OpenAI-compatible handlers", () => {
  beforeEach(() => setConfigForTest(config));
  afterEach(() => setConfigForTest(undefined));

  it("renders a Chat Completions response", async () => {
    const response = await handleChatCompletions(
      request("/v1/chat/completions", { model: "ani-test", messages: [{ role: "user", content: "hello" }] }),
    );
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.object).toBe("chat.completion");
    expect(body.choices[0].message.content).toBe("default");
    expect(body.usage.completion_tokens).toBe(3);
  });

  it("renders a Responses API response", async () => {
    const response = await handleResponses(request("/v1/responses", { model: "ani-test", input: "hello" }));
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.object).toBe("response");
    expect(body.output[0].content[0].text).toBe("default");
    expect(body.usage.output_tokens).toBe(3);
  });

  it("returns configured errors and headers", async () => {
    const response = await handleChatCompletions(
      request("/v1/chat/completions", { model: "ani-test", messages: [{ role: "user", content: "limit" }] }),
    );
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("2");
    expect(response.headers.get("x-ani-rule-id")).toBe("limited");
    expect((await response.json()).error.code).toBe("rate_limit_exceeded");
  });

  it("makes seeded random responses deterministic", async () => {
    const makeRequest = () => request("/v1/responses", { model: "ani-test", input: "random" });
    const first = await (await handleResponses(makeRequest())).json();
    const second = await (await handleResponses(makeRequest())).json();
    expect(first.output_text).toBe(second.output_text);
  });

  it("validates authentication and streaming", async () => {
    expect(handleModels(request("/v1/models", undefined, "wrong")).status).toBe(401);
    const response = await handleResponses(request("/v1/responses", { model: "ani-test", input: "x", stream: true }));
    expect(response.status).toBe(400);
  });
});
