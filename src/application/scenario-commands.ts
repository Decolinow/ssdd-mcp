import { randomUUID } from "node:crypto";
import type {
  ScenarioCoverageTarget,
  ScenarioKind,
  ScenarioRevision,
  ScenarioSnapshot,
  ScenarioStep,
  TestRun,
  TestRunOrigin,
  TestRunResult,
} from "../domain/scenarios.js";
import type { SqliteDatabase } from "../storage-sqlite/database.js";
import { ApplicationError } from "./errors.js";
import { executeIdempotentCommand, type CommandReceipt } from "./idempotent-command.js";
import { assertProjectAuthorization } from "./local-identity.js";
import { findScenario, resolveCriterion, toRevision } from "./scenario-queries.js";
import { getWorkItem } from "./work-item-queries.js";

export interface ScenarioContentInput {
  readonly title: string;
  readonly preconditions?: readonly string[];
  readonly steps: readonly ScenarioStep[];
  readonly coverage?: readonly { readonly targetType: "criterion" | "specification"; readonly reference: string }[];
  readonly workItemIdOrKeys?: readonly string[];
}

export interface CreateScenarioInput extends ScenarioContentInput {
  readonly projectId: string;
  readonly principalId: string;
  readonly requestId: string;
  readonly key: string;
  readonly kind: ScenarioKind;
}

export interface ReviseScenarioInput extends ScenarioContentInput {
  readonly projectId: string;
  readonly principalId: string;
  readonly requestId: string;
  readonly scenarioIdOrKey: string;
  readonly expectedVersion: number;
}

export interface PublishScenarioRevisionInput {
  readonly projectId: string;
  readonly principalId: string;
  readonly requestId: string;
  readonly scenarioIdOrKey: string;
  readonly revisionNumber: number;
  readonly expectedVersion: number;
}

export interface RecordTestRunInput {
  readonly projectId: string;
  readonly principalId: string;
  readonly requestId: string;
  readonly scenarioIdOrKey: string;
  readonly revisionNumber: number;
  readonly buildId: string;
  readonly result: TestRunResult;
  readonly notes?: string;
  readonly evidenceUri?: string;
  readonly origin?: TestRunOrigin;
  readonly evidenceSha256?: string;
  readonly workItemIdOrKeys?: readonly string[];
}

interface ScenarioRevisionRow {
  readonly revision_id: string;
  readonly project_id: string;
  readonly scenario_id: string;
  readonly scenario_key: string;
  readonly kind: ScenarioKind;
  readonly revision_number: number;
  readonly status: "draft" | "published" | "superseded";
  readonly snapshot_json: string;
  readonly created_by_principal_id: string;
  readonly created_at: string;
  readonly published_by_principal_id: string | null;
  readonly published_at: string | null;
}

export function createScenario(
  database: SqliteDatabase,
  input: CreateScenarioInput,
): CommandReceipt<ScenarioRevision> {
  const key = input.key.trim().toUpperCase();
  const kind = input.kind;
  const content = normalizeContent(input);
  const payloadContent = toJsonContent(content);
  if (!/^[A-Z][A-Z0-9._-]{0,31}$/.test(key)) {
    throw new ApplicationError("VALIDATION_FAILED", "Scenario keys must use 1-32 letters, digits, dots, underscores or dashes.");
  }
  const coverageReferences = normalizeCoverageReferences(input.coverage ?? []);
  const workItemReferences = normalizeWorkItemReferences(input.workItemIdOrKeys ?? []);

  return executeIdempotentCommand(database, {
    projectId: input.projectId,
    principalId: input.principalId,
    action: "scenario.create",
    requestId: input.requestId,
    payload: {
      projectId: input.projectId,
      key,
      kind,
      content: payloadContent,
      coverage: coverageReferences.map((entry) => ({ ...entry })),
      workItemIdOrKeys: [...workItemReferences],
    },
    requiredRoles: ["qa"],
    auditEvent: (revision) => ({
      projectId: input.projectId,
      principalId: input.principalId,
      eventType: "scenario.created",
      entityType: "scenario",
      entityId: revision.scenarioId,
      payload: { key, kind, revisionNumber: 1 },
    }),
    execute: () => {
      const duplicate = database
        .prepare("SELECT scenario_id FROM scenarios WHERE project_id = ? AND scenario_key = ? COLLATE NOCASE")
        .get(input.projectId, key);
      if (duplicate !== undefined) {
        throw new ApplicationError("SCENARIO_KEY_CONFLICT", `Scenario key '${key}' already exists in this project.`);
      }
      const id = randomUUID();
      const revisionId = randomUUID();
      const now = new Date().toISOString();
      const snapshot = resolveCoverage(database, input.projectId, content, coverageReferences);
      const workItemIds = resolveTaskReferences(database, input.projectId, input.principalId, workItemReferences);
      database.prepare(
        `INSERT INTO scenarios
          (scenario_id, project_id, scenario_key, kind, title, version, created_by_principal_id, created_at)
         VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
      ).run(id, input.projectId, key, kind, content.title, input.principalId, now);
      database.prepare(
        `INSERT INTO scenario_revisions
          (revision_id, project_id, scenario_id, revision_number, status, snapshot_json,
           created_by_principal_id, created_at)
         VALUES (?, ?, ?, 1, 'draft', ?, ?, ?)`,
      ).run(revisionId, input.projectId, id, JSON.stringify(snapshot), input.principalId, now);
      insertCoverage(database, input.projectId, id, 1, snapshot.coverage);
      insertScenarioWorkItems(database, input.projectId, id, 1, workItemIds);
      return {
        id: revisionId,
        projectId: input.projectId,
        scenarioId: id,
        key,
        kind,
        revisionNumber: 1,
        status: "draft",
        snapshot,
        createdByPrincipalId: input.principalId,
        createdAt: now,
        publishedByPrincipalId: null,
        publishedAt: null,
      };
    },
  });
}

export function proposeScenarioRevision(
  database: SqliteDatabase,
  input: ReviseScenarioInput,
): CommandReceipt<ScenarioRevision> {
  const reference = input.scenarioIdOrKey.trim();
  assertProjectAuthorization(database, input.projectId, input.principalId);
  const scenario = findScenario(database, input.projectId, reference);
  if (scenario === undefined) {
    throw new ApplicationError("NOT_FOUND", "Scenario was not found.");
  }
  const content = normalizeContent(input);
  const payloadContent = toJsonContent(content);
  const coverageReferences = normalizeCoverageReferences(input.coverage ?? []);
  const workItemReferences = normalizeWorkItemReferences(input.workItemIdOrKeys ?? []);
  return executeIdempotentCommand(database, {
    projectId: input.projectId,
    principalId: input.principalId,
    action: "scenario.revision.propose",
    requestId: input.requestId,
    payload: {
      projectId: input.projectId,
      scenarioId: scenario.scenario_id,
      expectedVersion: input.expectedVersion,
      content: payloadContent,
      coverage: coverageReferences.map((entry) => ({ ...entry })),
      workItemIdOrKeys: [...workItemReferences],
    },
    requiredRoles: ["qa"],
    auditEvent: (revision) => ({
      projectId: input.projectId,
      principalId: input.principalId,
      eventType: "scenario.revision_proposed",
      entityType: "scenario",
      entityId: scenario.scenario_id,
      payload: { key: scenario.scenario_key, revisionNumber: revision.revisionNumber },
    }),
    execute: () => {
      assertVersion(scenario.version, input.expectedVersion);
      const draft = database.prepare(
        "SELECT revision_number FROM scenario_revisions WHERE project_id = ? AND scenario_id = ? AND status = 'draft'",
      ).get(input.projectId, scenario.scenario_id);
      if (draft !== undefined) {
        throw new ApplicationError("VALIDATION_FAILED", "Publish the open scenario revision before proposing another one.");
      }
      const published = database.prepare(
        `SELECT snapshot_json, revision_number FROM scenario_revisions
         WHERE project_id = ? AND scenario_id = ? AND status = 'published'`,
      ).get(input.projectId, scenario.scenario_id) as { snapshot_json: string; revision_number: number } | undefined;
      if (published === undefined) {
        throw new ApplicationError("VALIDATION_FAILED", "Publish the initial scenario revision before revising it.");
      }
      const snapshot = resolveCoverage(database, input.projectId, content, coverageReferences);
      const workItemIds = resolveTaskReferences(database, input.projectId, input.principalId, workItemReferences);
      const previousSnapshot = JSON.parse(published.snapshot_json) as ScenarioSnapshot;
      const previousWorkItemIds = (database.prepare(
        `SELECT item_id FROM scenario_revision_work_items WHERE project_id = ? AND scenario_id = ? AND revision_number = ? ORDER BY item_id`,
      ).all(input.projectId, scenario.scenario_id, published.revision_number) as Array<{ item_id: string }>).map((row) => row.item_id);
      if (JSON.stringify(snapshot) === JSON.stringify(previousSnapshot) && JSON.stringify([...workItemIds].sort()) === JSON.stringify(previousWorkItemIds)) {
        throw new ApplicationError("VALIDATION_FAILED", "The proposed revision does not change the published scenario.");
      }
      const latest = database.prepare(
        "SELECT MAX(revision_number) AS revision FROM scenario_revisions WHERE project_id = ? AND scenario_id = ?",
      ).get(input.projectId, scenario.scenario_id) as { revision: number };
      const revisionNumber = latest.revision + 1;
      const revisionId = randomUUID();
      const now = new Date().toISOString();
      database.prepare(
        `INSERT INTO scenario_revisions
          (revision_id, project_id, scenario_id, revision_number, status, snapshot_json,
           created_by_principal_id, created_at)
         VALUES (?, ?, ?, ?, 'draft', ?, ?, ?)`,
      ).run(revisionId, input.projectId, scenario.scenario_id, revisionNumber, JSON.stringify(snapshot), input.principalId, now);
      insertCoverage(database, input.projectId, scenario.scenario_id, revisionNumber, snapshot.coverage);
      insertScenarioWorkItems(database, input.projectId, scenario.scenario_id, revisionNumber, workItemIds);
      incrementScenarioVersion(database, input.projectId, scenario.scenario_id, input.expectedVersion);
      return {
        id: revisionId,
        projectId: input.projectId,
        scenarioId: scenario.scenario_id,
        key: scenario.scenario_key,
        kind: scenario.kind,
        revisionNumber,
        status: "draft",
        snapshot,
        createdByPrincipalId: input.principalId,
        createdAt: now,
        publishedByPrincipalId: null,
        publishedAt: null,
      };
    },
  });
}

export function publishScenarioRevision(
  database: SqliteDatabase,
  input: PublishScenarioRevisionInput,
): CommandReceipt<ScenarioRevision> {
  const reference = input.scenarioIdOrKey.trim();
  assertProjectAuthorization(database, input.projectId, input.principalId);
  const scenario = findScenario(database, input.projectId, reference);
  if (scenario === undefined) {
    throw new ApplicationError("NOT_FOUND", "Scenario was not found.");
  }
  return executeIdempotentCommand(database, {
    projectId: input.projectId,
    principalId: input.principalId,
    action: "scenario.revision.publish",
    requestId: input.requestId,
    payload: {
      projectId: input.projectId,
      scenarioId: scenario.scenario_id,
      revisionNumber: input.revisionNumber,
      expectedVersion: input.expectedVersion,
    },
    requiredRoles: ["qa"],
    auditEvent: (revision) => ({
      projectId: input.projectId,
      principalId: input.principalId,
      eventType: "scenario.revision_published",
      entityType: "scenario",
      entityId: scenario.scenario_id,
      payload: { key: scenario.scenario_key, revisionNumber: revision.revisionNumber },
    }),
    execute: () => {
      assertVersion(scenario.version, input.expectedVersion);
      const row = database.prepare(
        `SELECT r.revision_id, r.project_id, r.scenario_id, s.scenario_key, s.kind,
                r.revision_number, r.status, r.snapshot_json,
                r.created_by_principal_id, r.created_at,
                r.published_by_principal_id, r.published_at
         FROM scenario_revisions r INNER JOIN scenarios s
           ON s.project_id = r.project_id AND s.scenario_id = r.scenario_id
         WHERE r.project_id = ? AND r.scenario_id = ? AND r.revision_number = ?`,
      ).get(input.projectId, scenario.scenario_id, input.revisionNumber) as ScenarioRevisionRow | undefined;
      if (row === undefined) {
        throw new ApplicationError("NOT_FOUND", "Scenario revision was not found.");
      }
      if (row.status !== "draft") {
        throw new ApplicationError("VALIDATION_FAILED", "Only a draft scenario revision can be published.");
      }
      const latest = database.prepare(
        "SELECT MAX(revision_number) AS revision FROM scenario_revisions WHERE project_id = ? AND scenario_id = ?",
      ).get(input.projectId, scenario.scenario_id) as { revision: number };
      if (latest.revision !== row.revision_number) {
        throw new ApplicationError("VALIDATION_FAILED", "Only the latest scenario revision can be published.");
      }
      const principal = database.prepare("SELECT principal_type FROM principals WHERE principal_id = ?")
        .get(input.principalId) as { principal_type: string } | undefined;
      if (principal?.principal_type !== "human") {
        throw new ApplicationError("FORBIDDEN", "Only a human QA principal may publish a scenario revision.");
      }

      const oldPublished = database.prepare(
        `UPDATE scenario_revisions SET status = 'superseded'
         WHERE project_id = ? AND scenario_id = ? AND status = 'published'`,
      ).run(input.projectId, scenario.scenario_id);
      if (oldPublished.changes > 1) {
        throw new ApplicationError("VALIDATION_FAILED", "The scenario has more than one published revision.");
      }
      const now = new Date().toISOString();
      const publication = database.prepare(
        `UPDATE scenario_revisions
         SET status = 'published', published_by_principal_id = ?, published_at = ?
         WHERE project_id = ? AND scenario_id = ? AND revision_number = ? AND status = 'draft'`,
      ).run(input.principalId, now, input.projectId, scenario.scenario_id, input.revisionNumber);
      if (publication.changes !== 1) {
        throw new ApplicationError("VALIDATION_FAILED", "The scenario revision is no longer a draft.");
      }
      const snapshot = JSON.parse(row.snapshot_json) as ScenarioSnapshot;
      const versionUpdate = database.prepare(
        `UPDATE scenarios SET title = ?, version = version + 1
         WHERE project_id = ? AND scenario_id = ? AND version = ?`,
      ).run(snapshot.title, input.projectId, scenario.scenario_id, input.expectedVersion);
      if (versionUpdate.changes !== 1) {
        const current = database.prepare(
          "SELECT version FROM scenarios WHERE project_id = ? AND scenario_id = ?",
        ).get(input.projectId, scenario.scenario_id) as { version: number } | undefined;
        if (current === undefined) {
          throw new ApplicationError("NOT_FOUND", "Scenario was not found.");
        }
        assertVersion(current.version, input.expectedVersion);
      }
      return {
        ...toRevision(row),
        status: "published",
        snapshot,
        publishedByPrincipalId: input.principalId,
        publishedAt: now,
      };
    },
  });
}

export function recordTestRun(
  database: SqliteDatabase,
  input: RecordTestRunInput,
): CommandReceipt<TestRun> {
  const scenarioReference = input.scenarioIdOrKey.trim();
  const buildId = input.buildId.trim();
  const notes = input.notes?.trim() || null;
  const evidenceUri = input.evidenceUri?.trim() || null;
  const workItemReferences = normalizeWorkItemReferences(input.workItemIdOrKeys ?? []);
  const origin: TestRunOrigin = input.origin ?? "agent";
  const evidenceSha256 = input.evidenceSha256?.trim().toLowerCase() ?? null;
  if (evidenceSha256 !== null && !/^[0-9a-f]{64}$/u.test(evidenceSha256)) {
    throw new ApplicationError("VALIDATION_FAILED", "Evidence SHA-256 must be 64 hexadecimal characters.");
  }
  if (buildId.length === 0 || buildId.length > 128) {
    throw new ApplicationError("VALIDATION_FAILED", "Build ID must contain between 1 and 128 characters.");
  }
  if ((notes?.length ?? 0) > 2_000 || (evidenceUri?.length ?? 0) > 2_048) {
    throw new ApplicationError("VALIDATION_FAILED", "Run notes or evidence URI exceed their allowed length.");
  }
  return executeIdempotentCommand(database, {
    projectId: input.projectId,
    principalId: input.principalId,
    action: "test_run.record",
    requestId: input.requestId,
    payload: {
      projectId: input.projectId,
      scenarioIdOrKey: scenarioReference,
      revisionNumber: input.revisionNumber,
      buildId,
      result: input.result,
      notes,
      evidenceUri,
      origin,
      evidenceSha256,
      workItemIdOrKeys: [...workItemReferences],
    },
    requiredRoles: ["developer", "qa"],
    auditEvent: (run) => ({
      projectId: input.projectId,
      principalId: input.principalId,
      eventType: "test_run.recorded",
      entityType: "test_run",
      entityId: run.id,
      payload: {
        scenarioId: run.scenarioId,
        scenarioKey: run.scenarioKey,
        revisionNumber: run.revisionNumber,
        buildId: run.buildId,
        result: run.result,
        origin: run.origin,
        workItemIdOrKeys: [...workItemReferences],
      },
    }),
    execute: () => {
      if (origin === "ci") requireVerifiedWorkflowRun(database, input.projectId, buildId);
      const scenario = findScenario(database, input.projectId, scenarioReference);
      if (scenario === undefined) {
        throw new ApplicationError("NOT_FOUND", "Scenario was not found.");
      }
      if (!Number.isSafeInteger(input.revisionNumber) || input.revisionNumber < 1) {
        throw new ApplicationError("VALIDATION_FAILED", "Revision number must be a positive integer.");
      }
      const revision = database.prepare(
        `SELECT status FROM scenario_revisions
         WHERE project_id = ? AND scenario_id = ? AND revision_number = ?`,
      ).get(input.projectId, scenario.scenario_id, input.revisionNumber) as { status: string } | undefined;
      if (revision === undefined) {
        throw new ApplicationError("NOT_FOUND", "Scenario revision was not found.");
      }
      if (revision.status !== "published" && revision.status !== "superseded") {
        throw new ApplicationError("VALIDATION_FAILED", "A run must reference a published scenario revision.");
      }
      const run: TestRun = {
        id: randomUUID(),
        projectId: input.projectId,
        scenarioId: scenario.scenario_id,
        scenarioKey: scenario.scenario_key,
        revisionNumber: input.revisionNumber,
        buildId,
        result: input.result,
        notes,
        evidenceUri,
        origin,
        evidenceSha256,
        executedByPrincipalId: input.principalId,
        executedAt: new Date().toISOString(),
      };
      database.prepare(
        `INSERT INTO test_runs
          (run_id, project_id, scenario_id, revision_number, build_id, result, notes, evidence_uri,
           origin, evidence_sha256, executed_by_principal_id, executed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        run.id,
        run.projectId,
        run.scenarioId,
        run.revisionNumber,
        run.buildId,
        run.result,
        run.notes,
        run.evidenceUri,
        run.origin,
        run.evidenceSha256,
        run.executedByPrincipalId,
        run.executedAt,
      );
      const linkedTaskIds = resolveTaskReferences(database, input.projectId, input.principalId, workItemReferences);
      const linkTask = database.prepare(
        `INSERT INTO test_run_work_items (project_id, run_id, item_id, linked_by_principal_id, linked_at)
         VALUES (?, ?, ?, ?, ?)`,
      );
      for (const itemId of linkedTaskIds) linkTask.run(input.projectId, run.id, itemId, input.principalId, run.executedAt);
      return run;
    },
  });
}

/**
 * A ci run is trusted only when a received GitHub workflow_run for this project concluded
 * with success on a head SHA that the build id (git-<sha>) identifies.
 */
function requireVerifiedWorkflowRun(database: SqliteDatabase, projectId: string, buildId: string): void {
  const sha = /^git-([0-9a-f]{7,40})$/iu.exec(buildId)?.[1]?.toLowerCase();
  if (sha === undefined) {
    throw new ApplicationError("VALIDATION_FAILED", "A ci run requires a build id of the form git-<sha> (7-40 hex characters).");
  }
  const match = database.prepare(
    `WITH latest AS (
       SELECT MAX(sequence) AS sequence FROM github_workflow_run_events
       WHERE project_id = ? GROUP BY repository_full_name, workflow_run_id
     )
     SELECT event.workflow_run_id FROM latest
     INNER JOIN github_workflow_run_events AS event ON event.sequence = latest.sequence
     WHERE event.status = 'completed' AND event.conclusion = 'success'
       AND substr(lower(event.head_sha), 1, ?) = ?
     LIMIT 1`,
  ).get(projectId, sha.length, sha) as { workflow_run_id: string } | undefined;
  if (match === undefined) {
    throw new ApplicationError(
      "VALIDATION_FAILED",
      `No successful GitHub workflow run was received for commit ${sha}; record the run as origin "agent" or "human", or wait for the webhook.`,
    );
  }
}

function normalizeContent(input: ScenarioContentInput): Omit<ScenarioSnapshot, "coverage"> {
  const title = input.title.trim();
  const preconditions = (input.preconditions ?? []).map((condition) => condition.trim());
  const steps = input.steps.map((step) => ({ action: step.action.trim(), expected: step.expected.trim() }));
  if (title.length === 0 || title.length > 200) {
    throw new ApplicationError("VALIDATION_FAILED", "Scenario title must contain 1-200 characters.");
  }
  if (preconditions.length > 20 || preconditions.some((condition) => condition.length === 0 || condition.length > 1000)) {
    throw new ApplicationError("VALIDATION_FAILED", "Scenarios allow up to 20 preconditions of 1-1000 characters.");
  }
  if (steps.length === 0 || steps.length > 100 || steps.some((step) =>
    step.action.length === 0 || step.action.length > 2000 || step.expected.length === 0 || step.expected.length > 2000,
  )) {
    throw new ApplicationError("VALIDATION_FAILED", "Scenarios require 1-100 steps with action and expected text up to 2000 characters.");
  }
  return { title, preconditions, steps };
}

function toJsonContent(content: Omit<ScenarioSnapshot, "coverage">): {
  readonly title: string;
  readonly preconditions: string[];
  readonly steps: Array<{ action: string; expected: string }>;
} {
  return {
    title: content.title,
    preconditions: [...content.preconditions],
    steps: content.steps.map((step) => ({ action: step.action, expected: step.expected })),
  };
}

function normalizeCoverageReferences(
  coverage: readonly { readonly targetType: "criterion" | "specification"; readonly reference: string }[],
): readonly { readonly targetType: "criterion" | "specification"; readonly reference: string }[] {
  if (coverage.length > 100) {
    throw new ApplicationError("VALIDATION_FAILED", "A scenario can cover up to 100 criteria or specifications.");
  }
  const seen = new Set<string>();
  return coverage.map((entry) => {
    const reference = entry.reference.trim();
    if (reference.length === 0 || reference.length > 120) {
      throw new ApplicationError("VALIDATION_FAILED", "Coverage references must contain 1-120 characters.");
    }
    const identity = `${entry.targetType}:${reference.toLowerCase()}`;
    if (seen.has(identity)) {
      throw new ApplicationError("VALIDATION_FAILED", "Coverage targets must be unique within a revision.");
    }
    seen.add(identity);
    return { targetType: entry.targetType, reference };
  });
}

function normalizeWorkItemReferences(references: readonly string[]): readonly string[] {
  if (references.length > 100) throw new ApplicationError("VALIDATION_FAILED", "A scenario or test run can reference up to 100 tasks.");
  const normalized = references.map((reference) => reference.trim());
  if (normalized.some((reference) => reference.length === 0 || reference.length > 120)) {
    throw new ApplicationError("VALIDATION_FAILED", "Task references must contain 1-120 characters.");
  }
  const unique = new Set(normalized.map((reference) => reference.toLowerCase()));
  if (unique.size !== normalized.length) throw new ApplicationError("VALIDATION_FAILED", "Task references must be unique.");
  return normalized;
}

function resolveTaskReferences(database: SqliteDatabase, projectId: string, principalId: string, references: readonly string[]): string[] {
  return references.map((reference) => {
    const item = getWorkItem(database, projectId, principalId, reference);
    if (item.type !== "task") throw new ApplicationError("VALIDATION_FAILED", `Work item '${reference}' is a ${item.type}, but scenario task links accept only tasks. Cover a story or bug through its criteria (coverage: targetType "criterion") instead.`);
    return item.id;
  });
}

function insertScenarioWorkItems(
  database: SqliteDatabase,
  projectId: string,
  scenarioId: string,
  revisionNumber: number,
  itemIds: readonly string[],
): void {
  const insert = database.prepare(
    `INSERT INTO scenario_revision_work_items (project_id, scenario_id, revision_number, item_id)
     VALUES (?, ?, ?, ?)`,
  );
  for (const itemId of itemIds) insert.run(projectId, scenarioId, revisionNumber, itemId);
}

function resolveCoverage(
  database: SqliteDatabase,
  projectId: string,
  content: Omit<ScenarioSnapshot, "coverage">,
  references: readonly { readonly targetType: "criterion" | "specification"; readonly reference: string }[],
): ScenarioSnapshot {
  const coverage = references.map((entry): ScenarioCoverageTarget => ({
    targetType: entry.targetType,
    targetId: entry.targetType === "criterion"
      ? resolveCriterion(database, projectId, entry.reference)
      : resolveSpecification(database, projectId, entry.reference),
  }));
  return { ...content, coverage };
}

function resolveSpecification(database: SqliteDatabase, projectId: string, reference: string): string {
  const row = database.prepare(
    `SELECT spec_id FROM specifications
     WHERE project_id = ? AND (spec_id = ? OR spec_key = ? COLLATE NOCASE)`,
  ).get(projectId, reference, reference) as { spec_id: string } | undefined;
  if (row === undefined) {
    throw new ApplicationError("NOT_FOUND", "Coverage specification was not found in this project.");
  }
  return row.spec_id;
}

function insertCoverage(
  database: SqliteDatabase,
  projectId: string,
  scenarioId: string,
  revisionNumber: number,
  coverage: readonly ScenarioCoverageTarget[],
): void {
  const insert = database.prepare(
    `INSERT INTO scenario_revision_coverage
      (project_id, scenario_id, revision_number, target_type, target_id)
     VALUES (?, ?, ?, ?, ?)`,
  );
  for (const target of coverage) {
    insert.run(projectId, scenarioId, revisionNumber, target.targetType, target.targetId);
  }
}

function assertVersion(actual: number, expected: number): void {
  if (!Number.isSafeInteger(expected) || expected < 1) {
    throw new ApplicationError("VALIDATION_FAILED", "Expected version must be a positive integer.");
  }
  if (actual !== expected) {
    throw new ApplicationError("VERSION_CONFLICT", "The scenario changed since it was read.", {
      details: { expectedVersion: expected, actualVersion: actual },
    });
  }
}

function incrementScenarioVersion(
  database: SqliteDatabase,
  projectId: string,
  scenarioId: string,
  expectedVersion: number,
): void {
  const result = database.prepare(
    "UPDATE scenarios SET version = version + 1 WHERE project_id = ? AND scenario_id = ? AND version = ?",
  ).run(projectId, scenarioId, expectedVersion);
  if (result.changes !== 1) {
    const current = database.prepare(
      "SELECT version FROM scenarios WHERE project_id = ? AND scenario_id = ?",
    ).get(projectId, scenarioId) as { version: number } | undefined;
    if (current === undefined) {
      throw new ApplicationError("NOT_FOUND", "Scenario was not found.");
    }
    assertVersion(current.version, expectedVersion);
  }
}
