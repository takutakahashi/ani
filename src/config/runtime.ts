import type { AniConfig } from "./schema";
import { loadConfig } from "./load";
import { loadConfigFromUrl } from "./remote";

const CONFIG_SYMBOL = Symbol.for("ani.config");
type GlobalWithConfig = typeof globalThis & { [CONFIG_SYMBOL]?: AniConfig };

export async function initializeConfig(): Promise<AniConfig> {
  const globalStore = globalThis as GlobalWithConfig;
  if (globalStore[CONFIG_SYMBOL] !== undefined) return globalStore[CONFIG_SYMBOL];

  const url = process.env.ANI_CONFIG_URL;
  const path = process.env.ANI_CONFIG_PATH ?? "config/ani.yaml";
  const config = url === undefined ? await loadConfig(path) : await loadConfigFromUrl(url);
  globalStore[CONFIG_SYMBOL] = config;
  console.info(
    JSON.stringify({
      event: "config.loaded",
      source: url === undefined ? path : url,
      rules: config.rules.length,
    }),
  );
  return config;
}

export function getConfig(): AniConfig {
  const config = (globalThis as GlobalWithConfig)[CONFIG_SYMBOL];
  if (config === undefined) {
    throw new Error("ani config is not initialized");
  }
  return config;
}

export function installConfig(config: AniConfig): void {
  const globalStore = globalThis as GlobalWithConfig;
  if (globalStore[CONFIG_SYMBOL] !== undefined) throw new Error("ani config is already initialized");
  globalStore[CONFIG_SYMBOL] = config;
}

export function setConfigForTest(config: AniConfig | undefined): void {
  const globalStore = globalThis as GlobalWithConfig;
  if (config === undefined) delete globalStore[CONFIG_SYMBOL];
  else globalStore[CONFIG_SYMBOL] = config;
}
