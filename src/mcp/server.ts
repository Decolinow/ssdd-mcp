import { McpServer } from "@modelcontextprotocol/server";
import { SkillsExtension } from "@modelcontextprotocol/server/ext/skills";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { nodeSkillFiles } from "@modelcontextprotocol/server/ext/skills/node";
import { existsSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { packageVersion } from "../package-version.js";
import { openSqliteDatabase } from "../storage-sqlite/database.js";
import { applyMigrations } from "../storage-sqlite/migrations.js";
import { getOrCreateLocalPrincipal } from "../application/local-identity.js";
import { isInstanceAdministrator, resolvePrincipalFromAuthKey, ensureBootstrapAdministrator } from "../application/user-management.js";
import { approvableMcpToolNames, assertMatchingToolApproval, consumeToolApproval, expectedVersionFromArguments, type ApprovableMcpToolName } from "../application/command-approvals.js";
import type { JsonValue } from "../application/idempotent-command.js";
import { readGithubRepositoriesFromEnvironment, type GithubRepositoryMappings } from "../application/github-webhooks.js";
import { readGithubIssueTokensFromEnvironment, type GithubIssueTokens } from "../integrations/github-issues.js";
import { readAzureDevOpsConnectionsFromEnvironment, type AzureDevOpsConnections } from "../integrations/azure-devops-work-items.js";
import { ApplicationError } from "../application/errors.js";
import { describeWithHint } from "./tool-hints.js";
import { readTextEmbeddingProviderFromEnvironment, type TextEmbeddingProvider } from "../integrations/embeddings.js";
import { mcpProfileAllowsPrompt, mcpProfileAllowsTool, mcpProfileSkillNames, mcpProfiles, parseMcpProfile, type McpProfile } from "./profiles.js";
import { normalizeItemParameterAlias, withItemParameterAlias } from "./item-parameter-alias.js";
import { withToolAnnotations } from "./tool-annotations.js";
import type { McpToolContext } from "./tool-context.js";
import { toToolError } from "./tool-support.js";
import { registerResourceHandlers } from "./tools/resources.js";
import { registerProjectAdminTools } from "./tools/project-admin.js";
import { registerWorkItemTools } from "./tools/work-items.js";
import { registerSpecificationTools } from "./tools/specifications.js";
import { registerExecutionTools } from "./tools/execution.js";
import { registerReportingTools } from "./tools/reporting.js";
import { registerIntegrationTools } from "./tools/integrations.js";
import { registerTeamSprintTools } from "./tools/teams-sprints.js";
import { registerQualityTools } from "./tools/quality.js";
import { registerPrompts } from "./tools/prompts.js";

const skillRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../skills");
const sourceSkillFiles = nodeSkillFiles(skillRoot);
type SkillCatalog = Awaited<ReturnType<typeof SkillsExtension.load>>;
const profileSkillCatalogs = new Map<string, SkillCatalog>();
const skillSets = new Map<string, ReadonlySet<string>>();
const profileSkillSetKeys = new Map<string, string>();
for (const profile of mcpProfiles) {
  for (const isInstanceAdmin of [false, true]) {
    const allowedSkills = mcpProfileSkillNames(profile, isInstanceAdmin);
    if (allowedSkills.size === 0) {
      profileSkillSetKeys.set(`${profile}:${isInstanceAdmin}`, "");
      continue;
    }
    const skillSetKey = [...allowedSkills].sort().join("\u0000");
    skillSets.set(skillSetKey, allowedSkills);
    profileSkillSetKeys.set(`${profile}:${isInstanceAdmin}`, skillSetKey);
  }
}
const skillCatalogsBySet = new Map<string, SkillCatalog>();
await Promise.all([...skillSets].map(async ([skillSetKey, allowedSkills]) => {
  const catalog = await SkillsExtension.load({
    list: async (directory) => {
      const entries = await sourceSkillFiles.list(directory);
      return directory === ""
        ? entries.filter((entry) => entry.kind === "directory" && allowedSkills.has(entry.name))
        : entries;
    },
    read: (path) => sourceSkillFiles.read(path),
  }, { prefix: "ssdd", strict: true });
  skillCatalogsBySet.set(skillSetKey, catalog);
}));
for (const [profileKey, skillSetKey] of profileSkillSetKeys) {
  if (skillSetKey === "") continue;
  const catalog = skillCatalogsBySet.get(skillSetKey);
  if (catalog !== undefined) profileSkillCatalogs.set(profileKey, catalog);
}

export function createMcpServer(
  database: ReturnType<typeof openSqliteDatabase>,
  principalId: string,
  integrations: {
    readonly githubRepositories?: GithubRepositoryMappings;
    readonly githubIssueTokens?: GithubIssueTokens;
    readonly azureDevOpsConnections?: AzureDevOpsConnections;
    readonly embeddingProvider?: TextEmbeddingProvider;
  } = {},
  profile: McpProfile = "full",
): McpServer {
  const githubRepositories = integrations.githubRepositories ?? readGithubRepositoriesFromEnvironment();
  const githubIssueTokens = integrations.githubIssueTokens ?? readGithubIssueTokensFromEnvironment();
  const azureDevOpsConnections = integrations.azureDevOpsConnections ?? readAzureDevOpsConnectionsFromEnvironment();
  const embeddingProvider = integrations.embeddingProvider ?? readTextEmbeddingProviderFromEnvironment();
  const server = new McpServer({ name: "ssdd-mcp", version: packageVersion });
  const isHostAdministrator = isInstanceAdministrator(database, principalId);
  const skillCatalog = profileSkillCatalogs.get(`${profile}:${isHostAdministrator}`);
  if (skillCatalog === undefined) {
    if (mcpProfileSkillNames(profile, isHostAdministrator).size > 0) {
      throw new Error(`No skill catalog is configured for MCP profile '${profile}'.`);
    }
  } else {
    skillCatalog.attach(server);
  }
  const principal = database.prepare("SELECT principal_type FROM principals WHERE principal_id = ?")
    .get(principalId) as { principal_type: string } | undefined;
  // Output schemas are ~80% of the tools/list payload; SSDD_MCP_OMIT_OUTPUT_SCHEMAS=1 drops them (structuredContent is still returned).
  const omitOutputSchemas = process.env.SSDD_MCP_OMIT_OUTPUT_SCHEMAS === "1";
  const requiresHumanApproval = principal?.principal_type === "agent" || principal?.principal_type === "service";
  const originalRegisterPrompt = server.registerPrompt.bind(server) as unknown as (
    name: string,
    config: unknown,
    callback: (...args: never[]) => unknown,
  ) => unknown;
  server.registerPrompt = ((name: string, config: unknown, callback: (...args: never[]) => unknown) => {
    if (!mcpProfileAllowsPrompt(profile, name)) return undefined as never;
    return originalRegisterPrompt(name, config, callback) as never;
  }) as typeof server.registerPrompt;
  const originalRegisterTool = server.registerTool.bind(server) as unknown as (
    name: string,
    config: unknown,
    callback: (args: unknown, context: unknown) => unknown,
  ) => unknown;
  server.registerTool = ((name: string, config: unknown, callback: (args: unknown, context: unknown) => unknown) => {
    if (!mcpProfileAllowsTool(profile, name, isHostAdministrator)) return undefined as never;
    config = withToolAnnotations(name, config);
    if (typeof config === "object" && config !== null && "description" in config) {
      config = { ...(config as Record<string, unknown>), description: describeWithHint(name, (config as { description?: unknown }).description) };
    }
    if (omitOutputSchemas && typeof config === "object" && config !== null && "outputSchema" in config) {
      const withoutOutputSchema = { ...(config as Record<string, unknown>) };
      delete withoutOutputSchema.outputSchema;
      config = withoutOutputSchema;
    }
    const aliasing = withItemParameterAlias(config);
    config = aliasing.config;
    if (aliasing.aliased) {
      const innerCallback = callback;
      callback = (args, context) => innerCallback(normalizeItemParameterAlias(args), context);
    }
    if (!requiresHumanApproval || !isApprovableToolName(name)) {
      return originalRegisterTool(name, config, callback) as never;
    }
    return originalRegisterTool(name, config, (args, context) => {
      try {
        const callArguments = requireToolArguments(args);
        const projectId = callArguments.projectId;
        if (typeof projectId !== "string") {
          throw new ApplicationError("VALIDATION_FAILED", "Mutation arguments must contain projectId.");
        }
        const approvalId = readApprovalId(context);
        if (approvalId === undefined) {
          throw new ApplicationError("APPROVAL_REQUIRED", "An administrator-issued single-use approval is required for this agent or service mutation.");
        }
        const argumentValue = callArguments as JsonValue;
        const transaction = database.transaction(() => {
          const approval = assertMatchingToolApproval(database, {
            approvalId,
            projectId,
            executorPrincipalId: principalId,
            toolName: name,
            arguments: argumentValue,
            expectedVersion: expectedVersionFromArguments(argumentValue),
          });
          const result = callback(args, context);
          if (isPromiseLike(result)) {
            throw new Error("Approval-bound MCP handlers must finish their SQLite work synchronously.");
          }
          if (!isToolErrorResult(result)) {
            consumeToolApproval(database, approval, mutationAuditEventIdsFrom(result));
          }
          return result;
        });
        return transaction.immediate();
      } catch (error) {
        return toToolError(error);
      }
    }) as never;
  }) as typeof server.registerTool;
  const context: McpToolContext = { server, database, principalId, profile, isHostAdministrator, githubRepositories, githubIssueTokens, azureDevOpsConnections, embeddingProvider };
  registerResourceHandlers(context);
  registerProjectAdminTools(context);
  registerWorkItemTools(context);
  registerSpecificationTools(context);
  registerExecutionTools(context);
  registerReportingTools(context);
  registerIntegrationTools(context);
  registerTeamSprintTools(context);
  registerQualityTools(context);
  registerPrompts(context);
  return server;
}

export function startMcpServer(workspace: string): void {
  const databasePath = join(resolve(workspace), ".ssdd", "ssdd.sqlite");
  if (!existsSync(databasePath)) {
    throw new Error(`No SSDD workspace found at '${databasePath}'. Run 'ssdd-mcp init' first.`);
  }

  const database = openSqliteDatabase(databasePath);
  try {
    applyMigrations(database);
    const localPrincipal = getOrCreateLocalPrincipal(database);
    const bootstrapAdministrator = ensureBootstrapAdministrator(database, localPrincipal.id);
    if (bootstrapAdministrator.authKey !== null) {
      process.stderr.write(`Administrador inicial SSDD. Guarde esta authKey; ela será exibida uma única vez: ${bootstrapAdministrator.authKey}\n`);
    }
    const providedAuthKey = process.env.SSDD_AUTH_KEY;
    const principalId = providedAuthKey === undefined
      ? localPrincipal.id
      : resolvePrincipalFromAuthKey(database, providedAuthKey);
    if (principalId === undefined) throw new ApplicationError("UNAUTHENTICATED", "SSDD_AUTH_KEY is invalid or revoked.");
    const profile = parseMcpProfile(process.env.SSDD_PROFILE);
    const server = createMcpServer(database, principalId, {}, profile);
    server.server.onclose = () => database.close();
    serveStdio(() => server, {
      onerror: (error) => process.stderr.write(`SSDD MCP transport error: ${error.message}\n`),
    });
  } catch (error) {
    database.close();
    throw error;
  }
}

function isApprovableToolName(name: string): name is ApprovableMcpToolName {
  return (approvableMcpToolNames as readonly string[]).includes(name);
}



function requireToolArguments(value: unknown): Record<string, JsonValue> {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new ApplicationError("VALIDATION_FAILED", "Mutation arguments must be a JSON object.");
  }
  return value as Record<string, JsonValue>;
}

function readApprovalId(context: unknown): string | undefined {
  if (context === null || typeof context !== "object") return undefined;
  const mcpRequest = (context as { readonly mcpReq?: { readonly _meta?: Record<string, unknown> } }).mcpReq;
  const approvalId = mcpRequest?._meta?.["com.ssdd-mcp/approval-id"];
  if (approvalId === undefined) return undefined;
  if (typeof approvalId !== "string" || approvalId.trim().length === 0 || approvalId.length > 128) {
    throw new ApplicationError("VALIDATION_FAILED", "The approval metadata value is invalid.");
  }
  return approvalId;
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return value !== null && typeof value === "object" && "then" in value && typeof value.then === "function";
}

function isToolErrorResult(value: unknown): boolean {
  return value !== null && typeof value === "object" && "isError" in value && value.isError === true;
}

function mutationAuditEventIdsFrom(value: unknown): string[] {
  if (value === null || typeof value !== "object" || !("structuredContent" in value)) return [];
  const structuredContent = value.structuredContent;
  if (
    structuredContent === null ||
    typeof structuredContent !== "object" ||
    !("auditEventIds" in structuredContent) ||
    !Array.isArray(structuredContent.auditEventIds)
  ) return [];
  return structuredContent.auditEventIds.filter((eventId): eventId is string => typeof eventId === "string");
}




