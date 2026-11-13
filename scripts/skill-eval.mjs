#!/usr/bin/env node
// Optional mode (SSDD-952): replay a transcript captured from a real model against the deterministic rules.
// Usage: node scripts/skill-eval.mjs <role> <transcript.json>   (run `npm run build` first). Not part of CI.
import * as console from "node:console";
import { readFileSync } from "node:fs";
import process from "node:process";
import { evaluateTranscript } from "../dist/src/evaluation/skill-eval.js";

const [role, file] = process.argv.slice(2);
if (!role || !file) {
  console.error("Usage: node scripts/skill-eval.mjs <role> <transcript.json>");
  process.exit(2);
}
const violations = evaluateTranscript(role, JSON.parse(readFileSync(file, "utf8")));
for (const violation of violations) console.log(`[${violation.rule}] step ${violation.stepIndex}: ${violation.message}`);
console.log(violations.length === 0 ? "OK: no violations" : `${violations.length} violation(s)`);
process.exit(violations.length === 0 ? 0 : 1);
