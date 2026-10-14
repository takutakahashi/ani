import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfigFromUrl } from "./remote";

describe("loadConfigFromUrl", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("loads and validates YAML from a public URL", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response("version: 1\ndefaults:\n  model: remote-model\n", {
        headers: { "content-type": "application/yaml" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const config = await loadConfigFromUrl("https://config.example.com/ani.yaml");
    expect(config.defaults.model).toBe("remote-model");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("detects TOML using Content-Type when the URL has no extension", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response('version = 1\n[defaults]\nmodel = "toml-model"\n', {
          headers: { "content-type": "application/toml; charset=utf-8" },
        }),
      ),
    );
    expect((await loadConfigFromUrl("https://config.example.com/current")).defaults.model).toBe("toml-model");
  });

  it("rejects HTTP errors, unsupported protocols, and oversized configs", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("missing", { status: 404 })));
    await expect(loadConfigFromUrl("https://config.example.com/ani.yaml")).rejects.toThrow("HTTP 404");
    await expect(loadConfigFromUrl("file:///tmp/ani.yaml")).rejects.toThrow("http or https");

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("version: 1", { headers: { "content-length": "1048577", "content-type": "text/yaml" } }),
      ),
    );
    await expect(loadConfigFromUrl("https://config.example.com/ani.yaml")).rejects.toThrow("exceeds");
  });
});
