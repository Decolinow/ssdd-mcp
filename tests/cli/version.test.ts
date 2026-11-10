import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("reports the version from the installed package manifest", () => {
  const manifest = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")) as { version: string };
  const cli = fileURLToPath(new URL("../../src/cli.js", import.meta.url));
  const result = spawnSync(process.execPath, [cli, "--version"], { encoding: "utf8" });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `${manifest.version}\n`);
});
