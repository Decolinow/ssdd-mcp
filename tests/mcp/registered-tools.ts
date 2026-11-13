import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

/** Names passed to `server.registerTool` across the tool-registration modules (SSDD-953). */
export function registeredToolNames(root = process.cwd()): string[] {
  const directory = resolve(root, "src/mcp/tools");
  const sources = readdirSync(directory).filter((name) => name.endsWith(".ts")).sort().map((name) => readFileSync(join(directory, name), "utf8"));
  return sources.flatMap((source) => [...source.matchAll(/server\.registerTool\(\s*["']([^"']+)["']/gu)].map((match) => match[1]!));
}
