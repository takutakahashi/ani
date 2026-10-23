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

function request(path: string, body?: unknown, apiKey = "secret", headers?: Record<string, string>): Request {
  return new Request(`http://localhost${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json", ...headers },
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

  it("validates authentication", () => {
    expect(handleModels(request("/v1/models", undefined, "wrong")).status).toBe(401);
  });

  it("streams the complete Responses API event sequence", async () => {
    const response = await handleResponses(
      request("/v1/responses", { model: "ani-test", input: "hello", stream: true }),
    );
    const body = await response.text();
    const events = body
      .trim()
      .split("\n\n")
      .map((block) => {
        const lines = block.split("\n");
        return { event: lines[0].slice("event: ".length), data: JSON.parse(lines[1].slice("data: ".length)) };
      });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(events.map(({ event }) => event)).toEqual([
      "response.created",
      "response.output_item.added",
      "response.content_part.added",
      "response.output_text.delta",
      "response.output_text.done",
      "response.content_part.done",
      "response.output_item.done",
      "response.completed",
    ]);
    expect(events.map(({ data }) => data.sequence_number)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(events[3].data.delta).toBe("default");
    expect(events[7].data.response.status).toBe("completed");
    expect(events[7].data.response.output_text).toBe("default");
    expect(events[7].data.response.usage.output_tokens).toBe(3);
  });

  it("streams Chat Completions chunks followed by DONE", async () => {
    const response = await handleChatCompletions(
      request("/v1/chat/completions", {
        model: "ani-test",
        messages: [{ role: "user", content: "hello" }],
        stream: true,
      }),
    );
    const body = await response.text();
    const frames = body.trim().split("\n\n");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(frames).toHaveLength(4);
    expect(JSON.parse(frames[0].slice("data: ".length)).choices[0].delta.role).toBe("assistant");
    expect(JSON.parse(frames[1].slice("data: ".length)).choices[0].delta.content).toBe("default");
    expect(JSON.parse(frames[2].slice("data: ".length)).choices[0].finish_reason).toBe("stop");
    expect(frames[3]).toBe("data: [DONE]");
  });

  it("returns configured HTTP errors without starting a stream", async () => {
    const response = await handleResponses(
      request("/v1/responses", { model: "ani-test", input: "limit", stream: true }),
    );

    expect(response.status).toBe(429);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect((await response.json()).error.code).toBe("rate_limit_exceeded");
  });

  it("overrides status, latency, retry-after, and response text from a return directive", async () => {
    const started = performance.now();
    const response = await handleChatCompletions(
      request("/v1/chat/completions", {
        model: "ani-test",
        messages: [{ role: "user", content: 'return(response_text="OK", retry=3, code=429, latency=20m)' }],
      }),
    );

    expect(performance.now() - started).toBeGreaterThanOrEqual(15);
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("3");
    expect((await response.json()).error.message).toBe("OK");
  });

  it("returns an echo-style debug response without sensitive headers", async () => {
    const requestBody = {
      model: "ani-test",
      input: 'return(response_text="ignored", return_debug_responce=true)',
    };
    const response = await handleResponses(
      request("/v1/responses", requestBody, "secret", {
        "x-visible": "shown",
        "x-api-key": "hidden",
        cookie: "session=hidden",
      }),
    );
    const responseBody = await response.json();
    const debug = JSON.parse(responseBody.output_text);

    expect(response.status).toBe(200);
    expect(debug.method).toBe("POST");
    expect(debug.url).toBe("http://localhost/v1/responses");
    expect(debug.headers["x-visible"]).toBe("shown");
    expect(debug.headers.authorization).toBeUndefined();
    expect(debug.headers["x-api-key"]).toBeUndefined();
    expect(debug.headers.cookie).toBeUndefined();
    expect(debug.body).toEqual(requestBody);
  });

  it("supports status codes that prohibit response bodies", async () => {
    const response = await handleResponses(
      request("/v1/responses", { model: "ani-test", input: "return(code=204)" }),
    );

    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
  });

  it("uses configured defaults for omitted return directive values", async () => {
    const response = await handleChatCompletions(
      request("/v1/chat/completions", {
        model: "ani-test",
        messages: [{ role: "user", content: "return(retry=7)" }],
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("retry-after")).toBe("7");
    expect(body.choices[0].message.content).toBe("default");
  });
});
