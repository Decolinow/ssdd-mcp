import { randomUUID } from "node:crypto";
import type { BaselineReference, ImpactFlag, WorkBaseline } from "../domain/baselines.js";
import type { SqliteDatabase } from "../storage-sqlite/database.js";
import { ApplicationError } from "./errors.js";
import { executeIdempotentCommand, type CommandReceipt } from "./idempotent-command.js";
import { assertProjectAuthorization } from "./local-identity.js";

export interface FixWorkItemBaselineInput {
  readonly projectId: string;
  readonly principalId: string;
  readonly requestId: string;
  readonly itemIdOrKey: string;
  readonly expectedVersion: number;
  readonly reason: string;
}

export type RevalidateWorkItemBaselineInput = FixWorkItemBaselineInput;

interface WorkItemTarget {
  readonly item_id: string;
  readonly project_id: string;
  readonly item_key: string;
  readonly state: string;
  readonly version: number;
}

interface CapturedReference {
  readonly entityType: BaselineReference["entityType"];
  readonly entityId: string;
  readonly revisionNumber: number;
}

interface CreatedImpact {
  readonly id: string;
  readonly itemId: string;
  readonly itemKey: string;
  readonly baselineId: string;
  readonly baselineRevision: number;
  readonly publishedRevision: number;
}

export function fixWorkItemBaseline(
  database: SqliteDatabase,
  input: FixWorkItemBaselineInput,
): CommandReceipt<WorkBaseline> {
  const target = findWorkItem(database, input.projectId, input.principalId, input.itemIdOrKey.trim());
  const reason = normalizeReason(input.reason);
  return executeIdempotentCommand(database, {
    projectId: input.projectId,
    principalId: input.principalId,
    action: "work_item.baseline.fix",
    requestId: input.requestId,
    payload: {
      projectId: input.projectId,
      itemId: target.item_id,
      expectedVersion: input.expectedVersion,
      reason,
    },
    requiredRoles: ["po"],
    auditEvent: (baseline) => ({
      projectId: input.projectId,
      principalId: input.principalId,
      eventType: "work_item.baseline_fixed",
      entityType: "work_item",
      entityId: target.item_id,
      payload: {
        baselineId: baseline.id,
        sequence: baseline.sequence,
        referenceCount: baseline.references.length,
      },
    }),
    execute: () => {
      assertExpectedVersion(target.version, input.expectedVersion);
      const current = readCurrentWorkItem(database, input.projectId, target.item_id);
      if (current.state !== "ready") {
        throw new ApplicationError("VALIDATION_FAILED", "A baseline can only be fixed when the work item is ready.");
      }
      const existing = database.prepare(
        "SELECT baseline_id FROM work_baselines WHERE project_id = ? AND item_id = ? LIMIT 1",
      ).get(input.projectId, target.item_id);
      if (existing !== undefined) {
        throw new ApplicationError("VALIDATION_FAILED", "This work item already has a baseline; use revalidation to update it.");
      }
      const baseline = createBaseline(database, {
        projectId: input.projectId,
        principalId: input.principalId,
        target,
        kind: "ready",
        reason,
      });
      incrementWorkItemVersion(database, input.projectId, target.item_id, input.expectedVersion);
      return baseline;
    },
  });
}

/** Creates the first baseline inside the caller's work item transition transaction. */
export function createBaselineForReadyTransition(
  database: SqliteDatabase,
  input: { readonly projectId: string; readonly principalId: string; readonly itemId: string; readonly reason: string },
): WorkBaseline {
  const target = findWorkItem(database, input.projectId, input.principalId, input.itemId);
  const reason = normalizeReason(input.reason);
  const current = readCurrentWorkItem(database, input.projectId, target.item_id);
  if (current.state !== "ready") {
    throw new ApplicationError("INVALID_TRANSITION", "The work item must enter Ready before its baseline is created.");
  }
  const existing = database.prepare(
    "SELECT baseline_id FROM work_baselines WHERE project_id = ? AND item_id = ? LIMIT 1",
  ).get(input.projectId, target.item_id);
  if (existing !== undefined) {
    throw new ApplicationError("VALIDATION_FAILED", "A Ready transition cannot replace an existing baseline; revalidation is required.");
  }
  return createBaseline(database, {
    projectId: input.projectId,
    principalId: input.principalId,
    target,
    kind: "ready",
    reason,
  });
}

export function revalidateWorkItemBaseline(
  database: SqliteDatabase,
  input: RevalidateWorkItemBaselineInput,
): CommandReceipt<{ baseline: WorkBaseline; resolvedImpactIds: readonly string[] }> {
  const target = findWorkItem(database, input.projectId, input.principalId, input.itemIdOrKey.trim());
  const reason = normalizeReason(input.reason);
  return executeIdempotentCommand(database, {
    projectId: input.projectId,
    principalId: input.principalId,
    action: "work_item.baseline.revalidate",
    requestId: input.requestId,
    payload: {
      projectId: input.projectId,
      itemId: target.item_id,
      expectedVersion: input.expectedVersion,
      reason,
    },
    requiredRoles: ["po", "tech_lead"],
    auditEvent: (result) => ({
      projectId: input.projectId,
      principalId: input.principalId,
      eventType: "work_item.baseline_revalidated",
      entityType: "work_item",
      entityId: target.item_id,
      payload: {
        baselineId: result.baseline.id,
        sequence: result.baseline.sequence,
        resolvedImpactIds: result.resolvedImpactIds,
      },
    }),
    execute: () => {
      assertExpectedVersion(target.version, input.expectedVersion);
      const current = readCurrentWorkItem(database, input.projectId, target.item_id);
      if (["draft", "cancelled"].includes(current.state)) {
        throw new ApplicationError("VALIDATION_FAILED", "Only an active work item can be revalidated.");
      }
      const openImpacts = database.prepare(
        `SELECT impact_id, specification_id, published_revision
         FROM impact_flags WHERE project_id = ? AND item_id = ? AND status = 'open'
         ORDER BY created_at, impact_id`,
      ).all(input.projectId, target.item_id) as Array<{
        impact_id: string;
        specification_id: string;
        published_revision: number;
      }>;
      if (openImpacts.length === 0) {
        throw new ApplicationError("VALIDATION_FAILED", "There are no open impact flags to revalidate.");
      }
      const principal = database.prepare("SELECT principal_type FROM principals WHERE principal_id = ?")
        .get(input.principalId) as { principal_type: string } | undefined;
      if (principal?.principal_type !== "human") {
        throw new ApplicationError("FORBIDDEN", "Only a human PO or Tech Lead may revalidate a baseline.");
      }
      const baseline = createBaseline(database, {
        projectId: input.projectId,
        principalId: input.principalId,
        target,
        kind: "revalidation",
        reason,
      });
      const resolve = database.prepare(
        `UPDATE impact_flags
         SET status = 'revalidated', resolved_by_principal_id = ?, resolved_at = ?, revalidated_baseline_id = ?
         WHERE project_id = ? AND impact_id = ? AND status = 'open'`,
      );
      const resolvedImpactIds: string[] = [];
      const now = new Date().toISOString();
      for (const impact of openImpacts) {
        const refExists = baseline.references.some((reference) =>
          reference.entityType === "specification_revision" &&
          reference.entityId === impact.specification_id &&
          reference.revisionNumber === impact.published_revision,
        );
        if (!refExists) {
          throw new ApplicationError(
            "VALIDATION_FAILED",
            "Revalidation did not capture every impacted published specification; review trace links before retrying.",
          );
        }
        const result = resolve.run(
          input.principalId,
          now,
          baseline.id,
          input.projectId,
          impact.impact_id,
        );
        if (result.changes === 1) {
          resolvedImpactIds.push(impact.impact_id);
        }
      }
      incrementWorkItemVersion(database, input.projectId, target.item_id, input.expectedVersion);
      return { baseline, resolvedImpactIds };
    },
  });
}

export function recordBaselineImpactsForPublishedSpecification(
  database: SqliteDatabase,
  input: { projectId: string; principalId: string; specificationId: string; revisionNumber: number; now: string },
): readonly CreatedImpact[] {
  const candidates = database.prepare(
    `SELECT wi.item_id, wi.item_key, b.baseline_id, br.revision_number AS baseline_revision
     FROM trace_links l
     INNER JOIN work_items wi ON wi.project_id = l.project_id AND wi.item_id = l.source_id
     INNER JOIN work_baselines b ON b.project_id = wi.project_id AND b.item_id = wi.item_id
       AND b.sequence = (
         SELECT MAX(latest.sequence) FROM work_baselines latest
         WHERE latest.project_id = b.project_id AND latest.item_id = b.item_id
       )
     INNER JOIN baseline_refs br ON br.project_id = b.project_id AND br.baseline_id = b.baseline_id
     WHERE l.project_id = ? AND l.link_type = 'implements' AND l.target_id = ? AND l.removed_at IS NULL
       AND wi.state IN ('ready', 'in_progress', 'in_review', 'in_validation', 'done')
       AND br.entity_type = 'specification_revision' AND br.entity_id = ?
       AND br.revision_number < ?`,
  ).all(input.projectId, input.specificationId, input.specificationId, input.revisionNumber) as Array<{
    item_id: string;
    item_key: string;
    baseline_id: string;
    baseline_revision: number;
  }>;
  const create = database.prepare(
    `INSERT OR IGNORE INTO impact_flags
      (impact_id, project_id, item_id, baseline_id, specification_id,
       baseline_revision, published_revision, reason, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const impacted: CreatedImpact[] = [];
  const spec = database.prepare(
    "SELECT spec_key FROM specifications WHERE project_id = ? AND spec_id = ?",
  ).get(input.projectId, input.specificationId) as { spec_key: string } | undefined;
  if (spec === undefined) {
    return [];
  }
  for (const candidate of candidates) {
    const impactId = randomUUID();
    const reason = `Specification ${spec.spec_key} revision ${input.revisionNumber} was published after ${candidate.item_key} was ready.`;
    const result = create.run(
      impactId,
      input.projectId,
      candidate.item_id,
      candidate.baseline_id,
      input.specificationId,
      candidate.baseline_revision,
      input.revisionNumber,
      reason,
      input.now,
    );
    if (result.changes !== 1) {
      continue;
    }
    database.prepare(
      "UPDATE work_items SET version = version + 1, updated_at = ? WHERE project_id = ? AND item_id = ?",
    ).run(input.now, input.projectId, candidate.item_id);
    impacted.push({
      id: impactId,
      itemId: candidate.item_id,
      itemKey: candidate.item_key,
      baselineId: candidate.baseline_id,
      baselineRevision: candidate.baseline_revision,
      publishedRevision: input.revisionNumber,
    });
  }
  return impacted;
}

export function getWorkBaseline(
  database: SqliteDatabase,
  projectId: string,
  principalId: string,
  itemIdOrKey: string,
  sequence?: number,
): WorkBaseline {
  assertProjectAuthorization(database, projectId, principalId);
  const target = findWorkItem(database, projectId, principalId, itemIdOrKey.trim());
  if (sequence !== undefined && (!Number.isSafeInteger(sequence) || sequence < 1)) {
    throw new ApplicationError("VALIDATION_FAILED", "Baseline sequence must be a positive integer.");
  }
  const baseline = database.prepare(
    `SELECT baseline_id, project_id, item_id, sequence, kind, reason, created_by_principal_id, created_at
     FROM work_baselines WHERE project_id = ? AND item_id = ? AND (? IS NULL OR sequence = ?)
     ORDER BY sequence DESC LIMIT 1`,
  ).get(projectId, target.item_id, sequence ?? null, sequence ?? null) as {
    baseline_id: string;
    project_id: string;
    item_id: string;
    sequence: number;
    kind: WorkBaseline["kind"];
    reason: string;
    created_by_principal_id: string;
    created_at: string;
  } | undefined;
  if (baseline === undefined) {
    throw new ApplicationError("NOT_FOUND", "Baseline was not found for this work item.");
  }
  const references = database.prepare(
    `SELECT br.entity_type, br.entity_id, br.revision_number,
      CASE br.entity_type
        WHEN 'work_item_revision' THEN (SELECT item_key FROM work_items wi WHERE wi.project_id = br.project_id AND wi.item_id = br.entity_id)
        WHEN 'specification_revision' THEN (SELECT spec_key FROM specifications s WHERE s.project_id = br.project_id AND s.spec_id = br.entity_id)
        ELSE (SELECT scenario_key FROM scenarios sc WHERE sc.project_id = br.project_id AND sc.scenario_id = br.entity_id)
      END AS entity_key,
      CASE br.entity_type
        WHEN 'work_item_revision' THEN (SELECT snapshot_json FROM work_item_revisions r WHERE r.project_id = br.project_id AND r.item_id = br.entity_id AND r.revision_number = br.revision_number)
        WHEN 'specification_revision' THEN (SELECT content_json FROM specification_revisions r WHERE r.project_id = br.project_id AND r.spec_id = br.entity_id AND r.revision_number = br.revision_number)
        ELSE (SELECT snapshot_json FROM scenario_revisions r WHERE r.project_id = br.project_id AND r.scenario_id = br.entity_id AND r.revision_number = br.revision_number)
      END AS snapshot_json
     FROM baseline_refs br WHERE br.project_id = ? AND br.baseline_id = ?
     ORDER BY br.entity_type, entity_key COLLATE NOCASE`,
  ).all(projectId, baseline.baseline_id) as Array<{
    entity_type: BaselineReference["entityType"];
    entity_id: string;
    revision_number: number;
    entity_key: string;
    snapshot_json: string;
  }>;
  return {
    id: baseline.baseline_id,
    projectId: baseline.project_id,
    itemId: baseline.item_id,
    itemKey: target.item_key,
    sequence: baseline.sequence,
    kind: baseline.kind,
    reason: baseline.reason,
    createdByPrincipalId: baseline.created_by_principal_id,
    createdAt: baseline.created_at,
    references: references.map((reference) => ({
      entityType: reference.entity_type,
      entityId: reference.entity_id,
      key: reference.entity_key,
      revisionNumber: reference.revision_number,
      snapshot: JSON.parse(reference.snapshot_json) as unknown,
    })),
  };
}

export function listImpactFlags(
  database: SqliteDatabase,
  projectId: string,
  principalId: string,
  itemIdOrKey: string,
  status?: ImpactFlag["status"],
): readonly ImpactFlag[] {
  assertProjectAuthorization(database, projectId, principalId);
  const target = findWorkItem(database, projectId, principalId, itemIdOrKey.trim());
  if (status !== undefined && status !== "open" && status !== "revalidated") {
    throw new ApplicationError("VALIDATION_FAILED", "Impact status is invalid.");
  }
  const rows = database.prepare(
    `SELECT f.impact_id, f.project_id, f.item_id, wi.item_key, f.baseline_id,
            f.specification_id, s.spec_key, f.baseline_revision, f.published_revision,
            f.reason, f.status, f.created_at, f.resolved_by_principal_id,
            f.resolved_at, f.revalidated_baseline_id
     FROM impact_flags f
     INNER JOIN work_items wi ON wi.project_id = f.project_id AND wi.item_id = f.item_id
     INNER JOIN specifications s ON s.project_id = f.project_id AND s.spec_id = f.specification_id
     WHERE f.project_id = ? AND f.item_id = ? AND (? IS NULL OR f.status = ?)
     ORDER BY f.created_at, f.impact_id`,
  ).all(projectId, target.item_id, status ?? null, status ?? null) as Array<{
    impact_id: string;
    project_id: string;
    item_id: string;
    item_key: string;
    baseline_id: string;
    specification_id: string;
    spec_key: string;
    baseline_revision: number;
    published_revision: number;
    reason: string;
    status: ImpactFlag["status"];
    created_at: string;
    resolved_by_principal_id: string | null;
    resolved_at: string | null;
    revalidated_baseline_id: string | null;
  }>;
  return rows.map((row) => ({
    id: row.impact_id,
    projectId: row.project_id,
    itemId: row.item_id,
    itemKey: row.item_key,
    baselineId: row.baseline_id,
    specificationId: row.specification_id,
    specificationKey: row.spec_key,
    baselineRevision: row.baseline_revision,
    publishedRevision: row.published_revision,
    reason: row.reason,
    status: row.status,
    createdAt: row.created_at,
    resolvedByPrincipalId: row.resolved_by_principal_id,
    resolvedAt: row.resolved_at,
    revalidatedBaselineId: row.revalidated_baseline_id,
  }));
}

function createBaseline(
  database: SqliteDatabase,
  input: {
    projectId: string;
    principalId: string;
    target: WorkItemTarget;
    kind: WorkBaseline["kind"];
    reason: string;
  },
): WorkBaseline {
  const refs = captureReferences(database, input.projectId, input.target.item_id);
  const sequenceRow = database.prepare(
    "SELECT COALESCE(MAX(sequence), 0) AS sequence FROM work_baselines WHERE project_id = ? AND item_id = ?",
  ).get(input.projectId, input.target.item_id) as { sequence: number };
  const sequence = sequenceRow.sequence + 1;
  const id = randomUUID();
  const createdAt = new Date().toISOString();
  database.prepare(
    `INSERT INTO work_baselines
      (baseline_id, project_id, item_id, sequence, kind, reason, created_by_principal_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, input.projectId, input.target.item_id, sequence, input.kind, input.reason, input.principalId, createdAt);
  const insertRef = database.prepare(
    `INSERT INTO baseline_refs (project_id, baseline_id, entity_type, entity_id, revision_number)
     VALUES (?, ?, ?, ?, ?)`,
  );
  for (const ref of refs) {
    insertRef.run(input.projectId, id, ref.entityType, ref.entityId, ref.revisionNumber);
  }
  return getWorkBaseline(database, input.projectId, input.principalId, input.target.item_id, sequence);
}

function captureReferences(database: SqliteDatabase, projectId: string, itemId: string): CapturedReference[] {
  const workRevision = database.prepare(
    `SELECT revision_number FROM work_item_revisions
     WHERE project_id = ? AND item_id = ? AND status = 'published'`,
  ).get(projectId, itemId) as { revision_number: number } | undefined;
  if (workRevision === undefined) {
    throw new ApplicationError("VALIDATION_FAILED", "The work item has no published content revision to baseline.");
  }
  const refs: CapturedReference[] = [{
    entityType: "work_item_revision",
    entityId: itemId,
    revisionNumber: workRevision.revision_number,
  }];
  const specs = database.prepare(
    `SELECT DISTINCT s.spec_id, r.revision_number
     FROM trace_links l
     INNER JOIN specifications s ON s.project_id = l.project_id AND s.spec_id = l.target_id
     INNER JOIN specification_revisions r ON r.project_id = s.project_id AND r.spec_id = s.spec_id AND r.status = 'published'
     WHERE l.project_id = ? AND l.source_id = ? AND l.link_type = 'implements' AND l.removed_at IS NULL`,
  ).all(projectId, itemId) as Array<{ spec_id: string; revision_number: number }>;
  const specIds = new Set<string>();
  for (const spec of specs) {
    specIds.add(spec.spec_id);
    refs.push({ entityType: "specification_revision", entityId: spec.spec_id, revisionNumber: spec.revision_number });
  }

  const criteria = database.prepare(
    `SELECT criterion_id FROM work_item_criteria WHERE project_id = ? AND item_id = ? AND is_active = 1`,
  ).all(projectId, itemId) as Array<{ criterion_id: string }>;
  const scenarioRevisions = new Map<string, number>();
  const addScenarios = database.prepare(
    `SELECT DISTINCT r.scenario_id, r.revision_number
     FROM scenario_revision_coverage c
     INNER JOIN scenario_revisions r ON r.project_id = c.project_id AND r.scenario_id = c.scenario_id
       AND r.revision_number = c.revision_number AND r.status = 'published'
     WHERE c.project_id = ? AND c.target_type = ? AND c.target_id = ?`,
  );
  for (const criterion of criteria) {
    const matches = addScenarios.all(projectId, "criterion", criterion.criterion_id) as Array<{
      scenario_id: string;
      revision_number: number;
    }>;
    for (const match of matches) scenarioRevisions.set(match.scenario_id, match.revision_number);
  }
  for (const specId of specIds) {
    const matches = addScenarios.all(projectId, "specification", specId) as Array<{
      scenario_id: string;
      revision_number: number;
    }>;
    for (const match of matches) scenarioRevisions.set(match.scenario_id, match.revision_number);
  }
  for (const [scenarioId, revisionNumber] of scenarioRevisions) {
    refs.push({ entityType: "scenario_revision", entityId: scenarioId, revisionNumber });
  }
  return refs;
}

function findWorkItem(
  database: SqliteDatabase,
  projectId: string,
  principalId: string,
  reference: string,
): WorkItemTarget {
  assertProjectAuthorization(database, projectId, principalId);
  if (reference.length === 0) {
    throw new ApplicationError("VALIDATION_FAILED", "A work item ID or key is required.");
  }
  const item = database.prepare(
    `SELECT item_id, project_id, item_key, state, version FROM work_items
     WHERE project_id = ? AND (item_id = ? OR item_key = ? COLLATE NOCASE)`,
  ).get(projectId, reference, reference) as WorkItemTarget | undefined;
  if (item === undefined) {
    throw new ApplicationError("NOT_FOUND", "Work item was not found.");
  }
  return item;
}

function readCurrentWorkItem(database: SqliteDatabase, projectId: string, itemId: string): WorkItemTarget {
  const item = database.prepare(
    "SELECT item_id, project_id, item_key, state, version FROM work_items WHERE project_id = ? AND item_id = ?",
  ).get(projectId, itemId) as WorkItemTarget | undefined;
  if (item === undefined) {
    throw new ApplicationError("NOT_FOUND", "Work item was not found.");
  }
  return item;
}

function incrementWorkItemVersion(
  database: SqliteDatabase,
  projectId: string,
  itemId: string,
  expectedVersion: number,
): void {
  const result = database.prepare(
    `UPDATE work_items SET version = version + 1, updated_at = ?
     WHERE project_id = ? AND item_id = ? AND version = ?`,
  ).run(new Date().toISOString(), projectId, itemId, expectedVersion);
  if (result.changes !== 1) {
    const current = database.prepare(
      "SELECT version FROM work_items WHERE project_id = ? AND item_id = ?",
    ).get(projectId, itemId) as { version: number } | undefined;
    if (current === undefined) {
      throw new ApplicationError("NOT_FOUND", "Work item was not found.");
    }
    assertExpectedVersion(current.version, expectedVersion);
  }
}

function assertExpectedVersion(actual: number, expected: number): void {
  if (!Number.isSafeInteger(expected) || expected < 1) {
    throw new ApplicationError("VALIDATION_FAILED", "Expected version must be a positive integer.");
  }
  if (actual !== expected) {
    throw new ApplicationError("VERSION_CONFLICT", "The work item changed since it was read.", {
      details: { expectedVersion: expected, actualVersion: actual },
    });
  }
}

function normalizeReason(value: string): string {
  const reason = value.trim();
  if (reason.length === 0 || reason.length > 1_000) {
    throw new ApplicationError("VALIDATION_FAILED", "Reason must contain between 1 and 1000 characters.");
  }
  return reason;
}
