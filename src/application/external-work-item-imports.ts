import { createHash, randomUUID } from "node:crypto";
import type { WorkItemType } from "../domain/work-items.js";
import type { SqliteDatabase } from "../storage-sqlite/database.js";
import { createWorkItem } from "./create-work-item.js";
import { ApplicationError } from "./errors.js";
import { assertProjectAuthorization } from "./local-identity.js";
import { getWorkItem } from "./work-item-queries.js";

export type ExternalWorkItemProvider = "github" | "azure-devops";
export type ImportedWorkItemType = Extract<WorkItemType, "story" | "bug">;

export interface ExternalWorkItemSource {
  readonly externalId: string;
  readonly number: number;
  readonly title: string;
  readonly body: string | null;
  readonly state: string;
  readonly url: string;
  readonly labels: readonly string[];
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly sourceType?: string | null;
}

export interface ExternalWorkItemImportInput {
  readonly projectId: string;
  readonly principalId: string;
  readonly provider: ExternalWorkItemProvider;
  readonly externalScope: string;
  readonly parentFeatureIdOrKey: string;
  readonly workItemType: ImportedWorkItemType;
  readonly externalWorkItemType?: "User Story" | "Bug";
  readonly sources: readonly ExternalWorkItemSource[];
}

export interface ExternalWorkItemImportPreview {
  readonly planHash: string;
  readonly provider: ExternalWorkItemProvider;
  readonly externalScope: string;
  readonly parentFeatureId: string;
  readonly workItemType: ImportedWorkItemType;
  readonly externalWorkItemType: "User Story" | "Bug" | null;
  readonly total: number;
  readonly toCreate: number;
  readonly alreadyImported: number;
  readonly sourceChanged: number;
  readonly skipped: number;
  readonly items: readonly ExternalWorkItemImportPreviewItem[];
}

export interface ExternalWorkItemImportPreviewItem {
  readonly externalId: string;
  readonly number: number;
  readonly sourceType: string | null;
  readonly title: string;
  readonly state: string;
  readonly action: "create" | "already_imported" | "linked_elsewhere" | "skipped";
  readonly reason: string | null;
  readonly workItemId: string | null;
  readonly workItemKey: string | null;
  readonly titleTruncated: boolean;
  readonly descriptionTruncated: boolean;
  readonly sourceChanged: boolean;
}

export interface ExternalWorkItemImportResult {
  readonly imported: readonly { readonly externalId: string; readonly workItemId: string; readonly workItemKey: string }[];
  readonly alreadyImported: number;
  readonly sourceSnapshotsAdded: number;
  readonly skipped: number;
  readonly planHash: string;
}

interface ExternalLinkRow {
  readonly external_link_id: string;
  readonly project_id: string;
  readonly work_item_id: string;
  readonly work_item_type: ImportedWorkItemType;
  readonly source_sha256: string | null;
}

interface NormalizedSource {
  readonly source: ExternalWorkItemSource;
  readonly canonicalJson: string;
  readonly sourceSha256: string;
  readonly title: string;
  readonly description: string | undefined;
  readonly titleTruncated: boolean;
  readonly descriptionTruncated: boolean;
}

interface PlannedSource extends NormalizedSource {
  readonly action: ExternalWorkItemImportPreviewItem["action"];
  readonly reason: string | null;
  readonly existingLink: ExternalLinkRow | undefined;
  readonly sourceChanged: boolean;
}

export function assertExternalWorkItemImportApplyAuthorization(
  database: SqliteDatabase,
  projectId: string,
  principalId: string,
): void {
  requireHumanProductOwner(database, projectId, principalId);
}

export function previewExternalWorkItemImport(
  database: SqliteDatabase,
  input: ExternalWorkItemImportInput,
): ExternalWorkItemImportPreview {
  assertProjectAuthorization(database, input.projectId, input.principalId);
  return buildPlan(database, input).preview;
}

export function applyExternalWorkItemImport(
  database: SqliteDatabase,
  input: ExternalWorkItemImportInput & { readonly expectedPlanHash: string; readonly requestId: string },
): ExternalWorkItemImportResult {
  requireHumanProductOwner(database, input.projectId, input.principalId);
  validateRequestId(input.requestId);
  if (!/^[a-f0-9]{64}$/u.test(input.expectedPlanHash)) {
    throw new ApplicationError("VALIDATION_FAILED", "The expected preview hash is invalid.");
  }

  const execute = database.transaction(() => {
    const requestId = input.requestId.trim();
    const previousRun = database.prepare(
      `SELECT plan_sha256, result_json FROM external_work_item_import_runs
       WHERE project_id = ? AND provider = ? AND request_id = ?`,
    ).get(input.projectId, input.provider, requestId) as { plan_sha256: string; result_json: string } | undefined;
    if (previousRun !== undefined) {
      if (previousRun.plan_sha256 !== input.expectedPlanHash) {
        throw new ApplicationError("IDEMPOTENCY_CONFLICT", "Import request ID was already used with a different plan.");
      }
      return JSON.parse(previousRun.result_json) as ExternalWorkItemImportResult;
    }
    const { preview, sources } = buildPlan(database, input);
    if (preview.planHash !== input.expectedPlanHash) {
      throw new ApplicationError("IMPORT_PREVIEW_STALE", "External data or import mappings changed after preview; create a new preview.");
    }
    const imported: Array<{ externalId: string; workItemId: string; workItemKey: string }> = [];
    let alreadyImported = 0;
    let sourceSnapshotsAdded = 0;
    let skipped = 0;

    for (const planned of sources) {
      if (planned.action === "skipped" || planned.action === "linked_elsewhere") {
        skipped += 1;
        continue;
      }
      if (planned.action === "already_imported") {
        alreadyImported += 1;
        if (planned.sourceChanged && planned.existingLink !== undefined) {
          const inserted = insertSourceSnapshot(database, {
            externalLinkId: planned.existingLink.external_link_id,
            projectId: input.projectId,
            sourceSha256: planned.sourceSha256,
            sourceJson: planned.canonicalJson,
            observedAt: new Date().toISOString(),
          });
          if (inserted) {
            sourceSnapshotsAdded += 1;
            recordImportAudit(database, input, requestId, planned.existingLink.work_item_id, "external_work_item.source_observed", {
              provider: input.provider,
              externalScope: normalizeScope(input.externalScope),
              externalId: planned.source.externalId,
              sourceSha256: planned.sourceSha256,
            });
          }
        }
        continue;
      }

      const item = createWorkItem(database, {
        projectId: input.projectId,
        principalId: input.principalId,
        requestId: createItemRequestId(input.provider, input.externalScope, planned.source.externalId),
        type: input.workItemType,
        parentId: preview.parentFeatureId,
        title: planned.title,
        ...(planned.description === undefined ? {} : { description: planned.description }),
      }).value;
      const externalLinkId = randomUUID();
      const linkedAt = new Date().toISOString();
      database.prepare(
        `INSERT INTO external_work_item_links
          (external_link_id, project_id, provider, external_scope, external_id, source_url,
           work_item_id, work_item_type, linked_by_principal_id, linked_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        externalLinkId,
        input.projectId,
        input.provider,
        normalizeScope(input.externalScope),
        planned.source.externalId,
        planned.source.url,
        item.id,
        input.workItemType,
        input.principalId,
        linkedAt,
      );
      insertSourceSnapshot(database, {
        externalLinkId,
        projectId: input.projectId,
        sourceSha256: planned.sourceSha256,
        sourceJson: planned.canonicalJson,
        observedAt: linkedAt,
      });
      recordImportAudit(database, input, requestId, item.id, "external_work_item.imported", {
        provider: input.provider,
        externalScope: normalizeScope(input.externalScope),
        externalId: planned.source.externalId,
        workItemId: item.id,
        workItemKey: item.key,
        sourceSha256: planned.sourceSha256,
      });
      imported.push({ externalId: planned.source.externalId, workItemId: item.id, workItemKey: item.key });
    }

    const result: ExternalWorkItemImportResult = {
      imported,
      alreadyImported,
      sourceSnapshotsAdded,
      skipped,
      planHash: preview.planHash,
    };
    database.prepare(
      `INSERT INTO external_work_item_import_runs
        (project_id, provider, request_id, plan_sha256, principal_id, result_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.projectId,
      input.provider,
      requestId,
      preview.planHash,
      input.principalId,
      JSON.stringify(result),
      new Date().toISOString(),
    );
    return result;
  });

  return execute.immediate();
}

function buildPlan(
  database: SqliteDatabase,
  input: ExternalWorkItemImportInput,
): { readonly preview: ExternalWorkItemImportPreview; readonly sources: readonly PlannedSource[] } {
  validateInput(input);
  const parent = getWorkItem(database, input.projectId, input.principalId, input.parentFeatureIdOrKey.trim());
  if (parent.type !== "feature") {
    throw new ApplicationError("VALIDATION_FAILED", "External stories and bugs must be imported under a feature.");
  }
  const normalizedScope = normalizeScope(input.externalScope);
  const seen = new Set<string>();
  const sources = input.sources.map((source) => {
    const normalized = normalizeSource(input.provider, source);
    const duplicate = seen.has(normalized.source.externalId);
    seen.add(normalized.source.externalId);
    const sourceTypeMismatch = input.provider === "azure-devops" && normalized.source.sourceType !== input.externalWorkItemType;
    const existingLink = database.prepare(
      `SELECT link.external_link_id, link.project_id, link.work_item_id, link.work_item_type,
              snapshot.source_sha256
       FROM external_work_item_links AS link
       LEFT JOIN external_work_item_snapshots AS snapshot
         ON snapshot.external_link_id = link.external_link_id
        AND snapshot.sequence = (SELECT MAX(latest.sequence) FROM external_work_item_snapshots AS latest
                                 WHERE latest.external_link_id = link.external_link_id)
       WHERE link.provider = ? AND link.external_scope = ? AND link.external_id = ?`,
    ).get(input.provider, normalizedScope, normalized.source.externalId) as ExternalLinkRow | undefined;
    const action: ExternalWorkItemImportPreviewItem["action"] = duplicate ? "skipped"
      : sourceTypeMismatch ? "skipped"
      : normalized.source.title.trim().length === 0 ? "skipped"
        : normalized.source.body !== null && normalized.source.body.length > 100_000 ? "skipped"
          : existingLink === undefined ? "create"
            : existingLink.project_id === input.projectId ? "already_imported"
              : "linked_elsewhere";
    const reason: string | null = duplicate ? "duplicate_external_id"
      : sourceTypeMismatch ? normalized.source.sourceType === null || normalized.source.sourceType === undefined
        ? "source_type_missing"
        : normalized.source.sourceType === "User Story" || normalized.source.sourceType === "Bug"
          ? "source_type_not_selected"
          : "source_type_unmapped"
      : normalized.source.title.trim().length === 0 ? "empty_title"
        : normalized.source.body !== null && normalized.source.body.length > 100_000 ? "description_too_large"
          : action === "linked_elsewhere" ? "linked_to_another_project"
            : null;
    return {
      ...normalized,
      action,
      reason,
      existingLink,
      sourceChanged: action === "already_imported" && existingLink?.source_sha256 !== normalized.sourceSha256,
    };
  });
  const planItems = sources.map((source) => ({
    externalId: source.source.externalId,
    sourceSha256: source.sourceSha256,
    action: source.action,
    reason: source.reason,
    sourceChanged: source.sourceChanged,
  })).sort((left, right) => left.externalId.localeCompare(right.externalId) || left.sourceSha256.localeCompare(right.sourceSha256));
  const planHash = createHash("sha256").update(JSON.stringify({
    projectId: input.projectId,
    provider: input.provider,
    externalScope: normalizedScope,
    parentFeatureId: parent.id,
    workItemType: input.workItemType,
    externalWorkItemType: input.externalWorkItemType ?? null,
    items: planItems,
  })).digest("hex");
  const preview: ExternalWorkItemImportPreview = {
    planHash,
    provider: input.provider,
    externalScope: normalizedScope,
    parentFeatureId: parent.id,
    workItemType: input.workItemType,
    externalWorkItemType: input.externalWorkItemType ?? null,
    total: sources.length,
    toCreate: sources.filter(({ action }) => action === "create").length,
    alreadyImported: sources.filter(({ action }) => action === "already_imported").length,
    sourceChanged: sources.filter(({ sourceChanged }) => sourceChanged).length,
    skipped: sources.filter(({ action }) => action === "skipped" || action === "linked_elsewhere").length,
    items: sources.map((source) => ({
      externalId: source.source.externalId,
      number: source.source.number,
      sourceType: source.source.sourceType ?? null,
      title: source.source.title,
      state: source.source.state,
      action: source.action,
      reason: source.reason,
      workItemId: source.action === "already_imported" ? source.existingLink?.work_item_id ?? null : null,
      workItemKey: source.action === "already_imported" && source.existingLink !== undefined
        ? readWorkItemKey(database, input.projectId, source.existingLink.work_item_id)
        : null,
      titleTruncated: source.titleTruncated,
      descriptionTruncated: source.descriptionTruncated,
      sourceChanged: source.sourceChanged,
    })),
  };
  return { preview, sources };
}

function normalizeSource(provider: ExternalWorkItemProvider, source: ExternalWorkItemSource): NormalizedSource {
  if (!/^[A-Za-z0-9._:-]{1,64}$/u.test(source.externalId)) {
    throw new ApplicationError("VALIDATION_FAILED", "External work item ID is invalid.");
  }
  if (!Number.isSafeInteger(source.number) || source.number < 1) {
    throw new ApplicationError("VALIDATION_FAILED", "External work item number is invalid.");
  }
  if (typeof source.title !== "string" || source.title.length > 1_000) {
    throw new ApplicationError("VALIDATION_FAILED", "External work item title is invalid.");
  }
  if (source.body !== null && (typeof source.body !== "string" || source.body.length > 1_048_576)) {
    throw new ApplicationError("VALIDATION_FAILED", "External work item description is invalid.");
  }
  if (source.sourceType !== undefined && source.sourceType !== null && (typeof source.sourceType !== "string" || source.sourceType.length > 100)) {
    throw new ApplicationError("VALIDATION_FAILED", "External work item source type is invalid.");
  }
  if (!isTrustedSourceUrl(provider, source.url)) {
    throw new ApplicationError("VALIDATION_FAILED", "External work item URL is invalid.");
  }
  if (!Array.isArray(source.labels) || source.labels.length > 100 || source.labels.some((label) => typeof label !== "string" || label.length > 100)) {
    throw new ApplicationError("VALIDATION_FAILED", "External work item labels are invalid.");
  }
  if (typeof source.state !== "string" || source.state.length > 60 || source.state.trim().length === 0) {
    throw new ApplicationError("VALIDATION_FAILED", "External work item state is invalid.");
  }
  if (!isIsoDate(source.createdAt) || !isIsoDate(source.updatedAt)) {
    throw new ApplicationError("VALIDATION_FAILED", "External work item timestamps are invalid.");
  }
  const canonicalJson = JSON.stringify({
    provider,
    externalId: source.externalId,
    number: source.number,
    title: source.title,
    body: source.body,
    state: source.state,
    url: source.url,
    labels: [...source.labels],
    createdAt: source.createdAt,
    updatedAt: source.updatedAt,
    sourceType: source.sourceType ?? null,
  });
  const trimmedTitle = source.title.trim();
  const title = trimmedTitle.slice(0, 200).trimEnd();
  const normalizedBody = source.body?.trim() ?? "";
  return {
    source,
    canonicalJson,
    sourceSha256: createHash("sha256").update(canonicalJson).digest("hex"),
    title,
    description: normalizedBody.length === 0 ? undefined : normalizedBody.slice(0, 10_000),
    titleTruncated: trimmedTitle.length > 200,
    descriptionTruncated: normalizedBody.length > 10_000,
  };
}

function validateInput(input: ExternalWorkItemImportInput): void {
  if (!/^[0-9a-f-]{36}$/iu.test(input.projectId) || !/^[0-9a-f-]{36}$/iu.test(input.principalId)) {
    throw new ApplicationError("VALIDATION_FAILED", "Project or principal identifier is invalid.");
  }
  if (input.provider !== "github" && input.provider !== "azure-devops") {
    throw new ApplicationError("VALIDATION_FAILED", "External import provider is invalid.");
  }
  if (typeof input.externalScope !== "string") {
    throw new ApplicationError("VALIDATION_FAILED", "External import scope is invalid.");
  }
  const scopeParts = input.externalScope.split("/");
  const validScope = input.provider === "github"
    ? scopeParts.length === 2 && /^[A-Za-z0-9_.-]{1,120}$/u.test(scopeParts[0]!) && /^[A-Za-z0-9_. -]{1,120}$/u.test(scopeParts[1]!)
    : scopeParts.length === 2 && /^[A-Za-z0-9][A-Za-z0-9-]{0,49}$/u.test(scopeParts[0]!) &&
      scopeParts[1]!.trim().length > 0 && scopeParts[1]!.length <= 120 && scopeParts[1] === scopeParts[1]!.trim() &&
      scopeParts[1] !== "." && scopeParts[1] !== ".." && ![...scopeParts[1]!].some((character) => {
        const code = character.charCodeAt(0);
        return code <= 0x1f || code === 0x7f || "?#".includes(character);
      });
  if (!validScope) {
    throw new ApplicationError("VALIDATION_FAILED", "External import scope is invalid.");
  }
  if (input.workItemType !== "story" && input.workItemType !== "bug") {
    throw new ApplicationError("VALIDATION_FAILED", "Imported work item type must be story or bug.");
  }
  if (
    (input.provider === "azure-devops" && input.externalWorkItemType !== "User Story" && input.externalWorkItemType !== "Bug") ||
    (input.provider === "github" && input.externalWorkItemType !== undefined)
  ) {
    throw new ApplicationError("VALIDATION_FAILED", "Azure DevOps imports require an explicit User Story or Bug source type.");
  }
  if (!Array.isArray(input.sources) || input.sources.length > 100) {
    throw new ApplicationError("VALIDATION_FAILED", "At most 100 external work items can be imported at once.");
  }
}

function requireHumanProductOwner(database: SqliteDatabase, projectId: string, principalId: string): void {
  assertProjectAuthorization(database, projectId, principalId, ["po"]);
  const principal = database.prepare(
    "SELECT principal_type FROM principals WHERE principal_id = ?",
  ).get(principalId) as { principal_type: string } | undefined;
  if (principal?.principal_type !== "human") {
    throw new ApplicationError("FORBIDDEN", "External work item imports require a human product owner.");
  }
}

function insertSourceSnapshot(
  database: SqliteDatabase,
  input: {
    readonly externalLinkId: string;
    readonly projectId: string;
    readonly sourceSha256: string;
    readonly sourceJson: string;
    readonly observedAt: string;
  },
): boolean {
  const result = database.prepare(
    `INSERT OR IGNORE INTO external_work_item_snapshots
      (snapshot_id, external_link_id, project_id, source_sha256, source_json, observed_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(randomUUID(), input.externalLinkId, input.projectId, input.sourceSha256, input.sourceJson, input.observedAt);
  return result.changes === 1;
}

function recordImportAudit(
  database: SqliteDatabase,
  input: ExternalWorkItemImportInput,
  requestId: string,
  workItemId: string,
  eventType: string,
  payload: Readonly<Record<string, unknown>>,
): void {
  database.prepare(
    `INSERT INTO audit_events
      (event_id, project_id, principal_id, event_type, entity_type, entity_id,
       correlation_id, occurred_at, payload_json)
     VALUES (?, ?, ?, ?, 'external_work_item_link', ?, ?, ?, ?)`,
  ).run(
    randomUUID(), input.projectId, input.principalId, eventType, workItemId,
    requestId, new Date().toISOString(), JSON.stringify(payload),
  );
}

function readWorkItemKey(database: SqliteDatabase, projectId: string, workItemId: string): string | null {
  const row = database.prepare(
    "SELECT item_key FROM work_items WHERE project_id = ? AND item_id = ?",
  ).get(projectId, workItemId) as { item_key: string } | undefined;
  return row?.item_key ?? null;
}

function createItemRequestId(provider: ExternalWorkItemProvider, scope: string, externalId: string): string {
  const scopeDigest = createHash("sha256").update(normalizeScope(scope)).digest("hex").slice(0, 12);
  return `import-${provider}-${scopeDigest}-${externalId}`.slice(0, 128);
}

function normalizeScope(scope: string): string {
  return scope.trim().toLowerCase();
}

function isTrustedSourceUrl(provider: ExternalWorkItemProvider, value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  if (provider === "github") return url.hostname.toLowerCase() === "github.com";
  return url.hostname.toLowerCase() === "dev.azure.com" || url.hostname.toLowerCase().endsWith(".visualstudio.com");
}

function isIsoDate(value: string): boolean {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T/u.test(value)) return false;
  return Number.isFinite(Date.parse(value));
}

function validateRequestId(value: string): void {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 128) {
    throw new ApplicationError("VALIDATION_FAILED", "Import request ID must contain 1-128 characters.");
  }
}
