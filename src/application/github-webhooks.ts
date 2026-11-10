import { randomUUID } from "node:crypto";
import type { SqliteDatabase } from "../storage-sqlite/database.js";
import { ApplicationError } from "./errors.js";
import { assertProjectAuthorization as authorizeProject } from "./local-identity.js";
import type { AcceptedWebhookContext, WebhookDeliveryProcessor } from "./webhooks.js";

export type GithubRepositoryMappings = Readonly<Record<string, string>>;

const pullRequestActions = new Set([
  "opened",
  "reopened",
  "synchronize",
  "edited",
  "closed",
  "ready_for_review",
  "converted_to_draft",
]);

export interface GithubPullRequestReference {
  readonly repository: string;
  readonly number: number;
  readonly url: string;
  readonly title: string;
  readonly state: "open" | "closed";
  readonly merged: boolean;
  readonly draft: boolean;
  readonly headBranch: string;
  readonly headSha: string;
  readonly baseBranch: string;
  readonly baseSha: string;
  readonly workItemId: string | null;
  readonly workItemKey: string | null;
  readonly receivedAt: string;
}

export interface GithubWorkflowRunReference {
  readonly repository: string;
  readonly id: string;
  readonly number: number;
  readonly name: string | null;
  readonly status: string;
  readonly conclusion: string | null;
  readonly url: string;
  readonly headBranch: string;
  readonly headSha: string;
  readonly pullRequestNumbers: readonly number[];
  readonly workItemId: string | null;
  readonly workItemKey: string | null;
  readonly receivedAt: string;
}

export interface GithubReferences {
  readonly pullRequests: readonly GithubPullRequestReference[];
  readonly workflowRuns: readonly GithubWorkflowRunReference[];
}

interface WorkItemLink {
  readonly workItemId: string | null;
  readonly workItemKey: string | null;
}

interface WorkItemRow {
  readonly item_id: string;
  readonly item_key: string;
}

interface PullRequestLinkRow {
  readonly work_item_id: string | null;
  readonly work_item_key: string | null;
}

export function validateGithubRepositoryMappings(mappings: GithubRepositoryMappings): void {
  for (const [projectKey, repository] of Object.entries(mappings)) {
    if (!/^[A-Z][A-Z0-9]{0,9}$/u.test(projectKey)) {
      throw new Error("GitHub repository mapping keys must be valid uppercase project keys.");
    }
    if (!isRepositoryName(repository)) {
      throw new Error(`GitHub repository for project '${projectKey}' must use the owner/repository format.`);
    }
  }
}

export function readGithubRepositoriesFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const mappings: Record<string, string> = {};
  for (const [name, value] of Object.entries(environment)) {
    if (!name.startsWith("SSDD_GITHUB_REPOSITORY_")) continue;
    const match = /^SSDD_GITHUB_REPOSITORY_([A-Z][A-Z0-9]{0,9})$/u.exec(name);
    if (match === null) {
      throw new Error(`Environment variable '${name}' must end with '_<PROJECT_KEY>'.`);
    }
    const projectKey = match[1]!;
    if (value === undefined || !isRepositoryName(value)) {
      throw new Error(`Environment variable '${name}' must contain an owner/repository value.`);
    }
    if (Object.hasOwn(mappings, projectKey)) {
      throw new Error(`GitHub repository for project '${projectKey}' is configured more than once.`);
    }
    mappings[projectKey] = value;
  }
  validateGithubRepositoryMappings(mappings);
  return mappings;
}

export function createGithubWebhookProcessor(
  repositoryMappings: GithubRepositoryMappings,
): WebhookDeliveryProcessor {
  validateGithubRepositoryMappings(repositoryMappings);
  return (database, context) => processGithubWebhook(database, context, repositoryMappings);
}

export function listGithubReferences(
  database: SqliteDatabase,
  input: {
    readonly projectId: string;
    readonly principalId: string;
    readonly workItemIdOrKey?: string;
    readonly limit?: number;
  },
): GithubReferences {
  assertProjectAuthorization(database, input.projectId, input.principalId);
  const limit = input.limit ?? 50;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new ApplicationError("VALIDATION_FAILED", "Reference limit must be between 1 and 100.");
  }
  let workItemId: string | undefined;
  if (input.workItemIdOrKey !== undefined) {
    const reference = input.workItemIdOrKey.trim();
    const item = database.prepare(
      `SELECT item_id FROM work_items
       WHERE project_id = ? AND (item_id = ? OR item_key = ? COLLATE NOCASE)`,
    ).get(input.projectId, reference, reference) as { item_id: string } | undefined;
    if (item === undefined) throw new ApplicationError("NOT_FOUND", "Work item was not found.");
    workItemId = item.item_id;
  }

  const filterSql = workItemId === undefined ? "" : "AND event.work_item_id = ?";
  const parameters: (string | number)[] = workItemId === undefined
    ? [input.projectId, input.projectId, limit]
    : [input.projectId, input.projectId, workItemId, limit];
  const pullRequests = database.prepare(
    `WITH latest AS (
       SELECT MAX(sequence) AS sequence
       FROM github_pull_request_events
       WHERE project_id = ?
       GROUP BY repository_full_name, pull_request_number
     )
     SELECT event.repository_full_name, event.pull_request_number, event.html_url, event.title,
            event.state, event.merged, event.draft, event.head_ref, event.head_sha,
            event.base_ref, event.base_sha, event.work_item_id, event.work_item_key,
            item.item_key AS resolved_work_item_key, event.received_at
     FROM latest
     INNER JOIN github_pull_request_events AS event ON event.sequence = latest.sequence
     LEFT JOIN work_items AS item ON item.project_id = event.project_id AND item.item_id = event.work_item_id
     WHERE event.project_id = ? ${filterSql}
     ORDER BY event.received_at DESC, event.sequence DESC
     LIMIT ?`,
  ).all(...parameters) as Array<{
    repository_full_name: string; pull_request_number: number; html_url: string; title: string;
    state: "open" | "closed"; merged: number; draft: number; head_ref: string; head_sha: string;
    base_ref: string; base_sha: string; work_item_id: string | null; work_item_key: string | null;
    resolved_work_item_key: string | null; received_at: string;
  }>;
  const workflowRuns = database.prepare(
    `WITH latest AS (
       SELECT MAX(sequence) AS sequence
       FROM github_workflow_run_events
       WHERE project_id = ?
       GROUP BY repository_full_name, workflow_run_id
     )
     SELECT event.repository_full_name, event.workflow_run_id, event.run_number, event.name,
            event.status, event.conclusion, event.html_url, event.head_branch, event.head_sha,
            event.pull_request_numbers_json, event.work_item_id, event.work_item_key,
            item.item_key AS resolved_work_item_key, event.received_at
     FROM latest
     INNER JOIN github_workflow_run_events AS event ON event.sequence = latest.sequence
     LEFT JOIN work_items AS item ON item.project_id = event.project_id AND item.item_id = event.work_item_id
     WHERE event.project_id = ? ${filterSql}
     ORDER BY event.received_at DESC, event.sequence DESC
     LIMIT ?`,
  ).all(...parameters) as Array<{
    repository_full_name: string; workflow_run_id: string; run_number: number; name: string | null;
    status: string; conclusion: string | null; html_url: string; head_branch: string; head_sha: string;
    pull_request_numbers_json: string; work_item_id: string | null; work_item_key: string | null;
    resolved_work_item_key: string | null; received_at: string;
  }>;

  return {
    pullRequests: pullRequests.map((row) => ({
      repository: row.repository_full_name,
      number: row.pull_request_number,
      url: row.html_url,
      title: row.title,
      state: row.state,
      merged: row.merged === 1,
      draft: row.draft === 1,
      headBranch: row.head_ref,
      headSha: row.head_sha,
      baseBranch: row.base_ref,
      baseSha: row.base_sha,
      workItemId: row.work_item_id,
      workItemKey: row.resolved_work_item_key ?? row.work_item_key,
      receivedAt: row.received_at,
    })),
    workflowRuns: workflowRuns.map((row) => ({
      repository: row.repository_full_name,
      id: row.workflow_run_id,
      number: row.run_number,
      name: row.name,
      status: row.status,
      conclusion: row.conclusion,
      url: row.html_url,
      headBranch: row.head_branch,
      headSha: row.head_sha,
      pullRequestNumbers: JSON.parse(row.pull_request_numbers_json) as number[],
      workItemId: row.work_item_id,
      workItemKey: row.resolved_work_item_key ?? row.work_item_key,
      receivedAt: row.received_at,
    })),
  };
}

function processGithubWebhook(
  database: SqliteDatabase,
  context: AcceptedWebhookContext,
  mappings: GithubRepositoryMappings,
): void {
  const expectedRepository = Object.hasOwn(mappings, context.projectKey)
    ? mappings[context.projectKey]
    : undefined;
  if (expectedRepository === undefined) {
    throw new ApplicationError("WEBHOOK_REPOSITORY_NOT_CONFIGURED", "GitHub repository is not configured for this project.");
  }
  const payload = record(context.payload, "GitHub payload must be an object.");
  const repository = record(payload.repository, "GitHub payload must include repository metadata.");
  const fullName = requiredString(repository.full_name, "GitHub repository name is invalid.", 201);
  if (fullName.toLowerCase() !== expectedRepository.toLowerCase()) {
    throw new ApplicationError("WEBHOOK_REPOSITORY_MISMATCH", "GitHub repository does not match the configured project.");
  }
  const repositoryId = requiredPositiveInteger(repository.id, "GitHub repository ID is invalid.").toString();

  if (context.receipt.eventType === "pull_request") {
    processPullRequest(database, context, payload, repositoryId, fullName);
  } else if (context.receipt.eventType === "workflow_run") {
    processWorkflowRun(database, context, payload, repositoryId, fullName);
  }
}

function processPullRequest(
  database: SqliteDatabase,
  context: AcceptedWebhookContext,
  payload: Record<string, unknown>,
  repositoryId: string,
  repositoryFullName: string,
): void {
  const action = requiredString(payload.action, "GitHub pull request action is invalid.", 40);
  if (!pullRequestActions.has(action)) return;
  const pullRequest = record(payload.pull_request, "GitHub pull request payload is missing.");
  const number = requiredPositiveInteger(pullRequest.number, "GitHub pull request number is invalid.");
  const head = record(pullRequest.head, "GitHub pull request head is invalid.");
  const base = record(pullRequest.base, "GitHub pull request base is invalid.");
  const htmlUrl = requiredHttpsUrl(pullRequest.html_url, "GitHub pull request URL is invalid.");
  const title = requiredString(pullRequest.title, "GitHub pull request title is invalid.", 500, true);
  const state = requiredString(pullRequest.state, "GitHub pull request state is invalid.", 10);
  if (state !== "open" && state !== "closed") {
    throw new ApplicationError("VALIDATION_FAILED", "GitHub pull request state is invalid.");
  }
  const merged = requiredBoolean(pullRequest.merged, "GitHub pull request merged flag is invalid.");
  const draft = requiredBoolean(pullRequest.draft, "GitHub pull request draft flag is invalid.");
  const headRef = requiredString(head.ref, "GitHub pull request head branch is invalid.", 255, true);
  const headSha = requiredSha(head.sha, "GitHub pull request head SHA is invalid.");
  const baseRef = requiredString(base.ref, "GitHub pull request base branch is invalid.", 255, true);
  const baseSha = requiredSha(base.sha, "GitHub pull request base SHA is invalid.");
  const link = resolveWorkItem(database, context.projectId, context.projectKey, [headRef, title]);
  const eventId = randomUUID();
  database.prepare(
    `INSERT INTO github_pull_request_events
      (event_id, receipt_id, project_id, repository_id, repository_full_name,
       pull_request_number, action, html_url, title, state, merged, draft,
       head_ref, head_sha, base_ref, base_sha, work_item_id, work_item_key, received_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    eventId, context.receipt.receiptId, context.projectId, repositoryId, repositoryFullName,
    number, action, htmlUrl, title, state, merged ? 1 : 0, draft ? 1 : 0,
    headRef, headSha, baseRef, baseSha, link.workItemId, link.workItemKey, context.receipt.receivedAt,
  );
  recordGithubAudit(database, context, "github.pull_request.observed", "github_pull_request", eventId, {
    repository: repositoryFullName,
    number,
    action,
    workItemId: link.workItemId,
    workItemKey: link.workItemKey,
  });
}

function processWorkflowRun(
  database: SqliteDatabase,
  context: AcceptedWebhookContext,
  payload: Record<string, unknown>,
  repositoryId: string,
  repositoryFullName: string,
): void {
  const action = requiredString(payload.action, "GitHub workflow run action is invalid.", 40);
  if (action !== "completed") return;
  const run = record(payload.workflow_run, "GitHub workflow run payload is missing.");
  const id = requiredPositiveInteger(run.id, "GitHub workflow run ID is invalid.").toString();
  const number = requiredPositiveInteger(run.run_number, "GitHub workflow run number is invalid.");
  const name = run.name === null || run.name === undefined
    ? null
    : requiredString(run.name, "GitHub workflow run name is invalid.", 200, true);
  const status = requiredString(run.status, "GitHub workflow run status is invalid.", 40);
  if (status !== "completed") {
    throw new ApplicationError("VALIDATION_FAILED", "Completed GitHub workflow runs must have completed status.");
  }
  const conclusion = run.conclusion === null || run.conclusion === undefined
    ? null
    : requiredString(run.conclusion, "GitHub workflow run conclusion is invalid.", 40);
  const htmlUrl = requiredHttpsUrl(run.html_url, "GitHub workflow run URL is invalid.");
  const headBranch = requiredString(run.head_branch, "GitHub workflow run branch is invalid.", 255, true);
  const headSha = requiredSha(run.head_sha, "GitHub workflow run SHA is invalid.");
  const pullRequestNumbers = readPullRequestNumbers(run.pull_requests);
  const branchLink = resolveWorkItem(database, context.projectId, context.projectKey, [headBranch]);
  const prLink = branchLink.workItemKey === null
    ? findPullRequestWorkItem(database, context.projectId, repositoryFullName, pullRequestNumbers)
    : undefined;
  const link = prLink ?? branchLink;
  const eventId = randomUUID();
  database.prepare(
    `INSERT INTO github_workflow_run_events
      (event_id, receipt_id, project_id, repository_id, repository_full_name,
       workflow_run_id, run_number, name, status, conclusion, html_url, head_branch,
       head_sha, pull_request_numbers_json, work_item_id, work_item_key, received_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    eventId, context.receipt.receiptId, context.projectId, repositoryId, repositoryFullName,
    id, number, name, status, conclusion, htmlUrl, headBranch, headSha,
    JSON.stringify(pullRequestNumbers), link.workItemId, link.workItemKey, context.receipt.receivedAt,
  );
  recordGithubAudit(database, context, "github.workflow_run.observed", "github_workflow_run", eventId, {
    repository: repositoryFullName,
    id,
    number,
    conclusion,
    pullRequestNumbers,
    workItemId: link.workItemId,
    workItemKey: link.workItemKey,
  });
}

function resolveWorkItem(
  database: SqliteDatabase,
  projectId: string,
  projectKey: string,
  texts: readonly string[],
): WorkItemLink {
  const pattern = new RegExp(`(^|[^A-Za-z0-9])(${escapeRegex(projectKey)}-[0-9]+)(?=$|[^A-Za-z0-9])`, "iu");
  for (const text of texts) {
    const match = pattern.exec(text);
    if (match === null) continue;
    const key = match[2]!.toUpperCase();
    const item = database.prepare(
      "SELECT item_id, item_key FROM work_items WHERE project_id = ? AND item_key = ? COLLATE NOCASE",
    ).get(projectId, key) as WorkItemRow | undefined;
    return { workItemId: item?.item_id ?? null, workItemKey: item?.item_key ?? key };
  }
  return { workItemId: null, workItemKey: null };
}

function findPullRequestWorkItem(
  database: SqliteDatabase,
  projectId: string,
  repositoryFullName: string,
  pullRequestNumbers: readonly number[],
): WorkItemLink | undefined {
  for (const number of pullRequestNumbers) {
    const link = database.prepare(
      `SELECT work_item_id, work_item_key FROM github_pull_request_events
       WHERE project_id = ? AND repository_full_name = ? AND pull_request_number = ?
       ORDER BY sequence DESC LIMIT 1`,
    ).get(projectId, repositoryFullName, number) as PullRequestLinkRow | undefined;
    if (link !== undefined && (link.work_item_id !== null || link.work_item_key !== null)) {
      return { workItemId: link.work_item_id, workItemKey: link.work_item_key };
    }
  }
  return undefined;
}

function recordGithubAudit(
  database: SqliteDatabase,
  context: AcceptedWebhookContext,
  eventType: string,
  entityType: string,
  entityId: string,
  payload: Readonly<Record<string, unknown>>,
): void {
  database.prepare(
    `INSERT INTO audit_events
      (event_id, project_id, principal_id, event_type, entity_type, entity_id,
       correlation_id, occurred_at, payload_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    randomUUID(), context.projectId, context.principalId, eventType, entityType,
    entityId, context.receipt.receiptId, context.receipt.receivedAt, JSON.stringify(payload),
  );
}

function readPullRequestNumbers(value: unknown): number[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 100) {
    throw new ApplicationError("VALIDATION_FAILED", "GitHub workflow pull request list is invalid.");
  }
  return [...new Set(value.map((entry) => requiredPositiveInteger(
    record(entry, "GitHub workflow pull request reference is invalid.").number,
    "GitHub workflow pull request number is invalid.",
  )))];
}

function assertProjectAuthorization(database: SqliteDatabase, projectId: string, principalId: string): void {
  authorizeProject(database, projectId, principalId);
}

function isRepositoryName(value: string): boolean {
  return typeof value === "string" && /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/u.test(value);
}

function record(value: unknown, message: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ApplicationError("VALIDATION_FAILED", message);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, message: string, maxLength: number, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value.trim().length === 0) || value.length > maxLength) {
    throw new ApplicationError("VALIDATION_FAILED", message);
  }
  return value;
}

function requiredPositiveInteger(value: unknown, message: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new ApplicationError("VALIDATION_FAILED", message);
  }
  return value;
}

function requiredBoolean(value: unknown, message: string): boolean {
  if (typeof value !== "boolean") throw new ApplicationError("VALIDATION_FAILED", message);
  return value;
}

function requiredSha(value: unknown, message: string): string {
  if (typeof value !== "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/iu.test(value)) {
    throw new ApplicationError("VALIDATION_FAILED", message);
  }
  return value;
}

function requiredHttpsUrl(value: unknown, message: string): string {
  if (typeof value !== "string" || value.length > 2048) {
    throw new ApplicationError("VALIDATION_FAILED", message);
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ApplicationError("VALIDATION_FAILED", message);
  }
  if (url.protocol !== "https:") throw new ApplicationError("VALIDATION_FAILED", message);
  return value;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
