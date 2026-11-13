import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import { registeredToolNames } from "../mcp/registered-tools.js";
import { evaluateTranscript, type SkillRole, type TranscriptStep } from "../../src/evaluation/skill-eval.js";

const root = process.cwd();
const fixture = (name: string) => JSON.parse(readFileSync(join(root, "tests", "fixtures", "skill-evals", name), "utf8")) as TranscriptStep[];
const rules = (role: SkillRole, name: string) => evaluateTranscript(role, fixture(name)).map((violation) => violation.rule);

describe("deterministic skill evaluation (SSDD-952)", () => {
  it("accepts well-behaved transcripts", () => {
    assert.deepEqual(rules("developer", "developer-good.json"), []);
    assert.deepEqual(rules("developer", "developer-handled-error.json"), []);
    assert.deepEqual(rules("quality-assurance", "qa-good.json"), []);
  });

  it("flags fabricated evidence, forbidden tools and call-order violations", () => {
    const fabricated = rules("developer", "developer-fabricated.json");
    assert.ok(fabricated.includes("fabricated-evidence"));
    assert.ok(fabricated.includes("forbidden-tool"));
    assert.deepEqual(rules("quality-assurance", "qa-transition.json"), ["forbidden-tool"]);
    assert.ok(evaluateTranscript("developer", [{ tool: "task_context_get" }]).some((violation) => violation.rule === "call-order"));
    assert.ok(evaluateTranscript("developer", [{ tool: "task_start" }]).some((violation) => violation.rule === "call-order"));
    assert.ok(evaluateTranscript("security-reviewer", [{ tool: "comment_add" }]).some((violation) => violation.rule === "forbidden-tool"));
  });

  it("requires isError to be reported instead of retried unchanged or followed by a write", () => {
    assert.deepEqual(rules("developer", "developer-iserror.json"), ["iserror-handling", "iserror-handling"]);
    assert.ok(evaluateTranscript("developer", [{ tool: "task_briefing_get", isError: true }]).some((violation) => violation.rule === "iserror-handling"));
    assert.ok(evaluateTranscript("developer", [{ tool: "task_start_check", isError: true }, { tool: "task_start" }]).some((violation) => violation.message.includes("write")));
  });

  it("keeps every tool named in a skill real and each skill explicit about errors and fabricated evidence", () => {
    const registered = new Set(registeredToolNames(root));
    const toolLike = /^[a-z]+(?:_[a-z]+)*_(?:get|set|list|create|propose|publish|record|add|check|start|accept|transition|query|apply|submit|open|answer|certify|withdraw|assign|estimate|rank|search|index|remove|revoke|rotate|review|issue)$/u;
    const skillsRoot = resolve(root, "skills");
    for (const id of readdirSync(skillsRoot).filter((name) => name.startsWith("ssdd-"))) {
      const text = readFileSync(join(skillsRoot, id, "SKILL.md"), "utf8");
      for (const match of text.matchAll(/`([^`\s]+)`/gu)) {
        const token = match[1]!;
        if (token !== "security_review" && !token.startsWith("ssdd_") && toolLike.test(token)) assert.ok(registered.has(token), `${id} mentions unknown tool ${token}`);
      }
      assert.match(text, /\bnever\b[^\n]*(invent|fabricat|publish|alter|certif|record|assum|treat|use|call|place|try|share|perform|allocate|add|infer|replace|let|create|claim)/iu, `${id} lacks a Never rule`);
      assert.match(text, /## When blocked\n\n- /u, `${id} lacks a When blocked rule`);
    }
    for (const id of ["ssdd-developer", "ssdd-quality-assurance", "ssdd-test-designer"]) {
      const text = readFileSync(join(skillsRoot, id, "SKILL.md"), "utf8");
      assert.match(text, /Never[^\n]*(invent|create evidence|fabricat)/iu, `${id} must forbid fabricating evidence`);
    }
    assert.match(readFileSync(join(skillsRoot, "ssdd-developer", "SKILL.md"), "utf8"), /isError/u);
  });
});
