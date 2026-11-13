import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { renderToolUiMatrix, toolUiMatrix } from "../../src/dashboard/tool-ui-matrix.js";

// SSDD-97 AC-4: every MCP tool maps to a dashboard operation or an explicit future gap.
test("tool to UI matrix covers exactly the MCP catalog and the document is current", () => {
  const parity = readFileSync(resolve(process.cwd(), "docs/mcp-parity-matrix.md"), "utf8");
  const catalog = [...parity.matchAll(/^\| `([a-z_]+)` \|/gmu)].map((match) => match[1] as string).sort();
  assert.ok(catalog.length > 50, "the parity matrix lists the catalog");
  assert.deepEqual(Object.keys(toolUiMatrix).sort(), catalog, "classify every new tool in src/dashboard/tool-ui-matrix.ts and remove retired ones");
  const path = resolve(process.cwd(), "docs/dashboard-parity-matrix.md");
  const expected = renderToolUiMatrix();
  if (process.env.UPDATE_UI_MATRIX === "1") writeFileSync(path, expected);
  assert.equal(readFileSync(path, "utf8").replace(/\r\n/gu, "\n"), expected, "run UPDATE_UI_MATRIX=1 npm test to regenerate docs/dashboard-parity-matrix.md");
});
