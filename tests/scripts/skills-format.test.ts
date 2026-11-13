import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";

const skillsRoot = resolve(process.cwd(), "skills");

/** SSDD-950: every skill is a checklist of one-line instructions under Always / Never / When blocked. */
test("every skill uses the Always, Never and When blocked checklist format", () => {
  const ids = readdirSync(skillsRoot).filter((name) => name.startsWith("ssdd-"));
  assert.ok(ids.length >= 10);
  for (const id of ids) {
    const lines = readFileSync(join(skillsRoot, id, "SKILL.md"), "utf8").split(/\r?\n/u);
    const headings = lines.filter((line) => line.startsWith("## "));
    for (const section of ["## Always", "## Never", "## When blocked"]) {
      assert.ok(headings.includes(section), `${id} is missing ${section}`);
    }
    const sectionStart = lines.indexOf("## Always");
    let current = "";
    for (const line of lines.slice(sectionStart)) {
      if (line.startsWith("## ")) { current = line; continue; }
      if (line.trim() === "" || line.startsWith("Useful MCP prompt")) continue;
      assert.match(line, /^- \S/u, `${id} ${current}: each instruction must be a single "- " line, got: ${line.slice(0, 60)}`);
    }
  }
});
