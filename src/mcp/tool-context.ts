import type { McpServer } from "@modelcontextprotocol/server";
import type { GithubRepositoryMappings } from "../application/github-webhooks.js";
import type { TextEmbeddingProvider } from "../integrations/embeddings.js";
import type { AzureDevOpsConnections } from "../integrations/azure-devops-work-items.js";
import type { GithubIssueTokens } from "../integrations/github-issues.js";
import type { SqliteDatabase } from "../storage-sqlite/database.js";
import type { McpProfile } from "./profiles.js";

/** Shared closure of every tool-registration module (SSDD-953): the patched server plus per-connection state. */
export interface McpToolContext {
  readonly server: McpServer;
  readonly database: SqliteDatabase;
  readonly principalId: string;
  readonly profile: McpProfile;
  readonly isHostAdministrator: boolean;
  readonly githubRepositories: GithubRepositoryMappings;
  readonly githubIssueTokens: GithubIssueTokens;
  readonly azureDevOpsConnections: AzureDevOpsConnections;
  readonly embeddingProvider: TextEmbeddingProvider | undefined;
}
