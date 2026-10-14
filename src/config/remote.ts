import type { AniConfig } from "./schema";
import { parseConfig } from "./parse";

const MAX_CONFIG_BYTES = 1_048_576;
const CONFIG_TIMEOUT_MS = 2_000;

export async function loadConfigFromUrl(url: string): Promise<AniConfig> {
  const parsedUrl = new URL(url);
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    throw new Error("ANI_CONFIG_URL must use http or https");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("config request timed out")), CONFIG_TIMEOUT_MS);
  try {
    const response = await fetch(parsedUrl, {
      headers: { accept: "application/yaml, application/toml, text/yaml, text/plain" },
      redirect: "follow",
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`config request failed with HTTP ${response.status}`);

    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_CONFIG_BYTES) {
      throw new Error(`remote config exceeds ${MAX_CONFIG_BYTES} bytes`);
    }
    const source = await response.text();
    if (new TextEncoder().encode(source).byteLength > MAX_CONFIG_BYTES) {
      throw new Error(`remote config exceeds ${MAX_CONFIG_BYTES} bytes`);
    }
    return parseConfig(source, detectExtension(parsedUrl, response.headers.get("content-type")));
  } finally {
    clearTimeout(timer);
  }
}

function detectExtension(url: URL, contentType: string | null): ".yaml" | ".toml" {
  const pathname = url.pathname.toLowerCase();
  if (pathname.endsWith(".toml")) return ".toml";
  if (pathname.endsWith(".yaml") || pathname.endsWith(".yml")) return ".yaml";

  const mediaType = contentType?.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType?.includes("toml")) return ".toml";
  if (mediaType?.includes("yaml") || mediaType === "text/plain") return ".yaml";
  throw new Error("cannot determine remote config format from URL or Content-Type");
}
