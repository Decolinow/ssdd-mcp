import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { test } from "node:test";

// Ratchet on the serialized tools/list size per profile (the real context cost of connecting an agent).
// Raise a limit only with a reason; prefer shrinking schemas (shared `.meta({ id })` refs, looser snapshot types).
test("MCP profiles stay within their reviewed context byte budgets", () => {
  const output = execFileSync(process.execPath, [resolve(process.cwd(), "scripts/mcp-context-cost.mjs"), "--json"], { encoding: "utf8", timeout: 120_000 });
  const report = JSON.parse(output) as { tools: number; profiles: Record<string, { bytes: number }> };
  const limits: Record<string, number> = {
    full: 520_000, dev: 235_000, tech_lead: 345_000, po: 290_000, facilitator: 150_000, qa: 140_000,
    refinement: 135_000, specification: 155_000, test_design: 135_000, security_review: 130_000, release: 120_000, devops: 115_000, admin: 85_000,
  };
  for (const [profile, limit] of Object.entries(limits)) {
    const bytes = report.profiles[profile]?.bytes ?? Number.POSITIVE_INFINITY;
    assert.ok(bytes <= limit, `${profile} costs ${bytes} B of tool definitions (limit ${limit}); shrink schemas or review the budget`);
  }
});
