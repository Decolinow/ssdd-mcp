import { ResourceTemplate } from "@modelcontextprotocol/server";
import { getSpecification } from "../../application/specification-queries.js";
import { getScenario } from "../../application/scenario-queries.js";
import { ApplicationError } from "../../application/errors.js";
import { getTaskContext, readTestRunResource, readWorkItemRevisionResource, taskContextProfiles, taskContextSections } from "../../application/task-context.js";
import type { McpToolContext } from "../tool-context.js";

export function registerResourceHandlers(context: McpToolContext): void {
  const { server, database, principalId } = context;
  server.registerResource(
    "task-context",
    new ResourceTemplate("ssdd://projects/{projectId}/tasks/{taskIdOrKey}/context{?profile}", { list: undefined }),
    {
      title: "Contexto de tarefa",
      description: "Contexto filtrado por perfil, com baseline, fontes e paginação por orçamento.",
      mimeType: "application/json",
    },
    async (uri, variables) => {
      const profileValue = uri.searchParams.get("profile");
      const includeValue = uri.searchParams.get("include");
      const maxCharsValue = uri.searchParams.get("maxChars");
      const cursorValue = uri.searchParams.get("cursor");
      const result = getTaskContext(database, {
        projectId: String(variables.projectId),
        principalId,
        taskIdOrKey: String(variables.taskIdOrKey),
        ...(profileValue === null ? {} : { profile: profileValue as (typeof taskContextProfiles)[number] }),
        ...(includeValue === null ? {} : { include: includeValue.split(",") as (typeof taskContextSections)[number][] }),
        ...(maxCharsValue === null ? {} : { maxChars: Number(maxCharsValue) }),
        ...(cursorValue === null ? {} : { cursor: cursorValue }),
      });
      return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(result) }] };
    },
  );
  server.registerResource(
    "work-item-revision",
    new ResourceTemplate("ssdd://projects/{projectId}/work-items/{itemIdOrKey}/revisions/{revisionNumber}", { list: undefined }),
    { title: "Revisão publicada de PBI", mimeType: "application/json" },
    async (uri, variables) => {
      const revision = readWorkItemRevisionResource(
        database,
        String(variables.projectId),
        principalId,
        String(variables.itemIdOrKey),
        Number(variables.revisionNumber),
      );
      return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(revision) }] };
    },
  );
  server.registerResource(
    "specification-revision",
    new ResourceTemplate("ssdd://projects/{projectId}/specs/{specIdOrKey}/revisions/{revisionNumber}", { list: undefined }),
    { title: "Revisão publicada de especificação", mimeType: "application/json" },
    async (uri, variables) => {
      const specification = getSpecification(
        database,
        String(variables.projectId),
        principalId,
        String(variables.specIdOrKey),
      );
      const revisionNumber = Number(variables.revisionNumber);
      const revision = specification.revisions.find((entry) => entry.revisionNumber === revisionNumber && entry.status !== "draft" && entry.status !== "in_review");
      if (revision === undefined) throw new ApplicationError("NOT_FOUND", "Published specification revision was not found.");
      return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(revision) }] };
    },
  );
  server.registerResource(
    "scenario-revision",
    new ResourceTemplate("ssdd://projects/{projectId}/scenarios/{scenarioIdOrKey}/revisions/{revisionNumber}", { list: undefined }),
    { title: "Revisão publicada de cenário", mimeType: "application/json" },
    async (uri, variables) => {
      const scenario = getScenario(database, String(variables.projectId), principalId, String(variables.scenarioIdOrKey));
      const revisionNumber = Number(variables.revisionNumber);
      const revision = scenario.revisions.find((entry) => entry.revisionNumber === revisionNumber && entry.status !== "draft");
      if (revision === undefined) throw new ApplicationError("NOT_FOUND", "Published scenario revision was not found.");
      return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(revision) }] };
    },
  );
  server.registerResource(
    "test-run",
    new ResourceTemplate("ssdd://projects/{projectId}/test-runs/{runId}", { list: undefined }),
    { title: "Execução de teste", mimeType: "application/json" },
    async (uri, variables) => {
      const run = readTestRunResource(database, String(variables.projectId), principalId, String(variables.runId));
      return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(run) }] };
    },
  );

}
