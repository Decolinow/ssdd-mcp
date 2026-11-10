import type { ExternalWorkItemSource } from "../application/external-work-item-imports.js";
import { ApplicationError } from "../application/errors.js";

export interface GithubIssueImportOptions {
  readonly repository: string;
  readonly token: string;
  readonly limit?: number;
}

export type GithubIssueTokens = Readonly<Record<string, string>>;

const githubApiBaseUrl = "https://api.github.com";
const githubApiVersion = "2026-03-10";
const maximumGithubResponseBytes = 5 * 1_048_576;

export function readGithubIssueTokensFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const tokens: Record<string, string> = {};
  for (const [name, value] of Object.entries(environment)) {
    if (!name.startsWith("SSDD_GITHUB_ISSUES_TOKEN_")) continue;
    const match = /^SSDD_GITHUB_ISSUES_TOKEN_([A-Z][A-Z0-9]{0,9})$/u.exec(name);
    if (match === null) {
      throw new Error(`Environment variable '${name}' must end with '_<PROJECT_KEY>'.`);
    }
    const projectKey = match[1]!;
    if (value === undefined || value !== value.trim() || /[\r\n]/u.test(value) || Buffer.byteLength(value, "utf8") < 20 || Buffer.byteLength(value, "utf8") > 4_096) {
      throw new Error(`GitHub issues token for project '${projectKey}' must contain 20-4096 bytes without whitespace.`);
    }
    if (Object.hasOwn(tokens, projectKey)) {
      throw new Error(`GitHub issues token for project '${projectKey}' is configured more than once.`);
    }
    tokens[projectKey] = value;
  }
  validateGithubIssueTokens(tokens);
  return tokens;
}

export function validateGithubIssueTokens(tokens: GithubIssueTokens): void {
  for (const [projectKey, token] of Object.entries(tokens)) {
    if (!/^[A-Z][A-Z0-9]{0,9}$/u.test(projectKey)) {
      throw new Error("GitHub issue token keys must be valid uppercase project keys.");
    }
    if (typeof token !== "string" || token !== token.trim() || /[\r\n]/u.test(token) || Buffer.byteLength(token, "utf8") < 20 || Buffer.byteLength(token, "utf8") > 4_096) {
      throw new Error(`GitHub issues token for project '${projectKey}' must contain 20-4096 bytes without whitespace.`);
    }
  }
}

export async function fetchGithubIssues(
  options: GithubIssueImportOptions,
  fetcher: typeof fetch = globalThis.fetch,
): Promise<ExternalWorkItemSource[]> {
  const limit = options.limit ?? 50;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new ApplicationError("VALIDATION_FAILED", "GitHub issue import limit must be between 1 and 100.");
  }
  if (!/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/u.test(options.repository)) {
    throw new ApplicationError("VALIDATION_FAILED", "GitHub repository mapping must use owner/repository format.");
  }
  if (typeof options.token !== "string" || options.token !== options.token.trim() || /[\r\n]/u.test(options.token) || Buffer.byteLength(options.token, "utf8") < 20 || Buffer.byteLength(options.token, "utf8") > 4_096) {
    throw new ApplicationError("GITHUB_AUTH_NOT_CONFIGURED", "A read-only GitHub issues token is not configured for this project.");
  }

  const [owner, repositoryName] = options.repository.split("/") as [string, string];
  const baseUrl = new URL(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repositoryName)}/issues`, githubApiBaseUrl);
  baseUrl.searchParams.set("state", "all");
  baseUrl.searchParams.set("per_page", "100");
  baseUrl.searchParams.set("sort", "updated");
  baseUrl.searchParams.set("direction", "desc");

  const sources: ExternalWorkItemSource[] = [];
  const seenIssueIds = new Set<string>();
  let nextUrl: URL | undefined = baseUrl;
  let pagesRead = 0;
  while (nextUrl !== undefined && sources.length < limit && pagesRead < 100) {
    pagesRead += 1;
    const response = await fetcher(nextUrl, {
      method: "GET",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${options.token}`,
        "x-github-api-version": githubApiVersion,
        "user-agent": "ssdd-mcp/0.1.0",
      },
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      if (response.status === 429 || (response.status === 403 && response.headers.get("x-ratelimit-remaining") === "0")) {
        throw new ApplicationError("GITHUB_RATE_LIMITED", "GitHub rate limit reached; retry the import later.", { retryable: true });
      }
      if (response.status === 401 || response.status === 403) {
        throw new ApplicationError("GITHUB_AUTH_FAILED", "GitHub rejected the configured read-only token.");
      }
      throw new ApplicationError("GITHUB_UNAVAILABLE", `GitHub issue query failed with HTTP ${response.status}.`, { retryable: response.status >= 500 });
    }
    const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    if (contentType !== "application/json") {
      await response.body?.cancel().catch(() => undefined);
      throw new ApplicationError("GITHUB_INVALID_RESPONSE", "GitHub returned an unexpected content type.");
    }
    const page = await readGithubJson(response);
    if (!Array.isArray(page)) {
      throw new ApplicationError("GITHUB_INVALID_RESPONSE", "GitHub issue response must be an array.");
    }
    for (const value of page) {
      if (sources.length >= limit) break;
      const issue = asRecord(value);
      if (Object.hasOwn(issue, "pull_request")) continue;
      const source = parseGithubIssue(issue);
      if (seenIssueIds.has(source.externalId)) continue;
      seenIssueIds.add(source.externalId);
      sources.push(source);
    }
    nextUrl = readNextPageUrl(response.headers.get("link"), baseUrl);
  }
  return sources;
}

function parseGithubIssue(issue: Record<string, unknown>): ExternalWorkItemSource {
  const id = requiredPositiveSafeInteger(issue.id, "GitHub issue ID is invalid.");
  const number = requiredPositiveSafeInteger(issue.number, "GitHub issue number is invalid.");
  const title = requiredString(issue.title, "GitHub issue title is invalid.", 1_000, true);
  const body = issue.body === null ? null : requiredString(issue.body, "GitHub issue body is invalid.", 100_000, true);
  const state = requiredString(issue.state, "GitHub issue state is invalid.", 60);
  if (state !== "open" && state !== "closed") {
    throw new ApplicationError("GITHUB_INVALID_RESPONSE", "GitHub returned an unknown issue state.");
  }
  const url = requiredGithubIssueUrl(issue.html_url);
  const labelsValue = issue.labels;
  if (!Array.isArray(labelsValue) || labelsValue.length > 100) {
    throw new ApplicationError("GITHUB_INVALID_RESPONSE", "GitHub issue labels are invalid.");
  }
  const labels = labelsValue.map((label) => requiredString(asRecord(label).name, "GitHub issue label is invalid.", 100, true));
  const createdAt = requiredTimestamp(issue.created_at, "GitHub issue creation time is invalid.");
  const updatedAt = requiredTimestamp(issue.updated_at, "GitHub issue update time is invalid.");
  return { externalId: id.toString(), number, title, body, state, url, labels, createdAt, updatedAt };
}

async function readGithubJson(response: Response): Promise<unknown> {
  if (response.body === null) throw new ApplicationError("GITHUB_INVALID_RESPONSE", "GitHub returned an empty response.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      bytes += result.value.byteLength;
      if (bytes > maximumGithubResponseBytes) {
        await reader.cancel();
        throw new ApplicationError("GITHUB_RESPONSE_TOO_LARGE", "GitHub issue page exceeds the 5 MiB response limit.");
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, bytes))) as unknown;
  } catch {
    throw new ApplicationError("GITHUB_INVALID_RESPONSE", "GitHub returned invalid JSON.");
  }
}

function readNextPageUrl(linkHeader: string | null, expectedBaseUrl: URL): URL | undefined {
  if (linkHeader === null) return undefined;
  const links = [...linkHeader.matchAll(/<([^>]+)>\s*;\s*rel="([^"]+)"/gu)];
  const nextLink = links.find((match) => match[2] === "next")?.[1];
  if (nextLink === undefined) return undefined;
  let next: URL;
  try {
    next = new URL(nextLink);
  } catch {
    throw new ApplicationError("GITHUB_INVALID_RESPONSE", "GitHub pagination link is invalid.");
  }
  if (
    next.origin !== githubApiBaseUrl ||
    next.pathname !== expectedBaseUrl.pathname ||
    next.username.length > 0 || next.password.length > 0 ||
    next.searchParams.get("state") !== "all" || next.searchParams.get("per_page") !== "100"
  ) {
    throw new ApplicationError("GITHUB_INVALID_RESPONSE", "GitHub pagination link left the configured repository endpoint.");
  }
  return next;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ApplicationError("GITHUB_INVALID_RESPONSE", "GitHub returned a malformed issue record.");
  }
  return value as Record<string, unknown>;
}

function requiredPositiveSafeInteger(value: unknown, message: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new ApplicationError("GITHUB_INVALID_RESPONSE", message);
  }
  return value;
}

function requiredString(value: unknown, message: string, maxLength: number, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value.trim().length === 0) || value.length > maxLength) {
    throw new ApplicationError("GITHUB_INVALID_RESPONSE", message);
  }
  return value;
}

function requiredGithubIssueUrl(value: unknown): string {
  if (typeof value !== "string" || value.length > 2_048) {
    throw new ApplicationError("GITHUB_INVALID_RESPONSE", "GitHub issue URL is invalid.");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ApplicationError("GITHUB_INVALID_RESPONSE", "GitHub issue URL is invalid.");
  }
  if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "github.com") {
    throw new ApplicationError("GITHUB_INVALID_RESPONSE", "GitHub issue URL is outside the official host.");
  }
  return value;
}

function requiredTimestamp(value: unknown, message: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new ApplicationError("GITHUB_INVALID_RESPONSE", message);
  }
  return value;
}
