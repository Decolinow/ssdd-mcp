import type { WorkBaseline } from "../domain/baselines.js";
import type { ScenarioSnapshot } from "../domain/scenarios.js";
import type { SpecificationKind } from "../domain/specifications.js";
import type { AcceptanceCriterion, WorkItem, WorkItemContentRevision } from "../domain/work-items.js";
import type { SqliteDatabase } from "../storage-sqlite/database.js";
import { ApplicationError } from "./errors.js";
import { assertProjectAuthorization } from "./local-identity.js";
import { getScenario } from "./scenario-queries.js";
import { getSpecification } from "./specification-queries.js";
import { getWorkBaseline } from "./baseline-commands.js";
import { getWorkItem, listWorkItemRevisions } from "./work-item-queries.js";

export const taskContextProfiles = ["dev", "qa", "po"] as const;
export type TaskContextProfile = (typeof taskContextProfiles)[number];

export const taskContextSections = [
  "hierarchy",
  "acceptanceCriteria",
  "businessRules",
  "technicalDecisions",
  "scenarios",
  "testRuns",
  "baseline",
] as const;
export type TaskContextSection = (typeof taskContextSections)[number];

export interface TaskContextInput {
  readonly projectId: string;
  readonly principalId: string;
  readonly taskIdOrKey: string;
  readonly profile?: TaskContextProfile;
  readonly include?: readonly TaskContextSection[];
  readonly maxChars?: number;
  readonly cursor?: string;
}

export interface TaskContextSource {
  readonly entityType: "work_item_revision" | "specification_revision" | "scenario_revision" | "test_run";
  readonly entityId: string;
  readonly key: string;
  readonly revisionNumber: number | null;
  readonly mode: "pinned" | "current";
  readonly uri: string | null;
}

export interface TaskContextEntry {
  readonly section: TaskContextSection;
  readonly key: string;
  readonly title: string;
  readonly source: TaskContextSource;
  readonly content: unknown;
}

export interface TaskContextWarning {
  readonly code: string;
  readonly message: string;
  readonly key?: string;
}

export interface TaskContextResult {
  readonly task: {
    readonly id: string;
    readonly key: string;
    readonly title: string;
    readonly state: string;
    readonly version: number;
    readonly parentId: string | null;
  };
  readonly profile: TaskContextProfile;
  readonly mode: "pinned" | "preview";
  readonly baseline: { readonly id: string; readonly sequence: number; readonly kind: WorkBaseline["kind"] } | null;
  readonly sections: Readonly<Record<TaskContextSection, readonly TaskContextEntry[]>>;
  readonly warnings: readonly TaskContextWarning[];
  readonly truncated: boolean;
  readonly nextCursor: string | null;
}

interface ContextCursor {
  readonly version: 1;
  readonly projectId: string;
  readonly principalId: string;
  readonly taskId: string;
  readonly profile: TaskContextProfile;
  readonly include: readonly TaskContextSection[];
  readonly maxChars: number;
  readonly watermark: number;
  readonly offset: number;
}

interface SpecificationReferenceRow {
  readonly spec_id: string;
  readonly spec_key: string;
  readonly kind: SpecificationKind;
}

interface ScenarioReferenceRow {
  readonly scenario_id: string;
  readonly scenario_key: string;
  readonly revision_number: number;
  readonly snapshot_json: string;
}

const profileSections: Readonly<Record<TaskContextProfile, readonly TaskContextSection[]>> = {
  dev: ["hierarchy", "acceptanceCriteria", "businessRules", "technicalDecisions", "scenarios"],
  qa: ["hierarchy", "acceptanceCriteria", "businessRules", "scenarios", "testRuns"],
  po: ["hierarchy", "acceptanceCriteria", "businessRules", "technicalDecisions", "scenarios", "testRuns", "baseline"],
};

const sectionOrder: readonly TaskContextSection[] = [
  "hierarchy", "acceptanceCriteria", "businessRules", "technicalDecisions", "scenarios", "testRuns", "baseline",
];

export function getTaskContext(database: SqliteDatabase, input: TaskContextInput): TaskContextResult {
  assertProjectAuthorization(database, input.projectId, input.principalId);
  const profile = input.profile ?? "dev";
  const maxChars = input.maxChars ?? 8_000;
  if (!taskContextProfiles.includes(profile)) {
    throw new ApplicationError("VALIDATION_FAILED", "The task context profile is invalid.");
  }
  if (!Number.isSafeInteger(maxChars) || maxChars < 2_000 || maxChars > 30_000) {
    throw new ApplicationError("VALIDATION_FAILED", "The context character budget must be between 2000 and 30000.");
  }
  const include = normalizeSections(input.include ?? profileSections[profile]);
  const requested = new Set(include);
  const task = getWorkItem(database, input.projectId, input.principalId, input.taskIdOrKey.trim());
  if (task.type !== "task") {
    throw new ApplicationError("VALIDATION_FAILED", "Task context can only be generated for a task work item.");
  }

  const hierarchy = resolveHierarchy(database, input.projectId, input.principalId, task);
  const pbi = hierarchy.find((item) => item.type === "story" || item.type === "bug");
  if (pbi === undefined) {
    throw new ApplicationError("VALIDATION_FAILED", "The task has no story or bug in its parent hierarchy.");
  }

  const baseline = findLatestBaseline(database, input.projectId, pbi.id)
    ? getWorkBaseline(database, input.projectId, input.principalId, pbi.id)
    : undefined;
  const mode = baseline === undefined ? "preview" : "pinned";
  const warnings: TaskContextWarning[] = [];
  if (baseline === undefined) {
    warnings.push({ code: "NO_BASELINE_PREVIEW", message: "No baseline is fixed for the parent PBI; current published revisions are shown as preview." });
  }

  const entries: TaskContextEntry[] = [];
  appendHierarchy(entries, hierarchy, input.projectId, pbi, baseline);
  const criteria = resolveCriteria(database, input.projectId, input.principalId, pbi, baseline);
  for (const criterion of criteria) {
    entries.push({
      section: "acceptanceCriteria",
      key: criterion.key,
      title: criterion.key,
      source: workItemSource(input.projectId, pbi, baseline?.references.find((ref) => ref.entityType === "work_item_revision" && ref.entityId === pbi.id)?.revisionNumber ?? pbi.revision, baseline === undefined ? "current" : "pinned"),
      content: { id: criterion.id, description: criterion.description, required: criterion.required, position: criterion.position },
    });
  }

  const linkedSpecs = findLinkedSpecifications(database, input.projectId, hierarchy.map((item) => item.id));
  const specifications = resolveSpecifications(database, input.projectId, input.principalId, linkedSpecs, baseline, warnings, requested);
  for (const specification of specifications) {
    const section: TaskContextSection = specification.kind === "business_rule" ? "businessRules" : "technicalDecisions";
    entries.push({
      section,
      key: specification.key,
      title: specification.title,
      source: {
        entityType: "specification_revision",
        entityId: specification.id,
        key: specification.key,
        revisionNumber: specification.revisionNumber,
        mode: specification.mode,
        uri: specificationUri(input.projectId, specification.key, specification.revisionNumber),
      },
      content: specification.content,
    });
    if (requested.has(section) && specification.currentRevision !== specification.revisionNumber) {
      warnings.push({
        code: "BASELINE_DRIFT",
        message: `A newer published revision (${specification.currentRevision}) exists than the pinned revision (${specification.revisionNumber}).`,
        key: specification.key,
      });
    }
  }

  const scenarios = resolveScenarios(database, input.projectId, input.principalId, criteria, specifications, baseline);
  for (const scenario of scenarios) {
    entries.push({
      section: "scenarios",
      key: scenario.key,
      title: scenario.snapshot.title,
      source: {
        entityType: "scenario_revision",
        entityId: scenario.id,
        key: scenario.key,
        revisionNumber: scenario.revisionNumber,
        mode: scenario.mode,
        uri: scenarioUri(input.projectId, scenario.key, scenario.revisionNumber),
      },
      content: scenario.snapshot,
    });
  }

  for (const run of resolveTestRuns(database, input.projectId, scenarios)) {
    entries.push({
      section: "testRuns",
      key: `${run.scenarioKey}:${run.buildId}`,
      title: `${run.scenarioKey} · ${run.buildId}`,
      source: {
        entityType: "test_run",
        entityId: run.runId,
        key: run.scenarioKey,
        revisionNumber: run.revisionNumber,
        mode: run.mode,
        uri: `ssdd://projects/${encodeURIComponent(input.projectId)}/test-runs/${encodeURIComponent(run.runId)}`,
      },
      content: { buildId: run.buildId, result: run.result, notes: run.notes, evidenceUri: run.evidenceUri, executedAt: run.executedAt },
    });
  }

  if (baseline !== undefined) {
    entries.push({
      section: "baseline",
      key: `baseline-${baseline.sequence}`,
      title: `Baseline ${baseline.sequence}`,
      source: { entityType: "work_item_revision", entityId: pbi.id, key: pbi.key, revisionNumber: null, mode: "pinned", uri: null },
      content: { id: baseline.id, sequence: baseline.sequence, kind: baseline.kind, reason: baseline.reason, createdAt: baseline.createdAt },
    });
  }

  const selected = entries
    .filter((entry) => requested.has(entry.section))
    .map((entry) => compactLargeEntry(entry, maxChars, warnings));
  const outputWarnings = boundWarnings(warnings);
  const watermark = readWatermark(database, input.projectId);
  const cursor = input.cursor === undefined ? undefined : decodeContextCursor(input.cursor);
  if (cursor !== undefined) {
    assertCursorMatches(cursor, {
      projectId: input.projectId,
      principalId: input.principalId,
      taskId: task.id,
      profile,
      include,
      maxChars,
      watermark,
    });
  }
  const offset = cursor?.offset ?? 0;
  if (offset > selected.length) {
    throw new ApplicationError("VALIDATION_FAILED", "The context cursor offset is invalid.");
  }

  const sections = emptySections();
  let nextOffset = offset;
  for (; nextOffset < selected.length; nextOffset += 1) {
    const entry = selected[nextOffset]!;
    sections[entry.section].push(entry);
    const candidateHasMore = nextOffset + 1 < selected.length;
    const candidateCursor = candidateHasMore
      ? encodeContextCursor({
        version: 1,
        projectId: input.projectId,
        principalId: input.principalId,
        taskId: task.id,
        profile,
        include,
        maxChars,
        watermark,
        offset: nextOffset + 1,
      })
      : null;
    const candidate = createResult(task, profile, mode, baseline, sections, outputWarnings, candidateHasMore, candidateCursor);
    if (JSON.stringify(candidate).length > maxChars) {
      sections[entry.section].pop();
      break;
    }
  }
  const hasMore = nextOffset < selected.length;
  if (hasMore && nextOffset === offset && selected[nextOffset] !== undefined) {
    throw new ApplicationError("VALIDATION_FAILED", "A context entry exceeds the character budget after summarization.");
  }
  const nextCursor = hasMore
    ? encodeContextCursor({
      version: 1,
      projectId: input.projectId,
      principalId: input.principalId,
      taskId: task.id,
      profile,
      include,
      maxChars,
      watermark,
      offset: nextOffset,
    })
    : null;
  return createResult(task, profile, mode, baseline, sections, outputWarnings, hasMore, nextCursor);
}

export function readWorkItemRevisionResource(
  database: SqliteDatabase,
  projectId: string,
  principalId: string,
  itemIdOrKey: string,
  revisionNumber: number,
): WorkItemContentRevision {
  const revisions = listWorkItemRevisions(database, projectId, principalId, itemIdOrKey);
  const revision = revisions.find((item) => item.revisionNumber === revisionNumber);
  if (revision === undefined || revision.status === "draft") {
    throw new ApplicationError("NOT_FOUND", "Published work item revision was not found.");
  }
  return revision;
}

export function readTestRunResource(
  database: SqliteDatabase,
  projectId: string,
  principalId: string,
  runId: string,
): {
  readonly id: string;
  readonly scenarioId: string;
  readonly revisionNumber: number;
  readonly buildId: string;
  readonly result: string;
  readonly notes: string | null;
  readonly evidenceUri: string | null;
  readonly executedByPrincipalId: string;
  readonly executedAt: string;
} {
  assertProjectAuthorization(database, projectId, principalId);
  const row = database.prepare(
    `SELECT run_id, scenario_id, revision_number, build_id, result, notes, evidence_uri,
            executed_by_principal_id, executed_at
     FROM test_runs WHERE project_id = ? AND run_id = ?`,
  ).get(projectId, runId) as {
    run_id: string;
    scenario_id: string;
    revision_number: number;
    build_id: string;
    result: string;
    notes: string | null;
    evidence_uri: string | null;
    executed_by_principal_id: string;
    executed_at: string;
  } | undefined;
  if (row === undefined) throw new ApplicationError("NOT_FOUND", "Test run was not found.");
  return {
    id: row.run_id,
    scenarioId: row.scenario_id,
    revisionNumber: row.revision_number,
    buildId: row.build_id,
    result: row.result,
    notes: row.notes,
    evidenceUri: row.evidence_uri,
    executedByPrincipalId: row.executed_by_principal_id,
    executedAt: row.executed_at,
  };
}

function resolveHierarchy(
  database: SqliteDatabase,
  projectId: string,
  principalId: string,
  task: WorkItem,
): WorkItem[] {
  const result = [task];
  let current = task;
  while (current.parentId !== null && result.length < 5) {
    current = getWorkItem(database, projectId, principalId, current.parentId);
    result.push(current);
  }
  return result.reverse();
}

function appendHierarchy(
  entries: TaskContextEntry[],
  hierarchy: readonly WorkItem[],
  projectId: string,
  pbi: WorkItem,
  baseline: WorkBaseline | undefined,
): void {
  for (const item of hierarchy) {
    const pinnedRevision = item.id === pbi.id
      ? baseline?.references.find((ref) => ref.entityType === "work_item_revision" && ref.entityId === item.id)?.revisionNumber
      : undefined;
    const revisionNumber = pinnedRevision ?? item.revision;
    const revisions = listWorkItemRevisionsForContext(item, baseline, pinnedRevision);
    const snapshot = revisions?.snapshot;
    entries.push({
      section: "hierarchy",
      key: item.key,
      title: snapshot?.title ?? item.title,
      source: workItemSource(projectId, item, revisionNumber, pinnedRevision === undefined ? "current" : "pinned"),
      content: {
        type: snapshot?.type ?? item.type,
        state: item.state,
        description: snapshot?.description ?? item.description,
        parentId: item.parentId,
      },
    });
  }
}

function listWorkItemRevisionsForContext(
  item: WorkItem,
  baseline: WorkBaseline | undefined,
  pinnedRevision: number | undefined,
): WorkItemContentRevision | undefined {
  if (pinnedRevision !== undefined) {
    const reference = baseline?.references.find((ref) => ref.entityType === "work_item_revision" && ref.entityId === item.id);
    if (reference !== undefined) {
      return {
        id: `${item.id}:revision:${pinnedRevision}`,
        projectId: item.projectId,
        itemId: item.id,
        revisionNumber: pinnedRevision,
        status: "published",
        snapshot: reference.snapshot as WorkItemContentRevision["snapshot"],
        createdByPrincipalId: item.createdByPrincipalId,
        createdAt: item.createdAt,
        publishedByPrincipalId: null,
        publishedAt: null,
      };
    }
  }
  return undefined;
}

function resolveCriteria(
  database: SqliteDatabase,
  projectId: string,
  principalId: string,
  pbi: WorkItem,
  baseline: WorkBaseline | undefined,
): readonly AcceptanceCriterion[] {
  const reference = baseline?.references.find((item) => item.entityType === "work_item_revision" && item.entityId === pbi.id);
  if (reference !== undefined) {
    const snapshot = reference.snapshot as WorkItemContentRevision["snapshot"];
    return snapshot.criteria;
  }
  return getWorkItem(database, projectId, principalId, pbi.id).criteria;
}

function findLatestBaseline(database: SqliteDatabase, projectId: string, itemId: string): boolean {
  return database.prepare(
    "SELECT 1 FROM work_baselines WHERE project_id = ? AND item_id = ? LIMIT 1",
  ).get(projectId, itemId) !== undefined;
}

function findLinkedSpecifications(
  database: SqliteDatabase,
  projectId: string,
  itemIds: readonly string[],
): SpecificationReferenceRow[] {
  const placeholders = itemIds.map(() => "?").join(", ");
  return database.prepare(
    `SELECT DISTINCT s.spec_id, s.spec_key, s.kind
     FROM trace_links l
     INNER JOIN specifications s ON s.project_id = l.project_id AND s.spec_id = l.target_id
     WHERE l.project_id = ? AND l.link_type = 'implements' AND l.removed_at IS NULL
       AND l.source_id IN (${placeholders})
     ORDER BY s.spec_key COLLATE NOCASE`,
  ).all(projectId, ...itemIds) as SpecificationReferenceRow[];
}

interface ResolvedSpecification {
  readonly id: string;
  readonly key: string;
  readonly kind: SpecificationKind;
  readonly title: string;
  readonly revisionNumber: number;
  readonly currentRevision: number;
  readonly content: unknown;
  readonly mode: "pinned" | "current";
}

function resolveSpecifications(
  database: SqliteDatabase,
  projectId: string,
  principalId: string,
  linked: readonly SpecificationReferenceRow[],
  baseline: WorkBaseline | undefined,
  warnings: TaskContextWarning[],
  requested: ReadonlySet<TaskContextSection>,
): ResolvedSpecification[] {
  const references = baseline?.references.filter((item) => item.entityType === "specification_revision") ?? [];
  if (baseline !== undefined) {
    const pinnedIds = new Set(references.map((reference) => reference.entityId));
    for (const spec of linked) {
      if (!pinnedIds.has(spec.spec_id)) {
        const section = spec.kind === "business_rule" ? "businessRules" : "technicalDecisions";
        if (requested.has(section)) {
          warnings.push({
            code: "SPEC_LINK_AFTER_BASELINE",
            message: "An active specification link is not part of the pinned baseline.",
            key: spec.spec_key,
          });
        }
      }
    }
  }
  const candidates = baseline === undefined
    ? linked.map((spec) => ({ entityId: spec.spec_id, revisionNumber: undefined as number | undefined }))
    : references.map((ref) => ({ entityId: ref.entityId, revisionNumber: ref.revisionNumber }));
  const resolved: ResolvedSpecification[] = [];
  for (const candidate of candidates) {
    const spec = getSpecification(database, projectId, principalId, candidate.entityId);
    if (spec.kind === "glossary") continue;
    const section = spec.kind === "business_rule" ? "businessRules" : "technicalDecisions";
    const isVisible = requested.has(section);
    const revisionNumber = candidate.revisionNumber ?? spec.publishedRevision;
    if (revisionNumber === null || revisionNumber === undefined) {
      if (isVisible) warnings.push({ code: "SPEC_WITHOUT_PUBLICATION", message: "A linked specification has no published revision.", key: spec.key });
      continue;
    }
    const revision = spec.revisions.find((entry) => entry.revisionNumber === revisionNumber);
    if (revision === undefined) {
      if (isVisible) warnings.push({ code: "BASELINE_REFERENCE_MISSING", message: "The pinned specification revision is unavailable.", key: spec.key });
      continue;
    }
    resolved.push({
      id: spec.id,
      key: spec.key,
      kind: spec.kind,
      title: spec.title,
      revisionNumber,
      currentRevision: spec.publishedRevision ?? revisionNumber,
      content: revision.content,
      mode: candidate.revisionNumber === undefined ? "current" : "pinned",
    });
  }
  return resolved;
}

interface ResolvedScenario {
  readonly id: string;
  readonly key: string;
  readonly revisionNumber: number;
  readonly snapshot: ScenarioSnapshot;
  readonly mode: "pinned" | "current";
}

function resolveScenarios(
  database: SqliteDatabase,
  projectId: string,
  principalId: string,
  criteria: readonly AcceptanceCriterion[],
  specifications: readonly ResolvedSpecification[],
  baseline: WorkBaseline | undefined,
): ResolvedScenario[] {
  const refs = baseline?.references.filter((reference) => reference.entityType === "scenario_revision") ?? [];
  const rows = baseline === undefined
    ? findCurrentScenarios(database, projectId, criteria.map((criterion) => criterion.id), specifications.map((spec) => spec.id))
    : refs.map((reference) => {
      const scenario = getScenario(database, projectId, principalId, reference.entityId);
      const revision = scenario.revisions.find((item) => item.revisionNumber === reference.revisionNumber);
      return revision === undefined ? undefined : {
        scenario_id: scenario.id,
        scenario_key: scenario.key,
        revision_number: revision.revisionNumber,
        snapshot_json: JSON.stringify(revision.snapshot),
      };
    }).filter((item): item is ScenarioReferenceRow => item !== undefined);
  return rows.map((row) => ({
    id: row.scenario_id,
    key: row.scenario_key,
    revisionNumber: row.revision_number,
    snapshot: JSON.parse(row.snapshot_json) as ScenarioSnapshot,
    mode: baseline === undefined ? "current" : "pinned",
  }));
}

function findCurrentScenarios(
  database: SqliteDatabase,
  projectId: string,
  criterionIds: readonly string[],
  specificationIds: readonly string[],
): ScenarioReferenceRow[] {
  const targets: Array<{ type: "criterion" | "specification"; id: string }> = [
    ...criterionIds.map((id) => ({ type: "criterion" as const, id })),
    ...specificationIds.map((id) => ({ type: "specification" as const, id })),
  ];
  if (targets.length === 0) return [];
  const match = targets.map(() => "(c.target_type = ? AND c.target_id = ?)").join(" OR ");
  const params = targets.flatMap(({ type, id }) => [type, id]);
  return database.prepare(
    `SELECT DISTINCT s.scenario_id, s.scenario_key, r.revision_number, r.snapshot_json
     FROM scenario_revision_coverage c
     INNER JOIN scenarios s ON s.project_id = c.project_id AND s.scenario_id = c.scenario_id
     INNER JOIN scenario_revisions r ON r.project_id = c.project_id AND r.scenario_id = c.scenario_id
       AND r.revision_number = c.revision_number AND r.status = 'published'
     WHERE c.project_id = ? AND (${match})
     ORDER BY s.scenario_key COLLATE NOCASE`,
  ).all(projectId, ...params) as ScenarioReferenceRow[];
}

interface ResolvedRun {
  readonly runId: string;
  readonly scenarioKey: string;
  readonly revisionNumber: number;
  readonly buildId: string;
  readonly result: string;
  readonly notes: string | null;
  readonly evidenceUri: string | null;
  readonly executedAt: string;
  readonly mode: "pinned" | "current";
}

function resolveTestRuns(
  database: SqliteDatabase,
  projectId: string,
  scenarios: readonly ResolvedScenario[],
): ResolvedRun[] {
  if (scenarios.length === 0) return [];
  const tuples = scenarios.map(() => "(tr.scenario_id = ? AND tr.revision_number = ?)").join(" OR ");
  const parameters = scenarios.flatMap((scenario) => [scenario.id, scenario.revisionNumber]);
  return database.prepare(
    `WITH matching_runs AS (
       SELECT tr.*, s.scenario_key,
         ROW_NUMBER() OVER (PARTITION BY tr.scenario_id, tr.revision_number, tr.build_id ORDER BY tr.sequence DESC) AS run_rank
       FROM test_runs tr INNER JOIN scenarios s
         ON s.project_id = tr.project_id AND s.scenario_id = tr.scenario_id
       WHERE tr.project_id = ? AND (${tuples})
     )
     SELECT run_id, scenario_id, scenario_key, revision_number, build_id, result, notes, evidence_uri, executed_at
     FROM matching_runs WHERE run_rank = 1 ORDER BY scenario_key COLLATE NOCASE, build_id`,
  ).all(projectId, ...parameters).map((value) => {
    const row = value as {
      run_id: string; scenario_id: string; scenario_key: string; revision_number: number; build_id: string;
      result: string; notes: string | null; evidence_uri: string | null; executed_at: string;
    };
    const scenario = scenarios.find((item) => item.id === row.scenario_id && item.revisionNumber === row.revision_number)!;
    return {
      runId: row.run_id,
      scenarioKey: row.scenario_key,
      revisionNumber: row.revision_number,
      buildId: row.build_id,
      result: row.result,
      notes: row.notes,
      evidenceUri: row.evidence_uri,
      executedAt: row.executed_at,
      mode: scenario.mode,
    } satisfies ResolvedRun;
  });
}

function compactLargeEntry(entry: TaskContextEntry, maxChars: number, warnings: TaskContextWarning[]): TaskContextEntry {
  const contentBudget = Math.max(200, Math.min(4_000, Math.floor(maxChars / 3)));
  if (JSON.stringify(entry.content).length <= contentBudget || entry.source.uri === null) return entry;
  warnings.push({ code: "ENTRY_MOVED_TO_RESOURCE", message: "Large content is available through its revision resource.", key: entry.key });
  return { ...entry, content: { summary: entry.title, resourceUri: entry.source.uri } };
}

function boundWarnings(warnings: readonly TaskContextWarning[]): TaskContextWarning[] {
  const maximum = 4;
  if (warnings.length <= maximum) return [...warnings];
  return [
    ...warnings.slice(0, maximum - 1),
    { code: "MORE_WARNINGS", message: `${warnings.length - maximum + 1} additional context warnings were omitted.` },
  ];
}

function createResult(
  task: WorkItem,
  profile: TaskContextProfile,
  mode: "pinned" | "preview",
  baseline: WorkBaseline | undefined,
  sections: Record<TaskContextSection, TaskContextEntry[]>,
  warnings: readonly TaskContextWarning[],
  truncated: boolean,
  nextCursor: string | null,
): TaskContextResult {
  return {
    task: { id: task.id, key: task.key, title: task.title, state: task.state, version: task.version, parentId: task.parentId },
    profile,
    mode,
    baseline: baseline === undefined ? null : { id: baseline.id, sequence: baseline.sequence, kind: baseline.kind },
    sections,
    warnings,
    truncated,
    nextCursor,
  };
}

function emptySections(): Record<TaskContextSection, TaskContextEntry[]> {
  return {
    hierarchy: [], acceptanceCriteria: [], businessRules: [], technicalDecisions: [], scenarios: [], testRuns: [], baseline: [],
  };
}

function normalizeSections(sections: readonly TaskContextSection[]): TaskContextSection[] {
  const normalized = [...new Set(sections)];
  if (normalized.some((section) => !taskContextSections.includes(section))) {
    throw new ApplicationError("VALIDATION_FAILED", "One or more task context sections are invalid.");
  }
  return sectionOrder.filter((section) => normalized.includes(section));
}

function workItemSource(
  projectId: string,
  item: WorkItem,
  revisionNumber: number,
  mode: "pinned" | "current",
): TaskContextSource {
  return {
    entityType: "work_item_revision",
    entityId: item.id,
    key: item.key,
    revisionNumber,
    mode,
    uri: `ssdd://projects/${encodeURIComponent(projectId)}/work-items/${encodeURIComponent(item.key)}/revisions/${revisionNumber}`,
  };
}

function specificationUri(projectId: string, key: string, revisionNumber: number): string {
  return `ssdd://projects/${encodeURIComponent(projectId)}/specs/${encodeURIComponent(key)}/revisions/${revisionNumber}`;
}

function scenarioUri(projectId: string, key: string, revisionNumber: number): string {
  return `ssdd://projects/${encodeURIComponent(projectId)}/scenarios/${encodeURIComponent(key)}/revisions/${revisionNumber}`;
}

function readWatermark(database: SqliteDatabase, projectId: string): number {
  const row = database.prepare(
    "SELECT COALESCE(MAX(sequence), 0) AS watermark FROM audit_events WHERE project_id = ?",
  ).get(projectId) as { watermark: number };
  return row.watermark;
}

function encodeContextCursor(cursor: ContextCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeContextCursor(value: string): ContextCursor {
  if (value.length > 4_096 || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new ApplicationError("VALIDATION_FAILED", "The task context cursor is invalid.");
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (parsed === null || typeof parsed !== "object") throw new Error("Invalid cursor shape");
    const cursor = parsed as Record<string, unknown>;
    if (
      cursor.version !== 1 || typeof cursor.projectId !== "string" || typeof cursor.principalId !== "string" ||
      typeof cursor.taskId !== "string" || !taskContextProfiles.includes(cursor.profile as TaskContextProfile) ||
      !Array.isArray(cursor.include) || cursor.include.some((section) => !taskContextSections.includes(section as TaskContextSection)) ||
      typeof cursor.maxChars !== "number" || !Number.isSafeInteger(cursor.maxChars) ||
      typeof cursor.watermark !== "number" || !Number.isSafeInteger(cursor.watermark) ||
      typeof cursor.offset !== "number" || !Number.isSafeInteger(cursor.offset) || cursor.offset < 0
    ) throw new Error("Invalid cursor fields");
    return cursor as unknown as ContextCursor;
  } catch {
    throw new ApplicationError("VALIDATION_FAILED", "The task context cursor is invalid.");
  }
}

function assertCursorMatches(
  cursor: ContextCursor,
  expected: Omit<ContextCursor, "version" | "offset">,
): void {
  if (
    cursor.projectId !== expected.projectId || cursor.principalId !== expected.principalId || cursor.taskId !== expected.taskId ||
    cursor.profile !== expected.profile || cursor.maxChars !== expected.maxChars || JSON.stringify(cursor.include) !== JSON.stringify(expected.include)
  ) {
    throw new ApplicationError("VALIDATION_FAILED", "The cursor belongs to another task, principal or filter set.");
  }
  if (cursor.watermark !== expected.watermark) {
    throw new ApplicationError("STALE_CURSOR", "The project changed after this context page was read. Restart without a cursor.");
  }
}

