import { createHash } from "node:crypto";
import type { SqliteDatabase } from "../storage-sqlite/database.js";
import type { TestRun, TestRunOrigin, TestRunResult } from "../domain/scenarios.js";
import { ApplicationError } from "./errors.js";
import { assertProjectAuthorization } from "./local-identity.js";
import { recordTestRun } from "./scenario-commands.js";

/** Largest report accepted in one call; JUnit reports from CI are far smaller. */
export const maxJunitReportBytes = 2_000_000;

export interface ImportJunitReportInput {
  readonly projectId: string;
  readonly principalId: string;
  readonly requestId: string;
  readonly buildId: string;
  readonly xml: string;
  readonly origin?: TestRunOrigin;
  readonly workItemIdOrKeys?: readonly string[];
}

export interface ImportedScenarioRun {
  readonly scenarioKey: string;
  readonly revisionNumber: number;
  readonly result: TestRunResult;
  readonly cases: number;
  readonly run: TestRun;
}

export interface JunitImportReport {
  readonly evidenceSha256: string;
  readonly testCases: number;
  readonly imported: readonly ImportedScenarioRun[];
  /** Test cases whose name, classname or `scenario` property names no known published scenario. */
  readonly unmatched: readonly string[];
}

interface ParsedCase {
  readonly label: string;
  readonly text: string;
  readonly result: "passed" | "failed" | "skipped";
}

/**
 * Maps a JUnit report to scenario runs by tag: a test case belongs to a scenario when the scenario key appears as a
 * whole token in its name, classname or `scenario` property. Cases of one scenario fold into one run (failed wins,
 * skipped only when every case was skipped). The report hash is kept as evidence. Idempotent per requestId+scenario.
 */
export function importJunitReport(database: SqliteDatabase, input: ImportJunitReportInput): JunitImportReport {
  assertProjectAuthorization(database, input.projectId, input.principalId);
  if (Buffer.byteLength(input.xml, "utf8") > maxJunitReportBytes) {
    throw new ApplicationError("VALIDATION_FAILED", `The JUnit report exceeds ${maxJunitReportBytes} bytes.`);
  }
  const cases = parseJunitCases(input.xml);
  if (cases.length === 0) {
    throw new ApplicationError("VALIDATION_FAILED", "The JUnit report contains no testcase elements.");
  }
  const evidenceSha256 = createHash("sha256").update(input.xml, "utf8").digest("hex");
  const scenarios = database.prepare(
    `SELECT s.scenario_key AS key,
            (SELECT MAX(r.revision_number) FROM scenario_revisions r
             WHERE r.project_id = s.project_id AND r.scenario_id = s.scenario_id AND r.status = 'published') AS revision
     FROM scenarios s WHERE s.project_id = ?`,
  ).all(input.projectId) as Array<{ key: string; revision: number | null }>;
  const published = scenarios.filter((scenario): scenario is { key: string; revision: number } => scenario.revision !== null);

  const grouped = new Map<string, ParsedCase[]>();
  const unmatched: string[] = [];
  for (const parsed of cases) {
    const keys = published.filter(({ key }) => containsToken(parsed.text, key)).map(({ key }) => key);
    if (keys.length === 0) unmatched.push(parsed.label);
    for (const key of keys) grouped.set(key, [...(grouped.get(key) ?? []), parsed]);
  }
  if (grouped.size === 0) {
    throw new ApplicationError("VALIDATION_FAILED", "No test case names a published scenario key; nothing to import.", {
      details: { testCases: cases.length, unmatched: unmatched.slice(0, 20) },
    });
  }

  const imported: ImportedScenarioRun[] = [];
  for (const [scenarioKey, scenarioCases] of grouped) {
    const revisionNumber = published.find(({ key }) => key === scenarioKey)!.revision;
    const result = foldResults(scenarioCases);
    const failedLabels = scenarioCases.filter((item) => item.result === "failed").map((item) => item.label);
    const notes = [
      `Importado de relatório JUnit (${scenarioCases.length} caso(s), sha256 ${evidenceSha256.slice(0, 12)}…).`,
      failedLabels.length > 0 ? `Falhas: ${failedLabels.slice(0, 5).join("; ")}` : "",
    ].filter(Boolean).join(" ").slice(0, 2_000);
    const receipt = recordTestRun(database, {
      projectId: input.projectId,
      principalId: input.principalId,
      requestId: `${input.requestId}:${scenarioKey}`.slice(0, 128),
      scenarioIdOrKey: scenarioKey,
      revisionNumber,
      buildId: input.buildId,
      result,
      notes,
      evidenceSha256,
      origin: input.origin ?? "agent",
      ...(input.workItemIdOrKeys === undefined ? {} : { workItemIdOrKeys: input.workItemIdOrKeys }),
    });
    imported.push({ scenarioKey, revisionNumber, result, cases: scenarioCases.length, run: receipt.value });
  }
  return { evidenceSha256, testCases: cases.length, imported, unmatched };
}

function foldResults(cases: readonly ParsedCase[]): TestRunResult {
  if (cases.some((item) => item.result === "failed")) return "failed";
  if (cases.every((item) => item.result === "skipped")) return "skipped";
  return "passed";
}

function containsToken(text: string, key: string): boolean {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`(^|[^A-Za-z0-9_-])${escaped}($|[^A-Za-z0-9_-])`, "u").test(text);
}

/** Minimal JUnit reader. Rejects DTDs and entity declarations, so nothing is ever expanded or fetched. */
export function parseJunitCases(xml: string): ParsedCase[] {
  if (/<!DOCTYPE|<!ENTITY/iu.test(xml)) {
    throw new ApplicationError("VALIDATION_FAILED", "The JUnit report must not declare a DOCTYPE or entities.");
  }
  const cleaned = xml.replace(/<!--[\s\S]*?-->/gu, "").replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gu, "$1");
  const cases: ParsedCase[] = [];
  const pattern = /<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/gu;
  for (const match of cleaned.matchAll(pattern)) {
    const attributes = readAttributes(match[1] ?? "");
    const body = match[2] ?? "";
    const properties = [...body.matchAll(/<property\b([^>]*?)\/?>/gu)]
      .map((property) => readAttributes(property[1] ?? ""))
      .filter((property) => property.name?.toLowerCase() === "scenario")
      .map((property) => property.value ?? "");
    const name = attributes.name ?? "";
    const classname = attributes.classname ?? "";
    const result: ParsedCase["result"] = /<(failure|error)\b/u.test(body)
      ? "failed"
      : /<skipped\b/u.test(body) ? "skipped" : "passed";
    cases.push({ label: [classname, name].filter(Boolean).join(" · ") || "(sem nome)", text: [name, classname, ...properties].join(" "), result });
  }
  return cases;
}

function readAttributes(source: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  for (const match of source.matchAll(/([A-Za-z_][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/gu)) {
    attributes[match[1]!] = decodeEntities(match[2] ?? match[3] ?? "");
  }
  return attributes;
}

function decodeEntities(value: string): string {
  return value.replace(/&(amp|lt|gt|quot|apos);/gu, (_, name: string) =>
    ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" })[name] ?? "");
}
