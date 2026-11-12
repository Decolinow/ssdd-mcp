import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

test("container runtime includes the MCP skill catalog required at startup", () => {
  const dockerfile = readFileSync(new URL("../../../Dockerfile", import.meta.url), "utf8");
  assert.match(dockerfile, /^COPY --chown=node:node skills \.\/skills$/mu);
});
