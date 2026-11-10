import type { ExternalWorkItemSource } from "../application/external-work-item-imports.js";
import { ApplicationError } from "../application/errors.js";

export type AzureDevOpsWorkItemType = "User Story" | "Bug";

export interface AzureDevOpsConnection {
  readonly organization: string;
  readonly project: string;
  readonly token: string;
}

export type AzureDevOpsConnections = Readonly<Record<string, AzureDevOpsConnection>>;

export interface AzureDevOpsWorkItemImportOptions extends AzureDevOpsConnection {
  readonly workItemType: AzureDevOpsWorkItemType;
  readonly limit?: number;
}

const azureDevOpsApiBaseUrl = "https://dev.azure.com";
const azureDevOpsApiVersion = "7.1";
const maximumAzureDevOpsResponseBytes = 5 * 1_048_576;
const maximumAzureDevOpsPageSize = 100;
const azureDevOpsWorkItemBatchSize = 200;

export function readAzureDevOpsConnectionsFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): Record<string, AzureDevOpsConnection> {
  const partial: Record<string, { organization?: string; project?: string; token?: string }> = {};
  for (const [name, value] of Object.entries(environment)) {
    if (!name.startsWith("SSDD_AZURE_DEVOPS_")) continue;
    const match = /^SSDD_AZURE_DEVOPS_(ORGANIZATION|PROJECT|TOKEN)_([A-Z][A-Z0-9]{0,9})$/u.exec(name);
    if (match === null) {
      throw new Error(`Environment variable '${name}' must use SSDD_AZURE_DEVOPS_<ORGANIZATION|PROJECT|TOKEN>_<PROJECT_KEY>.`);
    }
    const field = match[1]!.toLowerCase() as "organization" | "project" | "token";
    const projectKey = match[2]!;
    if (value === undefined) throw new Error(`Azure DevOps ${field} for project '${projectKey}' is empty.`);
    (partial[projectKey] ??= {})[field] = value;
  }

  const connections: Record<string, AzureDevOpsConnection> = {};
  for (const [projectKey, values] of Object.entries(partial)) {
    if (values.organization === undefined || values.project === undefined || values.token === undefined) {
      throw new Error(`Azure DevOps project '${projectKey}' requires organization, project, and token variables.`);
    }
    const connection = { organization: values.organization, project: values.project, token: values.token };
    validateAzureDevOpsConnection(connection, projectKey);
    connections[projectKey] = connection;
  }
  validateAzureDevOpsConnections(connections);
  return connections;
}

export function validateAzureDevOpsConnections(connections: AzureDevOpsConnections): void {
  for (const [projectKey, connection] of Object.entries(connections)) {
    if (!/^[A-Z][A-Z0-9]{0,9}$/u.test(projectKey)) {
      throw new Error("Azure DevOps connection keys must be valid uppercase project keys.");
    }
    validateAzureDevOpsConnection(connection, projectKey);
  }
}

export async function fetchAzureDevOpsWorkItems(
  options: AzureDevOpsWorkItemImportOptions,
  fetcher: typeof fetch = globalThis.fetch,
): Promise<ExternalWorkItemSource[]> {
  const limit = options.limit ?? 50;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > maximumAzureDevOpsPageSize) {
    throw new ApplicationError("VALIDATION_FAILED", "Azure DevOps work item import limit must be between 1 and 100.");
  }
  validateAzureDevOpsConnection(options);
  if (options.workItemType !== "User Story" && options.workItemType !== "Bug") {
    throw new ApplicationError("VALIDATION_FAILED", "Azure DevOps work item type must be User Story or Bug.");
  }

  const workItemsUrl = createAzureApiUrl(options, "wit/wiql");
  workItemsUrl.searchParams.set("$top", String(limit));
  workItemsUrl.searchParams.set("api-version", azureDevOpsApiVersion);
  const authorization = `Basic ${Buffer.from(`:${options.token}`, "utf8").toString("base64")}`;
  const queryResponse = await fetchJson(fetcher, workItemsUrl, authorization, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      query: `SELECT [System.Id] FROM WorkItems WHERE [System.WorkItemType] = '${options.workItemType}' ORDER BY [System.ChangedDate] DESC`,
    }),
  }, "WIQL");
  const ids = parseWiqlIds(queryResponse, limit);
  if (ids.length === 0) return [];

  const sources: ExternalWorkItemSource[] = [];
  for (let offset = 0; offset < ids.length; offset += azureDevOpsWorkItemBatchSize) {
    const batchIds = ids.slice(offset, offset + azureDevOpsWorkItemBatchSize);
    const batchUrl = createAzureApiUrl(options, "wit/workitemsbatch");
    batchUrl.searchParams.set("api-version", azureDevOpsApiVersion);
    const response = await fetchJson(fetcher, batchUrl, authorization, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ids: batchIds,
        fields: [
          "System.Id",
          "System.Title",
          "System.Description",
          "System.State",
          "System.WorkItemType",
          "System.CreatedDate",
          "System.ChangedDate",
          "System.Tags",
        ],
      }),
    }, "work item batch");
    sources.push(...parseAzureBatch(response, batchIds, options));
  }
  return sources;
}

function validateAzureDevOpsConnection(connection: AzureDevOpsConnection, projectKey?: string): void {
  const suffix = projectKey === undefined ? "" : ` for project '${projectKey}'`;
  if (
    typeof connection.organization !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9-]{0,49}$/u.test(connection.organization)
  ) {
    throw new ApplicationError("VALIDATION_FAILED", `Azure DevOps organization${suffix} is invalid.`);
  }
  if (
    typeof connection.project !== "string" ||
    connection.project !== connection.project.trim() ||
    connection.project.length < 1 || connection.project.length > 120 ||
    [...connection.project].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x1f || code === 0x7f || "/?#".includes(character);
    }) ||
    connection.project === "." || connection.project === ".."
  ) {
    throw new ApplicationError("VALIDATION_FAILED", `Azure DevOps project${suffix} is invalid.`);
  }
  if (
    typeof connection.token !== "string" || connection.token !== connection.token.trim() ||
    /\s/u.test(connection.token) || Buffer.byteLength(connection.token, "utf8") < 20 ||
    Buffer.byteLength(connection.token, "utf8") > 4_096
  ) {
    throw new ApplicationError("AZURE_DEVOPS_AUTH_NOT_CONFIGURED", `A read-only Azure DevOps token${suffix} is not configured.`);
  }
}

function createAzureApiUrl(connection: Pick<AzureDevOpsConnection, "organization" | "project">, operation: string): URL {
  const organization = encodeURIComponent(connection.organization);
  const project = encodeURIComponent(connection.project);
  return new URL(`/${organization}/${project}/_apis/${operation}`, azureDevOpsApiBaseUrl);
}

async function fetchJson(
  fetcher: typeof fetch,
  url: URL,
  authorization: string,
  request: { readonly method: "POST"; readonly headers: Readonly<Record<string, string>>; readonly body: string },
  operation: string,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetcher(url, {
      ...request,
      headers: {
        accept: "application/json",
        authorization,
        ...request.headers,
      },
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new ApplicationError("AZURE_DEVOPS_UNAVAILABLE", "Azure DevOps query could not be completed.", { retryable: true });
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    if (response.status === 429) {
      throw new ApplicationError("AZURE_DEVOPS_RATE_LIMITED", "Azure DevOps rate limit reached; retry the import later.", { retryable: true });
    }
    if (response.status === 401 || response.status === 403) {
      throw new ApplicationError("AZURE_DEVOPS_AUTH_FAILED", "Azure DevOps rejected the configured read-only token or denied work item access.");
    }
    throw new ApplicationError("AZURE_DEVOPS_UNAVAILABLE", `Azure DevOps ${operation} query failed with HTTP ${response.status}.`, { retryable: response.status >= 500 });
  }
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    await response.body?.cancel().catch(() => undefined);
    throw new ApplicationError("AZURE_DEVOPS_INVALID_RESPONSE", "Azure DevOps returned an unexpected content type.");
  }
  return readAzureJson(response);
}

async function readAzureJson(response: Response): Promise<unknown> {
  if (response.body === null) throw new ApplicationError("AZURE_DEVOPS_INVALID_RESPONSE", "Azure DevOps returned an empty response.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      bytes += result.value.byteLength;
      if (bytes > maximumAzureDevOpsResponseBytes) {
        await reader.cancel();
        throw new ApplicationError("AZURE_DEVOPS_RESPONSE_TOO_LARGE", "Azure DevOps response exceeds the 5 MiB limit.");
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, bytes))) as unknown;
  } catch {
    throw new ApplicationError("AZURE_DEVOPS_INVALID_RESPONSE", "Azure DevOps returned invalid JSON.");
  }
}

function parseWiqlIds(value: unknown, limit: number): number[] {
  const result = asRecord(value, "Azure DevOps WIQL result is malformed.");
  if (!Array.isArray(result.workItems)) {
    throw new ApplicationError("AZURE_DEVOPS_INVALID_RESPONSE", "Azure DevOps WIQL response must contain workItems.");
  }
  const ids: number[] = [];
  const seen = new Set<number>();
  for (const item of result.workItems) {
    const record = asRecord(item, "Azure DevOps WIQL work item reference is malformed.");
    const id = positiveSafeInteger(record.id, "Azure DevOps WIQL work item ID is invalid.");
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
    if (ids.length >= limit) break;
  }
  return ids;
}

function parseAzureBatch(
  value: unknown,
  requestedIds: readonly number[],
  connection: AzureDevOpsWorkItemImportOptions,
): ExternalWorkItemSource[] {
  const result = asRecord(value, "Azure DevOps batch result is malformed.");
  if (!Array.isArray(result.value)) {
    throw new ApplicationError("AZURE_DEVOPS_INVALID_RESPONSE", "Azure DevOps batch response must contain value.");
  }
  const requested = new Set(requestedIds);
  const seen = new Set<number>();
  const sources: ExternalWorkItemSource[] = [];
  for (const item of result.value) {
    const record = asRecord(item, "Azure DevOps work item is malformed.");
    const id = positiveSafeInteger(record.id, "Azure DevOps work item ID is invalid.");
    if (!requested.has(id) || seen.has(id)) {
      throw new ApplicationError("AZURE_DEVOPS_INVALID_RESPONSE", "Azure DevOps batch returned an unexpected or duplicate work item.");
    }
    seen.add(id);
    const fields = asRecord(record.fields, "Azure DevOps work item fields are malformed.");
    const sourceTypeValue = fields["System.WorkItemType"];
    const sourceType = sourceTypeValue === undefined || sourceTypeValue === null
      ? null
      : requiredString(sourceTypeValue, "Azure DevOps work item type is invalid.", 100);
    const title = requiredString(fields["System.Title"], "Azure DevOps work item title is invalid.", 1_000, true);
    const body = optionalDescription(fields["System.Description"]);
    const state = requiredString(fields["System.State"], "Azure DevOps work item state is invalid.", 60);
    const createdAt = requiredTimestamp(fields["System.CreatedDate"], "Azure DevOps work item creation time is invalid.");
    const updatedAt = requiredTimestamp(fields["System.ChangedDate"], "Azure DevOps work item update time is invalid.");
    const labels = parseTags(fields["System.Tags"]);
    sources.push({
      externalId: id.toString(),
      number: id,
      title,
      body,
      state,
      url: `https://dev.azure.com/${encodeURIComponent(connection.organization)}/${encodeURIComponent(connection.project)}/_workitems/edit/${id}`,
      labels,
      createdAt,
      updatedAt,
      sourceType,
    });
  }
  return sources;
}

function parseTags(value: unknown): string[] {
  if (value === undefined || value === null || value === "") return [];
  const tags = requiredString(value, "Azure DevOps work item tags are invalid.", 10_000, true)
    .split(";")
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0);
  if (tags.length > 100 || tags.some((tag) => tag.length > 100)) {
    throw new ApplicationError("AZURE_DEVOPS_INVALID_RESPONSE", "Azure DevOps work item tags exceed the supported limit.");
  }
  return tags;
}

function optionalDescription(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  return requiredString(value, "Azure DevOps work item description is invalid.", 1_048_576, true);
}

function asRecord(value: unknown, message: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ApplicationError("AZURE_DEVOPS_INVALID_RESPONSE", message);
  }
  return value as Record<string, unknown>;
}

function positiveSafeInteger(value: unknown, message: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) {
    throw new ApplicationError("AZURE_DEVOPS_INVALID_RESPONSE", message);
  }
  return value;
}

function requiredString(value: unknown, message: string, maxLength: number, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value.trim().length === 0) || value.length > maxLength) {
    throw new ApplicationError("AZURE_DEVOPS_INVALID_RESPONSE", message);
  }
  return value;
}

function requiredTimestamp(value: unknown, message: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new ApplicationError("AZURE_DEVOPS_INVALID_RESPONSE", message);
  }
  return value;
}
