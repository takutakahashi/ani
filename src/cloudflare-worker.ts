import { loadConfigFromUrl } from "@/src/config/remote";
import { loadConfigFromR2, type ConfigR2Bucket } from "@/src/config/r2";
import { getConfig, installConfig } from "@/src/config/runtime";
import { handleChatCompletions, handleModels, handleResponses } from "@/src/server/handlers";

interface Env {
  CONFIG_BUCKET?: ConfigR2Bucket;
  ANI_CONFIG_KEY?: string;
  ANI_CONFIG_URL?: string;
}

let configPromise: Promise<void> | undefined;

function ensureConfig(env: Env): Promise<void> {
  configPromise ??= (async () => {
    const config = env.CONFIG_BUCKET !== undefined
      ? await loadConfigFromR2(env.CONFIG_BUCKET, env.ANI_CONFIG_KEY ?? "active.yaml")
      : env.ANI_CONFIG_URL !== undefined
        ? await loadConfigFromUrl(env.ANI_CONFIG_URL)
        : undefined;
    if (config === undefined) throw new Error("CONFIG_BUCKET or ANI_CONFIG_URL is required on Cloudflare Workers");
    installConfig(config);
  })();
  return configPromise;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      await ensureConfig(env);
      getConfig();
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "config.load_failed",
          message: error instanceof Error ? error.message : String(error),
        }),
      );
      return Response.json(
        {
          error: {
            message: "configuration is unavailable",
            type: "api_error",
            param: null,
            code: "config_unavailable",
          },
        },
        { status: 503 },
      );
    }

    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/healthz") {
      return Response.json({ status: "ok" });
    }
    if (request.method === "GET" && url.pathname === "/v1/models") return handleModels(request);
    if (request.method === "POST" && url.pathname === "/v1/chat/completions") return handleChatCompletions(request);
    if (request.method === "POST" && url.pathname === "/v1/responses") return handleResponses(request);
    return Response.json(
      { error: { message: "Not found", type: "invalid_request_error", param: null, code: "not_found" } },
      { status: 404 },
    );
  },
};
