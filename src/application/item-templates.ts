import type { SqliteDatabase } from "../storage-sqlite/database.js";
import { ApplicationError } from "./errors.js";
import { executeIdempotentCommand, type CommandReceipt, type JsonValue } from "./idempotent-command.js";
import { assertProjectAuthorization } from "./local-identity.js";
import { proposeTaskWorkflow } from "./task-workflow-commands.js";
import { getWorkItem } from "./work-item-queries.js";
import { proposeWorkItemRevision } from "./work-item-revisions.js";

/**
 * Versioned templates for kinds of work (SSDD-949): an exit checklist and weighted workflow steps that pre-fill a
 * task. Using one is optional and audited; applying only creates Drafts (criteria revision and workflow), which a
 * human still publishes.
 */
export interface TemplateStep { readonly title: string; readonly description: string; readonly effortPercent: number }
export interface ItemTemplate {
  readonly key: string;
  readonly revisionNumber: number;
  readonly name: string;
  readonly checklist: readonly string[];
  readonly steps: readonly TemplateStep[];
  readonly reason: string;
  readonly createdByPrincipalId: string;
  readonly createdAt: string;
}

interface TemplateRow {
  readonly template_key: string; readonly revision_number: number; readonly name: string; readonly checklist_json: string;
  readonly steps_json: string; readonly reason: string; readonly created_by_principal_id: string; readonly created_at: string;
}

const toTemplate = (row: TemplateRow): ItemTemplate => ({
  key: row.template_key, revisionNumber: row.revision_number, name: row.name, checklist: JSON.parse(row.checklist_json) as string[],
  steps: JSON.parse(row.steps_json) as TemplateStep[], reason: row.reason, createdByPrincipalId: row.created_by_principal_id, createdAt: row.created_at,
});

const columns = "template_key, revision_number, name, checklist_json, steps_json, reason, created_by_principal_id, created_at";

function latest(database: SqliteDatabase, projectId: string, key: string): ItemTemplate | null {
  const row = database.prepare(`SELECT ${columns} FROM item_template_revisions WHERE project_id = ? AND template_key = ? COLLATE NOCASE ORDER BY revision_number DESC LIMIT 1`).get(projectId, key) as TemplateRow | undefined;
  return row === undefined ? null : toTemplate(row);
}

export function listItemTemplates(database: SqliteDatabase, input: { readonly projectId: string; readonly principalId: string; readonly key?: string }): { templates: ItemTemplate[] } {
  assertProjectAuthorization(database, input.projectId, input.principalId);
  if (input.key !== undefined) {
    const rows = database.prepare(`SELECT ${columns} FROM item_template_revisions WHERE project_id = ? AND template_key = ? COLLATE NOCASE ORDER BY revision_number DESC`).all(input.projectId, input.key.trim()) as unknown as TemplateRow[];
    return { templates: rows.map(toTemplate) };
  }
  const rows = database.prepare(
    `SELECT ${columns} FROM item_template_revisions t WHERE project_id = ?
     AND revision_number = (SELECT MAX(revision_number) FROM item_template_revisions x WHERE x.project_id = t.project_id AND x.template_key = t.template_key)
     ORDER BY template_key COLLATE NOCASE`,
  ).all(input.projectId) as unknown as TemplateRow[];
  return { templates: rows.map(toTemplate) };
}

export function setItemTemplate(database: SqliteDatabase, input: {
  readonly projectId: string; readonly principalId: string; readonly requestId: string; readonly key: string; readonly name: string;
  readonly checklist: readonly string[]; readonly steps: readonly TemplateStep[]; readonly expectedRevision: number; readonly reason: string;
}): CommandReceipt<{ template: ItemTemplate }> {
  const key = input.key.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{1,59}$/u.test(key)) throw new ApplicationError("VALIDATION_FAILED", "Template key must be 2-60 lowercase letters, digits or hyphens.");
  const name = input.name.trim();
  if (name.length === 0 || name.length > 160) throw new ApplicationError("VALIDATION_FAILED", "Template name must contain 1-160 characters.");
  const reason = input.reason.trim();
  if (reason.length < 10 || reason.length > 1_000) throw new ApplicationError("VALIDATION_FAILED", "A reason of 10-1000 characters is required.");
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) throw new ApplicationError("VALIDATION_FAILED", "Expected revision must be a non-negative integer.");
  const checklist = input.checklist.map((item) => item.trim());
  if (checklist.length > 30 || checklist.some((item) => item.length === 0 || item.length > 2_000) || new Set(checklist.map((item) => item.toLowerCase())).size !== checklist.length) {
    throw new ApplicationError("VALIDATION_FAILED", "Checklist accepts at most 30 unique items of 1-2000 characters.");
  }
  const steps = input.steps.map((step) => ({ title: step.title.trim(), description: step.description.trim(), effortPercent: step.effortPercent }));
  if (steps.length > 50 || steps.some((step) => step.title.length === 0 || step.title.length > 160 || step.description.length === 0 || step.description.length > 4_000)) {
    throw new ApplicationError("VALIDATION_FAILED", "Steps accept at most 50 entries with a title (1-160) and instructions (1-4000).");
  }
  if (steps.length > 0 && Math.round(steps.reduce((sum, step) => sum + Math.round(step.effortPercent * 100), 0)) !== 10_000) {
    throw new ApplicationError("VALIDATION_FAILED", "Template step efforts must total exactly 100.00%.");
  }
  if (checklist.length === 0 && steps.length === 0) throw new ApplicationError("VALIDATION_FAILED", "A template needs a checklist, steps or both.");
  return executeIdempotentCommand(database, {
    projectId: input.projectId, principalId: input.principalId, action: "item_template.set", requestId: input.requestId,
    payload: { projectId: input.projectId, key, name, checklist, steps, expectedRevision: input.expectedRevision, reason } as unknown as JsonValue,
    requiredRoles: ["po", "tech_lead"],
    auditEvent: (result) => ({
      projectId: input.projectId, principalId: input.principalId, eventType: "item_template.set", entityType: "item_template",
      entityId: `${input.projectId}:${result.template.key}`, reason, payload: { key: result.template.key, revisionNumber: result.template.revisionNumber },
    }),
    execute: () => {
      const principal = database.prepare("SELECT principal_type FROM principals WHERE principal_id = ?").get(input.principalId) as { principal_type: string } | undefined;
      if (principal?.principal_type !== "human") throw new ApplicationError("FORBIDDEN", "Only a human PO or Tech Lead may change templates.");
      const current = latest(database, input.projectId, key);
      if ((current?.revisionNumber ?? 0) !== input.expectedRevision) {
        throw new ApplicationError("VERSION_CONFLICT", `Template is at revision ${current?.revisionNumber ?? 0}, expected ${input.expectedRevision}.`);
      }
      database.prepare(`INSERT INTO item_template_revisions (project_id, ${columns}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(input.projectId, key, input.expectedRevision + 1, name, JSON.stringify(checklist), JSON.stringify(steps), reason, input.principalId, new Date().toISOString());
      return { template: latest(database, input.projectId, key)! };
    },
  });
}

export function applyItemTemplate(database: SqliteDatabase, input: {
  readonly projectId: string; readonly principalId: string; readonly requestId: string; readonly taskIdOrKey: string; readonly templateKey: string;
}): CommandReceipt<{ taskKey: string; templateKey: string; templateRevision: number; checklistDraftRevision: number | null; workflowDraftRevision: number | null }> {
  return executeIdempotentCommand(database, {
    projectId: input.projectId, principalId: input.principalId, action: "item_template.apply", requestId: input.requestId,
    payload: { projectId: input.projectId, taskIdOrKey: input.taskIdOrKey, templateKey: input.templateKey } as unknown as JsonValue,
    requiredRoles: ["developer", "tech_lead", "po"],
    auditEvent: (result) => ({
      projectId: input.projectId, principalId: input.principalId, eventType: "item_template.applied", entityType: "work_item",
      entityId: getWorkItem(database, input.projectId, input.principalId, result.taskKey).id,
      payload: { templateKey: result.templateKey, templateRevision: result.templateRevision, checklistDraftRevision: result.checklistDraftRevision, workflowDraftRevision: result.workflowDraftRevision },
    }),
    execute: () => {
      const template = latest(database, input.projectId, input.templateKey.trim());
      if (template === null) throw new ApplicationError("NOT_FOUND", "Template was not found.");
      let task = getWorkItem(database, input.projectId, input.principalId, input.taskIdOrKey.trim());
      if (task.type !== "task") throw new ApplicationError("VALIDATION_FAILED", "Templates apply to tasks.");
      let checklistDraftRevision: number | null = null;
      if (template.checklist.length > 0) {
        const existing = task.criteria.map((criterion) => ({ id: criterion.id, description: criterion.description, required: criterion.required }));
        const known = new Set(existing.map((criterion) => criterion.description.toLowerCase()));
        const added = template.checklist.filter((item) => !known.has(item.toLowerCase())).map((description) => ({ description }));
        if (added.length > 0) {
          const proposal = proposeWorkItemRevision(database, {
            projectId: input.projectId, principalId: input.principalId, requestId: `${input.requestId}:checklist`.slice(0, 128),
            itemIdOrKey: task.id, expectedVersion: task.version, criteria: [...existing, ...added],
          });
          checklistDraftRevision = proposal.value.revisionNumber;
          task = getWorkItem(database, input.projectId, input.principalId, task.id);
        }
      }
      let workflowDraftRevision: number | null = null;
      if (template.steps.length > 0) {
        const latestWorkflow = database.prepare("SELECT MAX(revision_number) AS latest FROM task_workflow_revisions WHERE project_id = ? AND item_id = ?").get(input.projectId, task.id) as { latest: number | null };
        const proposal = proposeTaskWorkflow(database, {
          projectId: input.projectId, principalId: input.principalId, requestId: `${input.requestId}:workflow`.slice(0, 128),
          taskIdOrKey: task.id, expectedTaskVersion: task.version, expectedWorkflowVersion: latestWorkflow.latest ?? 0,
          steps: template.steps, reason: `Modelo ${template.key} r${template.revisionNumber}`,
        });
        workflowDraftRevision = proposal.value.revisionNumber;
      }
      return { taskKey: task.key, templateKey: template.key, templateRevision: template.revisionNumber, checklistDraftRevision, workflowDraftRevision };
    },
  });
}
