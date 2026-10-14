import { parse as parseToml } from "smol-toml";
import { parse as parseYaml } from "yaml";
import { configSchema, type AniConfig } from "./schema";

export function parseConfig(source: string, extension: string): AniConfig {
  let raw: unknown;
  if (extension === ".yaml" || extension === ".yml") {
    raw = parseYaml(source, { uniqueKeys: true });
  } else if (extension === ".toml") {
    raw = parseToml(source);
  } else {
    throw new Error(`unsupported config extension: ${extension || "(none)"}`);
  }
  return configSchema.parse(raw);
}
