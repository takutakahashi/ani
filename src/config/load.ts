import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import type { AniConfig } from "./schema";
import { parseConfig } from "./parse";

export { parseConfig } from "./parse";

export async function loadConfig(path: string): Promise<AniConfig> {
  const absolutePath = resolve(path);
  const source = await readFile(absolutePath, "utf8");
  return parseConfig(source, extname(absolutePath).toLowerCase());
}
