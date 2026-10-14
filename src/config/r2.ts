import type { AniConfig } from "./schema";
import { parseConfig } from "./parse";

const MAX_CONFIG_BYTES = 1_048_576;

export interface ConfigR2Bucket {
  get(key: string): Promise<ConfigR2Object | null>;
}

interface ConfigR2Object {
  size?: number;
  text(): Promise<string>;
}

export async function loadConfigFromR2(bucket: ConfigR2Bucket, key: string): Promise<AniConfig> {
  const object = await bucket.get(key);
  if (object === null) throw new Error(`R2 config object not found: ${key}`);
  if (object.size !== undefined && object.size > MAX_CONFIG_BYTES) {
    throw new Error(`R2 config exceeds ${MAX_CONFIG_BYTES} bytes`);
  }

  const source = await object.text();
  if (new TextEncoder().encode(source).byteLength > MAX_CONFIG_BYTES) {
    throw new Error(`R2 config exceeds ${MAX_CONFIG_BYTES} bytes`);
  }

  const lowerKey = key.toLowerCase();
  if (lowerKey.endsWith(".toml")) return parseConfig(source, ".toml");
  if (lowerKey.endsWith(".yaml") || lowerKey.endsWith(".yml")) return parseConfig(source, ".yaml");
  throw new Error("R2 config key must end with .yaml, .yml, or .toml");
}
