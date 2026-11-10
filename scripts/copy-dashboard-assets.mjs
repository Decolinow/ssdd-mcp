import { cp, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const workspaceDirectory = resolve(scriptDirectory, "..");
const sourceDirectory = join(workspaceDirectory, "src", "dashboard", "public");
const destinationDirectory = join(workspaceDirectory, "dist", "src", "dashboard", "public");

await mkdir(destinationDirectory, { recursive: true });
await cp(sourceDirectory, destinationDirectory, { recursive: true, force: true });
