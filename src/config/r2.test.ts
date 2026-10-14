import { describe, expect, it, vi } from "vitest";
import { loadConfigFromR2, type ConfigR2Bucket } from "./r2";

describe("loadConfigFromR2", () => {
  it("loads and validates a YAML object", async () => {
    const bucket: ConfigR2Bucket = {
      get: vi.fn().mockResolvedValue({
        size: 43,
        text: vi.fn().mockResolvedValue("version: 1\ndefaults:\n  model: r2-model\n"),
      }),
    };
    expect((await loadConfigFromR2(bucket, "active.yaml")).defaults.model).toBe("r2-model");
  });

  it("rejects missing, oversized, and unsupported objects", async () => {
    await expect(loadConfigFromR2({ get: vi.fn().mockResolvedValue(null) }, "active.yaml")).rejects.toThrow(
      "not found",
    );
    await expect(
      loadConfigFromR2(
        { get: vi.fn().mockResolvedValue({ size: 1_048_577, text: vi.fn() }) },
        "active.yaml",
      ),
    ).rejects.toThrow("exceeds");
    await expect(
      loadConfigFromR2(
        { get: vi.fn().mockResolvedValue({ size: 10, text: vi.fn().mockResolvedValue("version: 1") }) },
        "active.txt",
      ),
    ).rejects.toThrow("must end");
  });
});
