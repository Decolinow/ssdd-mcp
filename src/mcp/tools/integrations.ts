import { z } from "zod";
import { listGithubReferences } from "../../application/github-webhooks.js";
import { assertExternalWorkItemImportApplyAuthorization, applyExternalWorkItemImport, previewExternalWorkItemImport } from "../../application/external-work-item-imports.js";
import { configuredGithubIssues, configuredAzureDevOpsWorkItems, toToolError, toolResult } from "../tool-support.js";
import type { McpToolContext } from "../tool-context.js";

export function registerIntegrationTools(context: McpToolContext): void {
  const { server, database, principalId, githubRepositories, githubIssueTokens, azureDevOpsConnections } = context;
  server.registerTool(
    "github_reference_list",
    {
      title: "Listar referências GitHub",
      description: "Lista os PRs e execuções de workflow concluídas mais recentes observados para o projeto ou item, sem alterar estados ou certificações.",
      inputSchema: z.object({
        projectId: z.string().uuid(),
        workItemIdOrKey: z.string().trim().min(1).max(80).optional(),
        limit: z.number().int().min(1).max(100).optional(),
      }),
      outputSchema: z.object({
        pullRequests: z.array(z.object({
          repository: z.string(),
          number: z.number().int().positive(),
          url: z.string().url(),
          title: z.string(),
          state: z.enum(["open", "closed"]),
          merged: z.boolean(),
          draft: z.boolean(),
          headBranch: z.string(),
          headSha: z.string(),
          baseBranch: z.string(),
          baseSha: z.string(),
          workItemId: z.string().uuid().nullable(),
          workItemKey: z.string().nullable(),
          receivedAt: z.string().datetime(),
        })),
        workflowRuns: z.array(z.object({
          repository: z.string(),
          id: z.string(),
          number: z.number().int().positive(),
          name: z.string().nullable(),
          status: z.string(),
          conclusion: z.string().nullable(),
          url: z.string().url(),
          headBranch: z.string(),
          headSha: z.string(),
          pullRequestNumbers: z.array(z.number().int().positive()),
          workItemId: z.string().uuid().nullable(),
          workItemKey: z.string().nullable(),
          receivedAt: z.string().datetime(),
        })),
      }),
    },
    ({ projectId, workItemIdOrKey, limit }) => {
      try {
        const references = listGithubReferences(database, {
          projectId,
          principalId,
          ...(workItemIdOrKey === undefined ? {} : { workItemIdOrKey }),
          ...(limit === undefined ? {} : { limit }),
        });
        return toolResult(references);
      } catch (error) {
        return toToolError(error);
      }
    },
  );

  const githubImportItemSchema = z.object({
    externalId: z.string(),
    number: z.number().int().positive(),
    sourceType: z.string().nullable(),
    title: z.string(),
    state: z.string(),
    action: z.enum(["create", "already_imported", "linked_elsewhere", "skipped"]),
    reason: z.string().nullable(),
    workItemId: z.string().uuid().nullable(),
    workItemKey: z.string().nullable(),
    titleTruncated: z.boolean(),
    descriptionTruncated: z.boolean(),
    sourceChanged: z.boolean(),
  });
  const githubImportPreviewSchema = z.object({
    planHash: z.string().length(64),
    provider: z.literal("github"),
    externalScope: z.string(),
    parentFeatureId: z.string().uuid(),
    workItemType: z.enum(["story", "bug"]),
    externalWorkItemType: z.enum(["User Story", "Bug"]).nullable(),
    total: z.number().int().nonnegative(),
    toCreate: z.number().int().nonnegative(),
    alreadyImported: z.number().int().nonnegative(),
    sourceChanged: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
    items: z.array(githubImportItemSchema),
  });

  const azureImportPreviewSchema = z.object({
    planHash: z.string().length(64),
    provider: z.literal("azure-devops"),
    externalScope: z.string(),
    parentFeatureId: z.string().uuid(),
    workItemType: z.enum(["story", "bug"]),
    externalWorkItemType: z.enum(["User Story", "Bug"]).nullable(),
    total: z.number().int().nonnegative(),
    toCreate: z.number().int().nonnegative(),
    alreadyImported: z.number().int().nonnegative(),
    sourceChanged: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
    items: z.array(githubImportItemSchema),
  });

  server.registerTool(
    "github_issue_import_preview",
    {
      title: "Pré-visualizar importação de issues GitHub",
      description: "Consulta até 100 issues do repositório mapeado e mostra o plano sem gravar no SSDD ou enviar alterações ao GitHub.",
      inputSchema: z.object({
        projectId: z.string().uuid(),
        parentFeatureIdOrKey: z.string().trim().min(1).max(80),
        workItemType: z.enum(["story", "bug"]),
        limit: z.number().int().min(1).max(100).optional(),
      }),
      outputSchema: githubImportPreviewSchema,
    },
    async ({ projectId, parentFeatureIdOrKey, workItemType, limit }) => {
      try {
        const { repository, sources } = await configuredGithubIssues(
          database,
          principalId,
          projectId,
          githubRepositories,
          githubIssueTokens,
          limit,
        );
        const preview = previewExternalWorkItemImport(database, {
          projectId,
          principalId,
          provider: "github",
          externalScope: repository,
          parentFeatureIdOrKey,
          workItemType,
          sources,
        });
        return toolResult(preview);
      } catch (error) {
        return toToolError(error);
      }
    },
  );

  server.registerTool(
    "github_issue_import_apply",
    {
      title: "Importar issues GitHub",
      description: "Aplica um plano pré-visualizado com confirmação humana PO; refaz a consulta e recusa alterações no plano antes de criar PBIs Draft.",
      inputSchema: z.object({
        projectId: z.string().uuid(),
        parentFeatureIdOrKey: z.string().trim().min(1).max(80),
        workItemType: z.enum(["story", "bug"]),
        expectedPlanHash: z.string().regex(/^[a-f0-9]{64}$/u),
        requestId: z.string().trim().min(1).max(128),
        limit: z.number().int().min(1).max(100).optional(),
      }),
      outputSchema: z.object({
        imported: z.array(z.object({ externalId: z.string(), workItemId: z.string().uuid(), workItemKey: z.string() })),
        alreadyImported: z.number().int().nonnegative(),
        sourceSnapshotsAdded: z.number().int().nonnegative(),
        skipped: z.number().int().nonnegative(),
        planHash: z.string().length(64),
      }),
    },
    async ({ projectId, parentFeatureIdOrKey, workItemType, expectedPlanHash, requestId, limit }) => {
      try {
        assertExternalWorkItemImportApplyAuthorization(database, projectId, principalId);
        const { repository, sources } = await configuredGithubIssues(
          database,
          principalId,
          projectId,
          githubRepositories,
          githubIssueTokens,
          limit,
        );
        const result = applyExternalWorkItemImport(database, {
          projectId,
          principalId,
          provider: "github",
          externalScope: repository,
          parentFeatureIdOrKey,
          workItemType,
          sources,
          expectedPlanHash,
          requestId,
        });
        return toolResult(result);
      } catch (error) {
        return toToolError(error);
      }
    },
  );

  server.registerTool(
    "azure_work_item_import_preview",
    {
      title: "Pré-visualizar importação do Azure Boards",
      description: "Consulta User Story ou Bug do projeto Azure mapeado, mostra o mapeamento local e gera um plano sem gravar no SSDD ou alterar o Azure.",
      inputSchema: z.object({
        projectId: z.string().uuid(),
        parentFeatureIdOrKey: z.string().trim().min(1).max(80),
        azureWorkItemType: z.enum(["User Story", "Bug"]),
        limit: z.number().int().min(1).max(100).optional(),
      }),
      outputSchema: azureImportPreviewSchema,
    },
    async ({ projectId, parentFeatureIdOrKey, azureWorkItemType, limit }) => {
      try {
        const { externalScope, sources } = await configuredAzureDevOpsWorkItems(
          database,
          principalId,
          projectId,
          azureDevOpsConnections,
          azureWorkItemType,
          limit,
        );
        const preview = previewExternalWorkItemImport(database, {
          projectId,
          principalId,
          provider: "azure-devops",
          externalScope,
          parentFeatureIdOrKey,
          workItemType: azureWorkItemType === "User Story" ? "story" : "bug",
          externalWorkItemType: azureWorkItemType,
          sources,
        });
        return toolResult(preview);
      } catch (error) {
        return toToolError(error);
      }
    },
  );

  server.registerTool(
    "azure_work_item_import_apply",
    {
      title: "Importar work items do Azure Boards",
      description: "Aplica um plano pré-visualizado com PO humano; refaz WIQL e a leitura em lote, exige hash vigente e cria PBIs Draft sem escrever no Azure.",
      inputSchema: z.object({
        projectId: z.string().uuid(),
        parentFeatureIdOrKey: z.string().trim().min(1).max(80),
        azureWorkItemType: z.enum(["User Story", "Bug"]),
        expectedPlanHash: z.string().regex(/^[a-f0-9]{64}$/u),
        requestId: z.string().trim().min(1).max(128),
        limit: z.number().int().min(1).max(100).optional(),
      }),
      outputSchema: z.object({
        imported: z.array(z.object({ externalId: z.string(), workItemId: z.string().uuid(), workItemKey: z.string() })),
        alreadyImported: z.number().int().nonnegative(),
        sourceSnapshotsAdded: z.number().int().nonnegative(),
        skipped: z.number().int().nonnegative(),
        planHash: z.string().length(64),
      }),
    },
    async ({ projectId, parentFeatureIdOrKey, azureWorkItemType, expectedPlanHash, requestId, limit }) => {
      try {
        assertExternalWorkItemImportApplyAuthorization(database, projectId, principalId);
        const { externalScope, sources } = await configuredAzureDevOpsWorkItems(
          database,
          principalId,
          projectId,
          azureDevOpsConnections,
          azureWorkItemType,
          limit,
        );
        const result = applyExternalWorkItemImport(database, {
          projectId,
          principalId,
          provider: "azure-devops",
          externalScope,
          parentFeatureIdOrKey,
          workItemType: azureWorkItemType === "User Story" ? "story" : "bug",
          externalWorkItemType: azureWorkItemType,
          sources,
          expectedPlanHash,
          requestId,
        });
        return toolResult(result);
      } catch (error) {
        return toToolError(error);
      }
    },
  );

}
