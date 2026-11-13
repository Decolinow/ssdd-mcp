import { randomUUID } from "node:crypto";
import { openSqliteDatabase } from "../storage-sqlite/database.js";
import { getProject } from "../application/project-queries.js";
import { type GithubRepositoryMappings } from "../application/github-webhooks.js";
import { type ExternalWorkItemSource } from "../application/external-work-item-imports.js";
import { fetchGithubIssues, type GithubIssueTokens } from "../integrations/github-issues.js";
import { fetchAzureDevOpsWorkItems, type AzureDevOpsConnections, type AzureDevOpsWorkItemType } from "../integrations/azure-devops-work-items.js";
import { ApplicationError } from "../application/errors.js";

export async function configuredGithubIssues(
  database: ReturnType<typeof openSqliteDatabase>,
  principalId: string,
  projectId: string,
  repositories: GithubRepositoryMappings,
  tokens: GithubIssueTokens,
  limit: number | undefined,
): Promise<{ readonly repository: string; readonly sources: ExternalWorkItemSource[] }> {
  const project = getProject(database, principalId, projectId);
  const repository = Object.hasOwn(repositories, project.key) ? repositories[project.key] : undefined;
  if (repository === undefined) {
    throw new ApplicationError("GITHUB_REPOSITORY_NOT_CONFIGURED", "GitHub repository is not configured for this project.");
  }
  const token = Object.hasOwn(tokens, project.key) ? tokens[project.key] : undefined;
  if (token === undefined) {
    throw new ApplicationError("GITHUB_AUTH_NOT_CONFIGURED", "A read-only GitHub issues token is not configured for this project.");
  }
  const sources = await fetchGithubIssues({ repository, token, ...(limit === undefined ? {} : { limit }) });
  return { repository, sources };
}

export async function configuredAzureDevOpsWorkItems(
  database: ReturnType<typeof openSqliteDatabase>,
  principalId: string,
  projectId: string,
  connections: AzureDevOpsConnections,
  azureWorkItemType: AzureDevOpsWorkItemType,
  limit: number | undefined,
): Promise<{ readonly externalScope: string; readonly sources: ExternalWorkItemSource[] }> {
  const project = getProject(database, principalId, projectId);
  const connection = Object.hasOwn(connections, project.key) ? connections[project.key] : undefined;
  if (connection === undefined) {
    throw new ApplicationError("AZURE_DEVOPS_NOT_CONFIGURED", "Azure DevOps organization and project are not configured for this SSDD project.");
  }
  const sources = await fetchAzureDevOpsWorkItems({
    ...connection,
    workItemType: azureWorkItemType,
    ...(limit === undefined ? {} : { limit }),
  });
  return {
    externalScope: `${connection.organization}/${connection.project}`,
    sources,
  };
}

/** Versão otimista corrente do item, para encadear escritas sem releitura. */
export function currentItemVersion(database: ReturnType<typeof openSqliteDatabase>, projectId: string, itemId: string): number {
  const row = database.prepare("SELECT version FROM work_items WHERE project_id = ? AND item_id = ?").get(projectId, itemId) as { version: number } | undefined;
  return row?.version ?? 1;
}

export function toToolError(error: unknown) {
  const applicationError =
    error instanceof ApplicationError
      ? error
      : new ApplicationError("INTERNAL_ERROR", "An unexpected server error occurred.");
  const correlationId = randomUUID();
  if (applicationError.code === "INTERNAL_ERROR") {
    const errorType = error instanceof Error ? error.name : "UnknownError";
    process.stderr.write(`MCP tool failure ${correlationId} (${errorType}).\n`);
  }
  const envelope = {
    code: applicationError.code,
    message: applicationError.message,
    details: applicationError.details,
    retryable: applicationError.retryable,
    correlationId,
  };

  return {
    isError: true as const,
    content: [{ type: "text" as const, text: JSON.stringify(envelope) }],
  };
}

export const queueVerboseFields = ["businessValueRationale", "businessValueSource", "prioritySource"] as const;

/** Drops long, repeated justification fields from queue entries to save agent context; `verbose` restores them. */
export function leanTaskQueue<T extends { tasks: readonly object[]; blocked: readonly object[]; upNext: readonly object[] }>(queue: T): T {
  const strip = (entry: object) => Object.fromEntries(Object.entries(entry).filter(([key]) => !(queueVerboseFields as readonly string[]).includes(key)));
  return { ...queue, tasks: queue.tasks.map(strip), blocked: queue.blocked.map(strip), upNext: queue.upNext.map(strip) };
}

/** Single success envelope for tools: text content plus the same value as structured output. */
export function toolResult<T extends object>(value: T) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }], structuredContent: value as unknown as Record<string, unknown> };
}
