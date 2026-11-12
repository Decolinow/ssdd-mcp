import { McpServer, ResourceTemplate } from "@modelcontextprotocol/server";
import { SkillsExtension } from "@modelcontextprotocol/server/ext/skills";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { nodeSkillFiles } from "@modelcontextprotocol/server/ext/skills/node";
import { z } from "zod";
import { existsSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { packageVersion } from "../package-version.js";
import { openSqliteDatabase } from "../storage-sqlite/database.js";
import { applyMigrations } from "../storage-sqlite/migrations.js";
import { getOrCreateLocalPrincipal, projectRoles } from "../application/local-identity.js";
import {
  createManagedUser,
  isInstanceAdministrator,
  listManagedUsers,
  resolvePrincipalFromAuthKey,
  revokeManagedUserAuthKeys,
  rotateManagedUserAuthKey,
  ensureBootstrapAdministrator,
} from "../application/user-management.js";
import {
  approvableMcpToolNames,
  assertMatchingToolApproval,
  consumeToolApproval,
  expectedVersionFromArguments,
  issueToolApproval,
  revokeToolApproval,
  type ApprovableMcpToolName,
} from "../application/command-approvals.js";
import type { JsonValue } from "../application/idempotent-command.js";
import { getProject, listProjects } from "../application/project-queries.js";
import { getProjectDashboardMetrics } from "../application/dashboard-metrics.js";
import { getProjectFeatureRoadmap, getTaskExecutionQueue } from "../application/prioritized-roadmap.js";
import { bindRoadmapItemId, listRoadmapItemIds, resolveRoadmapItemId } from "../application/roadmap-identifiers.js";
import {
  getDeveloperExecutionMetrics,
  listDeploymentEvents,
  listDevelopmentSessions,
  recordDeployment,
  startDevelopmentSession,
  transitionDevelopmentSession,
} from "../application/development-lifecycle.js";
import { linkTaskToAdr } from "../application/adr-commands.js";
import { startTaskDevelopment } from "../application/task-development-start.js";
import { getTaskWorkflow } from "../application/task-workflow-queries.js";
import { proposeTaskWorkflow, publishTaskWorkflow, transitionTaskWorkflowStep } from "../application/task-workflow-commands.js";
import { listMilestoneForecastHistory, recalculateMilestoneForecast } from "../application/forecast-queries.js";
import {
  listGithubReferences,
  readGithubRepositoriesFromEnvironment,
  type GithubRepositoryMappings,
} from "../application/github-webhooks.js";
import {
  assertExternalWorkItemImportApplyAuthorization,
  applyExternalWorkItemImport,
  previewExternalWorkItemImport,
  type ExternalWorkItemSource,
} from "../application/external-work-item-imports.js";
import {
  fetchGithubIssues,
  readGithubIssueTokensFromEnvironment,
  type GithubIssueTokens,
} from "../integrations/github-issues.js";
import {
  fetchAzureDevOpsWorkItems,
  readAzureDevOpsConnectionsFromEnvironment,
  type AzureDevOpsConnections,
  type AzureDevOpsWorkItemType,
} from "../integrations/azure-devops-work-items.js";
import { createWorkItem } from "../application/create-work-item.js";
import { getWorkItem, listWorkItemRevisions, listWorkItems } from "../application/work-item-queries.js";
import { getWorkItemQualityReport } from "../application/quality-queries.js";
import {
  addWorkItemComment,
  assignWorkItem,
  confirmWorkItemEstimate,
  listWorkItemComments,
  proposeWorkItemEstimate,
  rankWorkItem,
} from "../application/work-item-commands.js";
import {
  createSpecification,
  proposeSpecificationRevision,
  publishSpecificationRevision,
  withdrawSpecificationRevision,
} from "../application/specification-commands.js";
import { getSpecification, listSpecifications } from "../application/specification-queries.js";
import { specificationKinds, specificationRevisionStatuses } from "../domain/specifications.js";
import { traceLinkTypes } from "../domain/trace.js";
import { workItemStates, workItemTypes } from "../domain/work-items.js";
import { scenarioKinds, testRunResults } from "../domain/scenarios.js";
import { taskWorkflowRevisionStatuses, taskWorkflowStepStatuses } from "../domain/task-workflow.js";
import { addTraceLink, removeTraceLink } from "../application/trace-commands.js";
import { queryTraceGraph } from "../application/trace-queries.js";
import { proposeWorkItemRevision, publishWorkItemRevision } from "../application/work-item-revisions.js";
import {
  createScenario,
  proposeScenarioRevision,
  publishScenarioRevision,
  recordTestRun,
} from "../application/scenario-commands.js";
import { getScenario, listScenarios, listTestRunPage, searchScenariosByCriterion } from "../application/scenario-queries.js";
import { ApplicationError } from "../application/errors.js";
import {
  fixWorkItemBaseline,
  getWorkBaseline,
  listImpactFlags,
  revalidateWorkItemBaseline,
} from "../application/baseline-commands.js";
import {
  getTaskContext,
  readTestRunResource,
  readWorkItemRevisionResource,
  taskContextProfiles,
  taskContextSections,
} from "../application/task-context.js";
import {
  addWorkItemEvidence,
  certifyTestRun,
  getWorkItemGateReport,
  getTaskStartReadiness,
  listWorkItemEvidence,
  transitionWorkItem,
} from "../application/work-item-workflow.js";
import { createTeamCapacityConfiguration, getTeamCapacity, setTeamCapacityConfiguration } from "../application/team-capacity.js";
import { listProjectTeams } from "../application/team-directory.js";
import { changeMilestoneScope, createMilestone, getMilestone, listMilestones } from "../application/milestones.js";
import { evidenceKinds } from "../domain/workflow.js";
import { getDefinitionOfDone, setDefinitionOfDone } from "../application/definition-of-done.js";
import { cancelSprint, changeSprintScope, closeSprint, createSprintDraft, startSprint } from "../application/sprint-commands.js";
import { getSprint, listSprints } from "../application/sprint-queries.js";
import { getSprintRetrospective, setSprintRetrospective } from "../application/sprint-retrospectives.js";
import { sprintStates } from "../domain/sprints.js";
import { indexWorkItemSemantics, searchWorkItemsSemantically } from "../application/semantic-work-item-search.js";
import { readTextEmbeddingProviderFromEnvironment, type TextEmbeddingProvider } from "../integrations/embeddings.js";
import {
  mcpProfileAllowsPrompt,
  mcpProfileAllowsTool,
  mcpProfileSkillNames,
  mcpProfiles,
  parseMcpProfile,
  type McpProfile,
} from "./profiles.js";
import { normalizeItemParameterAlias, withItemParameterAlias } from "./item-parameter-alias.js";
import { withToolAnnotations } from "./tool-annotations.js";

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

const projectListItemSchema = z.object({
  id: z.string().uuid(),
  key: z.string(),
  name: z.string(),
  timezone: z.string(),
  version: z.number().int().positive(),
  roles: z.array(z.string()),
});

const projectDetailsSchema = projectListItemSchema.extend({
  productGoal: z.string(),
  createdAt: z.string().datetime(),
});

const userProjectAccessSchema = z.object({
  projectId: z.string().uuid(),
  roles: z.array(z.enum(projectRoles)).min(1).max(projectRoles.length),
});
const managedUserReceiptSchema = z.object({
  principalId: z.string().uuid(),
  displayName: z.string(),
  principalType: z.enum(["human", "agent", "service"]),
  projects: z.array(userProjectAccessSchema),
  authKeyId: z.string().uuid().nullable(),
  authKey: z.string().nullable(),
  authKeyIssued: z.boolean(),
  replayed: z.boolean(),
});
const managedUsersSchema = z.object({
  users: z.array(z.object({
    principalId: z.string().uuid(),
    displayName: z.string(),
    principalType: z.enum(["human", "agent", "service"]),
    createdAt: z.string().datetime(),
    isInstanceAdministrator: z.boolean(),
    projects: z.array(userProjectAccessSchema),
    authKeys: z.array(z.object({
      keyId: z.string().uuid(),
      prefix: z.string(),
      createdAt: z.string().datetime(),
      lastUsedAt: z.string().datetime().nullable(),
      revokedAt: z.string().datetime().nullable(),
    })),
  })),
});

const criterionSchema = z.object({
  id: z.string().uuid(),
  key: z.string(),
  description: z.string(),
  required: z.boolean(),
  position: z.number().int().positive(),
});

const workItemEstimateSchema = z.object({
  unit: z.enum(["points", "hours"]),
  value: z.number().int().positive(),
  proposalId: z.string().uuid(),
  confirmedByPrincipalId: z.string().uuid(),
  confirmedAt: z.string().datetime(),
});

const workItemEstimateProposalSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  itemId: z.string().uuid(),
  unit: z.enum(["points", "hours"]),
  value: z.number().int().positive(),
  rationale: z.string(),
  status: z.enum(["pending", "confirmed", "rejected", "superseded"]),
  proposedByPrincipalId: z.string().uuid(),
  proposedAt: z.string().datetime(),
  resolvedByPrincipalId: z.string().uuid().nullable(),
  resolvedAt: z.string().datetime().nullable(),
});

const workItemCommentSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  itemId: z.string().uuid(),
  authorPrincipalId: z.string().uuid(),
  body: z.string(),
  createdAt: z.string().datetime(),
});

const workItemSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  key: z.string(),
  type: z.enum(workItemTypes),
  parentId: z.string().uuid().nullable(),
  relatedStoryId: z.string().uuid().nullable(),
  assigneeId: z.string().uuid().nullable(),
  title: z.string(),
  description: z.string().nullable(),
  state: z.string(),
  priority: z.number().int().min(1).max(4),
  businessValueScore: z.number().int().min(0).max(100).nullable(),
  businessValueRationale: z.string().nullable(),
  rank: z.number().int().positive(),
  version: z.number().int().positive(),
  revision: z.number().int().positive(),
  createdByPrincipalId: z.string().uuid(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  criteria: z.array(criterionSchema),
  estimates: z.array(workItemEstimateSchema),
});

const workItemContentRevisionSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  itemId: z.string().uuid(),
  revisionNumber: z.number().int().positive(),
  status: z.enum(["draft", "published", "superseded"]),
  snapshot: z.object({
    type: z.enum(workItemTypes),
    parentId: z.string().uuid().nullable(),
    relatedStoryId: z.string().uuid().nullable(),
    title: z.string(),
    description: z.string().nullable(),
    priority: z.number().int().min(1).max(4),
    businessValueScore: z.number().int().min(0).max(100).nullable(),
    businessValueRationale: z.string().nullable(),
    criteria: z.array(criterionSchema),
  }),
  createdByPrincipalId: z.string().uuid(),
  createdAt: z.string().datetime(),
  publishedByPrincipalId: z.string().uuid().nullable(),
  publishedAt: z.string().datetime().nullable(),
});

const scenarioStepSchema = z.object({ action: z.string(), expected: z.string() });
const scenarioCoverageTargetSchema = z.object({
  targetType: z.enum(["criterion", "specification"]),
  targetId: z.string().uuid(),
});
const scenarioSnapshotSchema = z.object({
  title: z.string(),
  preconditions: z.array(z.string()),
  steps: z.array(scenarioStepSchema),
  coverage: z.array(scenarioCoverageTargetSchema),
});
const scenarioRevisionSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  scenarioId: z.string().uuid(),
  key: z.string(),
  kind: z.enum(scenarioKinds),
  revisionNumber: z.number().int().positive(),
  status: z.enum(["draft", "published", "superseded"]),
  snapshot: scenarioSnapshotSchema,
  createdByPrincipalId: z.string().uuid(),
  createdAt: z.string().datetime(),
  publishedByPrincipalId: z.string().uuid().nullable(),
  publishedAt: z.string().datetime().nullable(),
});
const scenarioSummarySchema = z.object({
  id: z.string().uuid(),
  key: z.string(),
  kind: z.enum(scenarioKinds),
  title: z.string(),
  version: z.number().int().positive(),
  latestRevision: z.number().int().nonnegative(),
  publishedRevision: z.number().int().positive().nullable(),
});
const scenarioSchema = scenarioSummarySchema.extend({
  projectId: z.string().uuid(),
  createdByPrincipalId: z.string().uuid(),
  createdAt: z.string().datetime(),
  revisions: z.array(scenarioRevisionSchema),
});
const testRunSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  scenarioId: z.string().uuid(),
  scenarioKey: z.string(),
  revisionNumber: z.number().int().positive(),
  buildId: z.string(),
  result: z.enum(testRunResults),
  notes: z.string().nullable(),
  evidenceUri: z.string().nullable(),
  executedByPrincipalId: z.string().uuid(),
  executedAt: z.string().datetime(),
});
const testRunPageSchema = z.object({
  runs: z.array(testRunSchema),
  nextCursor: z.string().nullable(),
  watermark: z.number().int().nonnegative(),
});
const workflowGateSchema = z.object({
  id: z.string(),
  passed: z.boolean(),
  message: z.string(),
  details: z.unknown().optional(),
});
const workItemGateReportSchema = z.object({
  itemId: z.string().uuid(),
  itemKey: z.string(),
  itemType: z.enum(workItemTypes),
  currentState: z.string(),
  targetState: z.enum(["ready", "done"]),
  buildId: z.string().nullable(),
  gates: z.array(workflowGateSchema),
  canProceed: z.boolean(),
  transitionPath: z.array(z.string()),
  warnings: z.array(z.object({ code: z.string(), message: z.string() })),
});
const workItemEvidenceSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  itemId: z.string().uuid(),
  itemKey: z.string(),
  baselineId: z.string().uuid().nullable(),
  kind: z.enum(evidenceKinds),
  uri: z.string(),
  buildId: z.string().nullable(),
  description: z.string(),
  addedByPrincipalId: z.string().uuid(),
  createdAt: z.string().datetime(),
});
const workItemTransitionSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  itemId: z.string().uuid(),
  itemKey: z.string(),
  fromState: z.enum(workItemStates),
  toState: z.enum(workItemStates),
  itemVersion: z.number().int().positive(),
  baselineId: z.string().uuid().nullable(),
  buildId: z.string().nullable(),
  reason: z.string(),
  transitionedByPrincipalId: z.string().uuid(),
  transitionedAt: z.string().datetime(),
});
const testRunCertificationSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  itemId: z.string().uuid(),
  itemKey: z.string(),
  baselineId: z.string().uuid(),
  runId: z.string().uuid(),
  certifiedByPrincipalId: z.string().uuid(),
  reason: z.string(),
  certifiedAt: z.string().datetime(),
});
const teamCapacityConfigurationSchema = z.object({
  projectId: z.string().uuid(),
  teamId: z.string().uuid(),
  generationNumber: z.number().int().nonnegative(),
  version: z.number().int().positive(),
  teamName: z.string(),
  timezone: z.string(),
  hoursPerDay: z.number().positive().max(24),
  workingDays: z.array(z.number().int().min(1).max(7)),
  members: z.array(z.object({
    principalId: z.string().uuid(),
    displayName: z.string(),
    dedicationPercent: z.number().min(0).max(100),
    activeFrom: z.string().nullable(),
    activeUntil: z.string().nullable(),
  })),
  holidays: z.array(z.object({ date: z.string(), label: z.string() })),
  absences: z.array(z.object({
    principalId: z.string().uuid(),
    date: z.string(),
    hours: z.number().min(0).max(24),
    reason: z.string(),
  })),
  reason: z.string(),
  configuredByPrincipalId: z.string().uuid(),
  configuredAt: z.string().datetime(),
});
const teamCapacityReportSchema = z.object({
  projectId: z.string().uuid(),
  teamId: z.string().uuid(),
  generationNumber: z.number().int().nonnegative(),
  teamName: z.string(),
  version: z.number().int().positive(),
  timezone: z.string(),
  startDate: z.string(),
  endDate: z.string(),
  workdays: z.number().int().nonnegative(),
  totalHours: z.number().nonnegative(),
  members: z.array(z.object({
    principalId: z.string().uuid(),
    displayName: z.string(),
    dedicationPercent: z.number().min(0).max(100),
    activeFrom: z.string().nullable(),
    activeUntil: z.string().nullable(),
    activeWorkdays: z.number().int().nonnegative(),
    availableHours: z.number().nonnegative(),
    capacityLostToAbsenceHours: z.number().nonnegative(),
  })),
  daily: z.array(z.object({ date: z.string(), totalHours: z.number().nonnegative() })),
});
const teamSummarySchema = z.object({
  projectId: z.string().uuid(),
  teamId: z.string().uuid(),
  name: z.string().nullable(),
  isConfigured: z.boolean(),
  currentVersion: z.number().int().nonnegative(),
  currentGeneration: z.number().int().nonnegative(),
  memberCount: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
});
const teamCapacityInputFieldsSchema = z.object({
  teamName: z.string().trim().min(1).max(120),
  timezone: z.string().trim().min(1).max(100),
  hoursPerDay: z.number().positive().max(24),
  workingDays: z.array(z.number().int().min(1).max(7)).min(1).max(7),
  members: z.array(z.object({
    principalId: z.string().uuid(),
    dedicationPercent: z.number().min(0).max(100),
    activeFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    activeUntil: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  })).min(1).max(100),
  holidays: z.array(z.object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    label: z.string().trim().min(1).max(200),
  })).max(500).optional(),
  absences: z.array(z.object({
    principalId: z.string().uuid(),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    hours: z.number().min(0).max(24),
    reason: z.string().trim().min(1).max(200),
  })).max(5_000).optional(),
  reason: z.string().trim().min(1).max(1_000),
});
const milestoneScopeItemSchema = z.object({
  itemId: z.string().uuid(),
  itemKey: z.string(),
  title: z.string(),
  stateAtApproval: z.string(),
  currentState: z.string(),
  points: z.number().int().positive(),
  baselineId: z.string().uuid(),
  itemRevisionNumber: z.number().int().positive(),
});
const milestoneSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  key: z.string(),
  title: z.string(),
  goal: z.string(),
  targetDate: z.string(),
  version: z.number().int().positive(),
  createdByPrincipalId: z.string().uuid(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  reason: z.string(),
  scope: z.array(milestoneScopeItemSchema),
  scopeHistory: z.array(milestoneScopeItemSchema.extend({
    id: z.string().uuid(),
    sequence: z.number().int().positive(),
    action: z.enum(["add", "remove"]),
    reason: z.string(),
    changedByPrincipalId: z.string().uuid(),
    changedAt: z.string().datetime(),
  })),
});
const milestoneSummarySchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  key: z.string(),
  title: z.string(),
  goal: z.string(),
  targetDate: z.string(),
  version: z.number().int().positive(),
  scopeItemCount: z.number().int().nonnegative(),
  scopePoints: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
const definitionOfDoneRevisionSchema = z.object({
  projectId: z.string().uuid(),
  revisionNumber: z.number().int().positive(),
  criteria: z.array(z.object({ id: z.string().uuid(), description: z.string() })),
  reason: z.string(),
  createdByPrincipalId: z.string().uuid(),
  createdAt: z.string().datetime(),
});
const sprintScopeItemSchema = z.object({
  itemId: z.string().uuid(),
  itemKey: z.string(),
  title: z.string(),
  stateAtSelection: z.string(),
  currentState: z.string(),
  points: z.number().int().positive(),
  baselineId: z.string().uuid(),
  itemRevisionNumber: z.number().int().positive(),
});
const sprintStateTransitionSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  sprintId: z.string().uuid(),
  fromState: z.enum(sprintStates),
  toState: z.enum(sprintStates),
  sprintVersion: z.number().int().positive(),
  reason: z.string(),
  transitionedByPrincipalId: z.string().uuid(),
  transitionedAt: z.string().datetime(),
});
const sprintRetrospectiveActionSchema = z.object({
  id: z.string().uuid(),
  position: z.number().int().positive(),
  title: z.string(),
  ownerPrincipalId: z.string().uuid(),
  ownerDisplayName: z.string(),
  linkedWorkItemId: z.string().uuid().nullable(),
  linkedWorkItemKey: z.string().nullable(),
  linkedWorkItemTitle: z.string().nullable(),
});
const sprintRetrospectiveRevisionSchema = z.object({
  sprintId: z.string().uuid(),
  revisionNumber: z.number().int().positive(),
  version: z.number().int().positive(),
  summary: z.string(),
  keepDoing: z.array(z.string()),
  stopDoing: z.array(z.string()),
  tryNext: z.array(z.string()),
  actions: z.array(sprintRetrospectiveActionSchema),
  reason: z.string(),
  createdByPrincipalId: z.string().uuid(),
  createdAt: z.string().datetime(),
});
const sprintRetrospectiveReadSchema = z.object({
  sprint: z.object({
    id: z.string().uuid(),
    key: z.string(),
    title: z.string(),
    status: z.enum(sprintStates),
    closedAt: z.string().datetime().nullable(),
  }),
  version: z.number().int().nonnegative(),
  selectedRevisionNumber: z.number().int().positive().nullable(),
  retrospective: sprintRetrospectiveRevisionSchema.nullable(),
  history: z.array(z.object({
    revisionNumber: z.number().int().positive(),
    summary: z.string(),
    reason: z.string(),
    createdByPrincipalId: z.string().uuid(),
    createdAt: z.string().datetime(),
  })),
});
const sprintSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  key: z.string(),
  title: z.string(),
  goal: z.string(),
  startsOn: z.string(),
  endsOn: z.string(),
  status: z.enum(sprintStates),
  teamId: z.string().uuid(),
  capacityConfigVersion: z.number().int().positive(),
  definitionOfDoneRevision: z.number().int().positive(),
  version: z.number().int().positive(),
  createdByPrincipalId: z.string().uuid(),
  createdAt: z.string().datetime(),
  startedAt: z.string().datetime().nullable(),
  closedAt: z.string().datetime().nullable(),
  cancelledAt: z.string().datetime().nullable(),
  reason: z.string(),
  reviewSummary: z.string().nullable(),
  startedSnapshot: z.object({
    startedAt: z.string().datetime(),
    reason: z.string(),
    capacity: teamCapacityReportSchema,
    definitionOfDone: definitionOfDoneRevisionSchema,
    commitments: z.array(sprintScopeItemSchema),
  }).nullable(),
  closedSnapshot: z.object({
    closedAt: z.string().datetime(),
    reviewSummary: z.string(),
    acceptedItemIds: z.array(z.string().uuid()),
    acceptedItems: z.array(sprintScopeItemSchema),
    incompleteItems: z.array(sprintScopeItemSchema),
    definitionOfDone: definitionOfDoneRevisionSchema,
    start: z.object({
      startedAt: z.string().datetime(),
      reason: z.string(),
      capacity: teamCapacityReportSchema,
      definitionOfDone: definitionOfDoneRevisionSchema,
      commitments: z.array(sprintScopeItemSchema),
    }),
  }).nullable(),
  scope: z.array(sprintScopeItemSchema),
  scopeHistory: z.array(sprintScopeItemSchema.extend({
    id: z.string().uuid(),
    sequence: z.number().int().positive(),
    action: z.enum(["add", "remove"]),
    reason: z.string(),
    changedByPrincipalId: z.string().uuid(),
    changedAt: z.string().datetime(),
  })),
  transitions: z.array(sprintStateTransitionSchema),
});
const scenarioCoverageMatchSchema = z.object({
  scenario: z.object({
    id: z.string().uuid(),
    key: z.string(),
    kind: z.enum(scenarioKinds),
    title: z.string(),
  }),
  revision: scenarioRevisionSchema,
  resultsByBuild: z.array(testRunSchema),
});
const workItemQualityReportSchema = z.object({
  projectId: z.string().uuid(),
  itemId: z.string().uuid(),
  itemKey: z.string(),
  state: z.string(),
  version: z.number().int().positive(),
  mode: z.enum(["pinned", "preview"]),
  baseline: z.object({ id: z.string().uuid(), sequence: z.number().int().positive() }).nullable(),
  requiredCriteria: z.number().int().nonnegative(),
  coveredRequiredCriteria: z.number().int().nonnegative(),
  coveragePercent: z.number().int().min(0).max(100).nullable(),
  criteria: z.array(z.object({
    criterion: criterionSchema,
    covered: z.boolean(),
    scenarios: z.array(z.object({
      scenario: z.object({
        id: z.string().uuid(),
        key: z.string(),
        kind: z.enum(scenarioKinds),
        title: z.string(),
      }),
      revision: scenarioRevisionSchema,
      latestRuns: z.array(z.object({
        run: testRunSchema,
        certification: testRunCertificationSchema.nullable(),
      })),
    })),
  })),
  evidence: z.array(workItemEvidenceSchema),
  nextEvidenceCursor: z.string().nullable(),
});
const forecastStatusSchema = z.enum([
  "complete", "incomplete_scope", "blocked", "insufficient_data", "no_capacity", "zero_velocity", "forecast_ready",
]);
const forecastRecalculationSchema = z.object({
  forecastId: z.string().uuid(),
  algorithmVersion: z.string(),
  recalculatedAt: z.string().datetime(),
  status: forecastStatusSchema,
  percentiles: z.record(z.string(), z.unknown()),
  scenarios: z.array(z.record(z.string(), z.unknown())),
  probabilityOnTime: z.number().min(0).max(1).nullable(),
  seed: z.number().int().nullable(),
  simulationCount: z.number().int().positive().nullable(),
});
const scenarioContentInputSchema = z.object({
  title: z.string().trim().min(1).max(200),
  preconditions: z.array(z.string().trim().min(1).max(1_000)).max(20).optional(),
  steps: z.array(z.object({
    action: z.string().trim().min(1).max(2_000),
    expected: z.string().trim().min(1).max(2_000),
  })).min(1).max(100),
  coverage: z.array(z.object({
    targetType: z.enum(["criterion", "specification"]),
    reference: z.string().trim().min(1).max(120),
  })).max(100).optional(),
  workItemIdOrKeys: z.array(z.string().trim().min(1).max(120)).max(100).optional(),
});
const developmentSessionSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  itemId: z.string().uuid(),
  itemKey: z.string(),
  itemTitle: z.string(),
  developerPrincipalId: z.string().uuid(),
  developerName: z.string(),
  sessionReference: z.string().nullable(),
  status: z.enum(["active", "paused", "completed", "cancelled"]),
  startedAt: z.string().datetime(),
  endedAt: z.string().datetime().nullable(),
  activeSeconds: z.number().int().nonnegative(),
  version: z.number().int().positive(),
  taskWorkflowRevisionNumber: z.number().int().positive().nullable(),
  technicalSpecifications: z.array(z.object({ id: z.string().uuid(), key: z.string(), revisionNumber: z.number().int().positive() })),
  scenarios: z.array(z.object({ id: z.string().uuid(), key: z.string(), revisionNumber: z.number().int().positive() })),
});
const taskWorkflowStepSchema = z.object({
  id: z.string().uuid(), position: z.number().int().positive(), title: z.string(), description: z.string(),
  effortPercent: z.number().positive().max(100), status: z.enum(taskWorkflowStepStatuses),
  statusChangedAt: z.string().datetime().nullable(), statusChangedByPrincipalId: z.string().uuid().nullable(), statusReason: z.string().nullable(),
});
const taskWorkflowRevisionSchema = z.object({
  id: z.string().uuid(), projectId: z.string().uuid(), taskId: z.string().uuid(), taskKey: z.string(),
  revisionNumber: z.number().int().positive(), status: z.enum(taskWorkflowRevisionStatuses), reason: z.string(),
  createdByPrincipalId: z.string().uuid(), createdAt: z.string().datetime(),
  publishedByPrincipalId: z.string().uuid().nullable(), publishedAt: z.string().datetime().nullable(),
  steps: z.array(taskWorkflowStepSchema), progressPercent: z.number().min(0).max(100).nullable(),
  completedEffortPercent: z.number().min(0).max(100).nullable(), remainingEffortPercent: z.number().min(0).max(100).nullable(),
  allStepsDone: z.boolean().nullable(),
});
const taskWorkflowViewSchema = z.object({
  projectId: z.string().uuid(), taskId: z.string().uuid(), taskKey: z.string(), taskState: z.string(), taskVersion: z.number().int().positive(),
  latestRevisionNumber: z.number().int().nonnegative(),
  revisionHistory: z.array(z.object({ revisionNumber: z.number().int().positive(), status: z.enum(taskWorkflowRevisionStatuses), reason: z.string(), createdAt: z.string().datetime(), publishedAt: z.string().datetime().nullable() })),
  revisionHistoryTruncated: z.boolean(), workflow: taskWorkflowRevisionSchema.nullable(),
  draft: taskWorkflowRevisionSchema.nullable(), selectedRevision: taskWorkflowRevisionSchema.nullable(),
  selectedRevisionNumber: z.number().int().positive().nullable(), selectedRevisionIsCurrent: z.boolean(),
});
const deploymentEventSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  environment: z.enum(["homologation", "production"]),
  buildId: z.string(),
  releaseVersion: z.string().nullable(),
  pipelineRunId: z.string().nullable(),
  outcome: z.enum(["succeeded", "failed", "rolled_back"]),
  occurredAt: z.string().datetime(),
  principalId: z.string().uuid(),
  principalName: z.string(),
  rollbackOfEventId: z.string().uuid().nullable(),
  itemIds: z.array(z.string().uuid()),
  milestoneIds: z.array(z.string().uuid()),
  notes: z.string().nullable(),
});
const roadmapItemReferenceSchema = z.object({
  roadmapId: z.string().regex(/^SSDD-\d{3}$/u),
  projectId: z.string().uuid(),
  itemId: z.string().uuid(),
  itemKey: z.string(),
  title: z.string(),
  boundByPrincipalId: z.string().uuid(),
  boundAt: z.string().datetime(),
});
const baselineSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  itemId: z.string().uuid(),
  itemKey: z.string(),
  sequence: z.number().int().positive(),
  kind: z.enum(["ready", "revalidation"]),
  reason: z.string(),
  createdByPrincipalId: z.string().uuid(),
  createdAt: z.string().datetime(),
  references: z.array(z.object({
    entityType: z.enum(["work_item_revision", "specification_revision", "scenario_revision"]),
    entityId: z.string().uuid(),
    key: z.string(),
    revisionNumber: z.number().int().positive(),
    snapshot: z.unknown(),
  })),
});
const impactFlagSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  itemId: z.string().uuid(),
  itemKey: z.string(),
  baselineId: z.string().uuid(),
  specificationId: z.string().uuid(),
  specificationKey: z.string(),
  baselineRevision: z.number().int().positive(),
  publishedRevision: z.number().int().positive(),
  reason: z.string(),
  status: z.enum(["open", "revalidated"]),
  createdAt: z.string().datetime(),
  resolvedByPrincipalId: z.string().uuid().nullable(),
  resolvedAt: z.string().datetime().nullable(),
  revalidatedBaselineId: z.string().uuid().nullable(),
});

const workItemListItemSchema = z.object({
  id: z.string().uuid(),
  key: z.string(),
  type: z.enum(workItemTypes),
  parentId: z.string().uuid().nullable(),
  assigneeId: z.string().uuid().nullable(),
  title: z.string(),
  state: z.enum(workItemStates),
  priority: z.number().int().min(1).max(4),
  businessValueScore: z.number().int().min(0).max(100).nullable(),
  businessValueRationale: z.string().nullable(),
  rank: z.number().int().positive(),
  version: z.number().int().positive(),
  revision: z.number().int().positive(),
  updatedAt: z.string().datetime(),
  taskWorkflowRevisionNumber: z.number().int().positive().nullable(),
  taskWorkflowProgressPercent: z.number().min(0).max(100).nullable(),
  taskWorkflowCompletedSteps: z.number().int().nonnegative().nullable(),
  taskWorkflowTotalSteps: z.number().int().positive().nullable(),
});

const specificationContentSchema = z.record(z.string(), z.json()).refine(
  (content) => Object.keys(content).length > 0,
  "Specification content must be a non-empty JSON object.",
);

const specificationRevisionSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  specId: z.string().uuid(),
  key: z.string(),
  kind: z.enum(specificationKinds),
  title: z.string(),
  revisionNumber: z.number().int().positive(),
  status: z.enum(specificationRevisionStatuses),
  content: specificationContentSchema,
  createdByPrincipalId: z.string().uuid(),
  createdAt: z.string().datetime(),
  publishedByPrincipalId: z.string().uuid().nullable(),
  publishedAt: z.string().datetime().nullable(),
});

const specificationSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  key: z.string(),
  kind: z.enum(specificationKinds),
  title: z.string(),
  version: z.number().int().positive(),
  latestRevision: z.number().int().nonnegative(),
  latestStatus: z.enum(specificationRevisionStatuses).nullable(),
  publishedRevision: z.number().int().positive().nullable(),
  createdByPrincipalId: z.string().uuid(),
  createdAt: z.string().datetime(),
  revisions: z.array(specificationRevisionSchema),
});

const traceNodeSchema = z.object({
  id: z.string().uuid(),
  type: z.enum(["work_item", "specification"]),
  key: z.string(),
  title: z.string(),
});

const traceLinkReceiptSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  source: traceNodeSchema,
  target: traceNodeSchema,
  type: z.enum(traceLinkTypes),
  removedAt: z.string().datetime().nullable(),
});

const traceGraphSchema = z.object({
  root: traceNodeSchema,
  nodes: z.array(traceNodeSchema),
  links: z.array(z.object({
    id: z.string().uuid(),
    type: z.enum(traceLinkTypes),
    source: traceNodeSchema,
    target: traceNodeSchema,
    depth: z.number().int().positive(),
  })),
  truncated: z.boolean(),
});

const taskContextEntrySchema = z.object({
  section: z.enum(taskContextSections),
  key: z.string(),
  title: z.string(),
  source: z.object({
    entityType: z.enum(["work_item_revision", "specification_revision", "scenario_revision", "test_run"]),
    entityId: z.string(),
    key: z.string(),
    revisionNumber: z.number().int().positive().nullable(),
    mode: z.enum(["pinned", "current"]),
    relationship: z.enum(["parent_baseline", "hierarchy_link", "task_direct_link", "scenario_coverage", "task_run_link"]).optional(),
    traceLinkType: z.enum(["implements", "relates_to"]).optional(),
    pinSource: z.enum(["pbi_baseline", "development_session"]).optional(),
    uri: z.string().nullable(),
  }),
  content: z.unknown(),
});
const taskContextSchema = z.object({
  task: z.object({
    id: z.string().uuid(),
    key: z.string(),
    title: z.string(),
    state: z.string(),
    version: z.number().int().positive(),
    parentId: z.string().uuid().nullable(),
  }),
  profile: z.enum(taskContextProfiles),
  mode: z.enum(["pinned", "preview"]),
  baseline: z.object({
    id: z.string().uuid(),
    sequence: z.number().int().positive(),
    kind: z.enum(["ready", "revalidation"]),
  }).nullable(),
  sections: z.object({
    hierarchy: z.array(taskContextEntrySchema),
    acceptanceCriteria: z.array(taskContextEntrySchema),
    businessRules: z.array(taskContextEntrySchema),
    technicalDecisions: z.array(taskContextEntrySchema),
    scenarios: z.array(taskContextEntrySchema),
    testRuns: z.array(taskContextEntrySchema),
    baseline: z.array(taskContextEntrySchema),
  }),
  warnings: z.array(z.object({ code: z.string(), message: z.string(), key: z.string().optional() })),
  truncated: z.boolean(),
  nextCursor: z.string().nullable(),
});

const metricsObjectSchema = z.record(z.string(), z.unknown());
const dashboardMetricsSchema = z.object({
  projectId: z.string().uuid(),
  teams: z.array(teamSummarySchema),
  selectedTeamId: z.string().uuid().nullable(),
  selectedTeamGenerationNumber: z.number().int().min(0).nullable(),
  asOfDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
  observedAt: z.string().datetime(),
  watermarkSequence: z.number().int().min(0),
  selectedMilestoneId: z.string().uuid().nullable(),
  selectedSprintId: z.string().uuid().nullable(),
  forecastUnavailableReason: z.enum(["before_milestone_created"]).nullable(),
  milestones: z.array(metricsObjectSchema),
  sprints: z.array(metricsObjectSchema),
  milestoneMetrics: metricsObjectSchema.nullable(),
  forecast: metricsObjectSchema.nullable(),
  sprintMetrics: metricsObjectSchema.nullable(),
  velocity: metricsObjectSchema,
  wip: metricsObjectSchema,
  coverage: metricsObjectSchema,
});

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

  server.registerTool(
    "approval_issue",
    {
      title: "Autorizar uma execução de agente",
      description: "Admin humano aprova uma única chamada, vinculada ao projeto, ferramenta, argumentos, versão esperada e executor, por até dez minutos.",
      inputSchema: z.object({
        projectId: z.string().uuid(),
        requestId: z.string().trim().min(1).max(128),
        toolName: z.enum(approvableMcpToolNames),
        arguments: z.record(z.string(), z.json()),
        expectedVersion: z.number().int().min(0).nullable(),
        executorPrincipalId: z.string().uuid(),
        expiresInSeconds: z.number().int().min(30).max(600),
        reason: z.string().trim().min(1).max(500),
      }),
      outputSchema: z.object({
        approval: z.object({
          approvalId: z.string().uuid(),
          projectId: z.string().uuid(),
          toolName: z.enum(approvableMcpToolNames),
          argumentsHash: z.string().length(64),
          expectedVersion: z.number().int().min(0).nullable(),
          executorPrincipalId: z.string().uuid(),
          approvedByPrincipalId: z.string().uuid(),
          issuedAt: z.string().datetime(),
          expiresAt: z.string().datetime(),
          status: z.literal("pending"),
        }),
        auditEventIds: z.array(z.string().uuid()),
      }),
    },
    ({ projectId, requestId, toolName, arguments: toolArguments, expectedVersion, executorPrincipalId, expiresInSeconds, reason }) => {
      try {
        const receipt = issueToolApproval(database, {
          projectId,
          principalId,
          requestId,
          toolName: toolName as ApprovableMcpToolName,
          arguments: toolArguments as JsonValue,
          expectedVersion,
          executorPrincipalId,
          expiresInSeconds,
          reason,
        });
        const result = { approval: receipt.value, auditEventIds: receipt.auditEventIds };
        return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
      } catch (error) {
        return toToolError(error);
      }
    },
  );

  server.registerTool(
    "approval_revoke",
    {
      title: "Revogar aprovação de execução",
      description: "Revoga uma aprovação ainda pendente. Apenas um admin humano do projeto pode revogar; aprovações consumidas são imutáveis.",
      inputSchema: z.object({
        projectId: z.string().uuid(),
        requestId: z.string().trim().min(1).max(128),
        approvalId: z.string().uuid(),
        reason: z.string().trim().min(1).max(500),
      }),
      outputSchema: z.object({
        approval: z.object({
          approvalId: z.string().uuid(),
          status: z.literal("revoked"),
          revokedAt: z.string().datetime(),
        }),
        auditEventIds: z.array(z.string().uuid()),
      }),
    },
    ({ projectId, requestId, approvalId, reason }) => {
      try {
        const receipt = revokeToolApproval(database, { projectId, principalId, requestId, approvalId, reason });
        const result = { approval: receipt.value, auditEventIds: receipt.auditEventIds };
        return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
      } catch (error) {
        return toToolError(error);
      }
    },
  );

  server.registerTool(
    "task_context_get",
    {
      title: "Consultar contexto de tarefa",
      description: "Retorna contexto de PBI, regras, decisões, cenários e execuções selecionado para Dev, QA ou PO, com proveniência e paginação.",
      inputSchema: z.object({
        projectId: z.string().uuid(),
        taskIdOrKey: z.string().trim().min(1).max(80),
        profile: z.enum(taskContextProfiles).optional(),
        include: z.array(z.enum(taskContextSections)).max(taskContextSections.length).optional(),
        maxChars: z.number().int().min(2_000).max(30_000).optional(),
        cursor: z.string().max(4_096).optional(),
      }),
      outputSchema: taskContextSchema,
    },
    ({ projectId, taskIdOrKey, profile, include, maxChars, cursor }) => {
      try {
        const result = getTaskContext(database, {
          projectId,
          principalId,
          taskIdOrKey,
          ...(profile === undefined ? {} : { profile }),
          ...(include === undefined ? {} : { include }),
          ...(maxChars === undefined ? {} : { maxChars }),
          ...(cursor === undefined ? {} : { cursor }),
        });
        return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
      } catch (error) {
        return toToolError(error);
      }
    },
  );

  server.registerTool(
    "project_list",
    {
      title: "Listar projetos",
      description: "Lista os projetos aos quais a identidade local autenticada tem acesso.",
      inputSchema: z.object({}),
      outputSchema: z.object({ projects: z.array(projectListItemSchema) }),
    },
    async () => {
      try {
        const result = { projects: listProjects(database, principalId) };
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          structuredContent: result,
        };
      } catch (error) {
        return toToolError(error);
      }
    },
  );

  server.registerTool(
    "user_create",
    {
      title: "Criar usuário MCP",
      description: "Cria um principal, concede papéis por projeto e emite uma authKey aleatória de uso único. O segredo não é gravado em auditoria nem em registros de idempotência.",
      inputSchema: z.object({
        requestId: z.string().trim().min(1).max(128),
        displayName: z.string().trim().min(1).max(128),
        principalType: z.enum(["human", "agent", "service"]),
        projects: z.array(userProjectAccessSchema).min(1).max(100),
        reason: z.string().trim().min(1).max(500),
      }),
      outputSchema: managedUserReceiptSchema,
    },
    ({ requestId, displayName, principalType, projects, reason }) => {
      try {
        const receipt = createManagedUser(database, {
          actorPrincipalId: principalId, requestId, displayName, principalType, projects, reason,
        });
        return { content: [{ type: "text", text: JSON.stringify(receipt) }], structuredContent: receipt };
      } catch (error) { return toToolError(error); }
    },
  );

  server.registerTool(
    "user_list",
    {
      title: "Listar usuários MCP",
      description: "Lista identidades, acessos de projeto e metadados de chaves sem revelar segredos.",
      inputSchema: z.object({}),
      outputSchema: managedUsersSchema,
    },
    () => {
      try {
        const result = { users: listManagedUsers(database, principalId) };
        return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
      } catch (error) { return toToolError(error); }
    },
  );

  server.registerTool(
    "user_auth_key_rotate",
    {
      title: "Rotacionar authKey de usuário",
      description: "Revoga a chave ativa e emite uma substituta uma única vez. Uma repetição idempotente nunca devolve novamente o segredo.",
      inputSchema: z.object({
        requestId: z.string().trim().min(1).max(128),
        principalId: z.string().uuid(),
        reason: z.string().trim().min(1).max(500),
      }),
      outputSchema: managedUserReceiptSchema,
    },
    ({ requestId, principalId: targetPrincipalId, reason }) => {
      try {
        const receipt = rotateManagedUserAuthKey(database, {
          actorPrincipalId: principalId, targetPrincipalId, requestId, reason,
        });
        return { content: [{ type: "text", text: JSON.stringify(receipt) }], structuredContent: receipt };
      } catch (error) { return toToolError(error); }
    },
  );

  server.registerTool(
    "user_auth_key_revoke",
    {
      title: "Revogar authKey de usuário",
      description: "Revoga a chave ativa específica ou todas as chaves de um usuário para bloquear novas conexões.",
      inputSchema: z.object({
        requestId: z.string().trim().min(1).max(128),
        principalId: z.string().uuid(),
        keyId: z.string().uuid().optional(),
        reason: z.string().trim().min(1).max(500),
      }),
      outputSchema: z.object({ principalId: z.string().uuid(), revokedCount: z.number().int().nonnegative(), replayed: z.boolean() }),
    },
    ({ requestId, principalId: targetPrincipalId, keyId, reason }) => {
      try {
        const result = revokeManagedUserAuthKeys(database, {
          actorPrincipalId: principalId, targetPrincipalId, requestId,
          ...(keyId === undefined ? {} : { keyId }), reason,
        });
        return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
      } catch (error) { return toToolError(error); }
    },
  );

  server.registerTool(
    "roadmap_id_bind",
    {
      title: "Vincular ID estável do roadmap",
      description: "Registra uma associação imutável por projeto entre SSDD-### e a tarefa real do MCP, sem confundir o ID estável com a chave gerada do work item.",
      inputSchema: z.object({
        projectId: z.string().uuid(), requestId: z.string().trim().min(1).max(128),
        roadmapId: z.string().trim().regex(/^SSDD-\d{3}$/u), itemIdOrKey: z.string().trim().min(1).max(120),
      }),
      outputSchema: z.object({ roadmapItem: roadmapItemReferenceSchema, auditEventIds: z.array(z.string().uuid()) }),
    },
    ({ projectId, requestId, roadmapId, itemIdOrKey }) => {
      try {
        const receipt = bindRoadmapItemId(database, { projectId, principalId, requestId, roadmapId, itemIdOrKey });
        const result = { roadmapItem: receipt.value, auditEventIds: receipt.auditEventIds };
        return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
      } catch (error) { return toToolError(error); }
    },
  );

  server.registerTool(
    "roadmap_id_resolve",
    {
      title: "Resolver ID estável do roadmap",
      description: "Resolve SSDD-### para a identidade real da tarefa no projeto; use quando um plano ou dependência cita o ID estável do roadmap.",
      inputSchema: z.object({ projectId: z.string().uuid(), roadmapId: z.string().trim().regex(/^SSDD-\d{3}$/u) }),
      outputSchema: z.object({ roadmapItem: roadmapItemReferenceSchema }),
    },
    ({ projectId, roadmapId }) => {
      try {
        const result = { roadmapItem: resolveRoadmapItemId(database, { projectId, principalId, roadmapId }) };
        return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
      } catch (error) { return toToolError(error); }
    },
  );

  server.registerTool(
    "roadmap_id_list",
    {
      title: "Listar IDs estáveis do roadmap",
      description: "Lista o mapa de IDs documentados para UUIDs e chaves geradas no projeto.",
      inputSchema: z.object({ projectId: z.string().uuid() }),
      outputSchema: z.object({ roadmapItems: z.array(roadmapItemReferenceSchema) }),
    },
    ({ projectId }) => {
      try {
        const result = { roadmapItems: listRoadmapItemIds(database, { projectId, principalId }) };
        return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
      } catch (error) { return toToolError(error); }
    },
  );

  server.registerTool(
    "project_get",
    {
      title: "Consultar projeto",
      description: "Retorna a configuração do projeto pelo projectId retornado por project_list.",
      inputSchema: z.object({ projectId: z.string().uuid() }),
      outputSchema: z.object({ project: projectDetailsSchema }),
    },
    ({ projectId }) => {
      try {
        const result = { project: getProject(database, principalId, projectId) };
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          structuredContent: result,
        };
      } catch (error) {
        return toToolError(error);
      }
    },
  );

  server.registerTool(
    "baseline_fix",
    {
      title: "Fixar baseline",
      description: "Congela as revisões publicadas do item, especificações ligadas e cenários de cobertura quando o item está Ready.",
      inputSchema: z.object({
        projectId: z.string().uuid(),
        requestId: z.string().trim().min(1).max(128),
        itemIdOrKey: z.string().trim().min(1).max(80),
        expectedVersion: z.number().int().positive(),
        reason: z.string().trim().min(1).max(1_000),
      }),
      outputSchema: z.object({ baseline: baselineSchema, auditEventIds: z.array(z.string().uuid()) }),
    },
    ({ projectId, requestId, itemIdOrKey, expectedVersion, reason }) => {
      try {
        const receipt = fixWorkItemBaseline(database, {
          projectId, principalId, requestId, itemIdOrKey, expectedVersion, reason,
        });
        const result = { baseline: receipt.value, auditEventIds: receipt.auditEventIds };
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          structuredContent: result,
        };
      } catch (error) {
        return toToolError(error);
      }
    },
  );

  server.registerTool(
    "baseline_get",
    {
      title: "Consultar baseline",
      description: "Resolve o snapshot histórico por item e sequência; omitindo a sequência retorna a mais recente.",
      inputSchema: z.object({
        projectId: z.string().uuid(),
        itemIdOrKey: z.string().trim().min(1).max(80),
        sequence: z.number().int().positive().optional(),
      }),
      outputSchema: z.object({ baseline: baselineSchema }),
    },
    ({ projectId, itemIdOrKey, sequence }) => {
      try {
        const result = { baseline: getWorkBaseline(database, projectId, principalId, itemIdOrKey, sequence) };
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          structuredContent: result,
        };
      } catch (error) {
        return toToolError(error);
      }
    },
  );

  server.registerTool(
    "impact_list",
    {
      title: "Listar impactos",
      description: "Lista impactos abertos e revalidados causados por publicação de especificações após Ready.",
      inputSchema: z.object({
        projectId: z.string().uuid(),
        itemIdOrKey: z.string().trim().min(1).max(80),
        status: z.enum(["open", "revalidated"]).optional(),
      }),
      outputSchema: z.object({ impacts: z.array(impactFlagSchema) }),
    },
    ({ projectId, itemIdOrKey, status }) => {
      try {
        const result = { impacts: listImpactFlags(database, projectId, principalId, itemIdOrKey, status) };
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          structuredContent: result,
        };
      } catch (error) {
        return toToolError(error);
      }
    },
  );

  server.registerTool(
    "baseline_revalidate",
    {
      title: "Revalidar baseline",
      description: "Cria nova baseline com revisões vigentes e resolve os impactos cobertos por ela.",
      inputSchema: z.object({
        projectId: z.string().uuid(),
        requestId: z.string().trim().min(1).max(128),
        itemIdOrKey: z.string().trim().min(1).max(80),
        expectedVersion: z.number().int().positive(),
        reason: z.string().trim().min(1).max(1_000),
      }),
      outputSchema: z.object({
        baseline: baselineSchema,
        resolvedImpactIds: z.array(z.string().uuid()),
        auditEventIds: z.array(z.string().uuid()),
      }),
    },
    ({ projectId, requestId, itemIdOrKey, expectedVersion, reason }) => {
      try {
        const receipt = revalidateWorkItemBaseline(database, {
          projectId, principalId, requestId, itemIdOrKey, expectedVersion, reason,
        });
        const result = { ...receipt.value, auditEventIds: receipt.auditEventIds };
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          structuredContent: result,
        };
      } catch (error) {
        return toToolError(error);
      }
    },
  );

  server.registerTool(
    "work_item_create",
    {
      title: "Criar item de trabalho",
      description:
        "Cria épico, funcionalidade, história, bug ou tarefa, validando hierarquia e auditando a alteração.",
      inputSchema: z.object({
        projectId: z.string().uuid(),
        requestId: z.string().trim().min(1).max(128),
        type: z.enum(workItemTypes),
        parentId: z.string().trim().min(1).optional(),
        relatedStoryId: z.string().trim().min(1).optional(),
        title: z.string().trim().min(1).max(200),
        description: z.string().max(10_000).optional(),
        priority: z.number().int().min(1).max(4).optional(),
        businessValueScore: z.number().int().min(0).max(100).nullable().optional(),
        businessValueRationale: z.string().trim().max(1000).nullable().optional(),
        criteria: z
          .array(z.object({ description: z.string().trim().min(1).max(2_000), required: z.boolean().optional() }))
          .max(50)
          .optional(),
      }),
      outputSchema: z.object({
        workItem: workItemSchema,
        auditEventIds: z.array(z.string().uuid()),
      }),
    },
    ({ projectId, requestId, type, parentId, relatedStoryId, title, description, priority, businessValueScore, businessValueRationale, criteria }) => {
      try {
        const receipt = createWorkItem(database, {
          projectId,
          principalId,
          requestId,
          type,
          title,
          ...(parentId === undefined ? {} : { parentId }),
          ...(relatedStoryId === undefined ? {} : { relatedStoryId }),
          ...(description === undefined ? {} : { description }),
          ...(priority === undefined ? {} : { priority }),
          ...(businessValueScore === undefined ? {} : { businessValueScore }),
          ...(businessValueRationale === undefined ? {} : { businessValueRationale }),
          ...(criteria === undefined ? {} : { criteria }),
        });
        const result = { workItem: receipt.value, auditEventIds: receipt.auditEventIds };
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          structuredContent: result,
        };
      } catch (error) {
        return toToolError(error);
      }
    },
  );

  server.registerTool(
    "work_item_get",
    {
      title: "Consultar item de trabalho",
      description: "Consulta um item pelo UUID ou chave legível, como PAY-12.",
      inputSchema: z.object({
        projectId: z.string().uuid(),
        itemIdOrKey: z.string().trim().min(1).max(80),
      }),
      outputSchema: z.object({ workItem: workItemSchema }),
    },
    ({ projectId, itemIdOrKey }) => {
      try {
        const result = { workItem: getWorkItem(database, projectId, principalId, itemIdOrKey) };
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          structuredContent: result,
        };
      } catch (error) {
        return toToolError(error);
      }
    },
  );

  server.registerTool(
    "work_item_revision_list",
    {
      title: "Listar revisões de item",
      description: "Lista revisões imutáveis de conteúdo e indica qual versão está em rascunho ou publicada.",
      inputSchema: z.object({
        projectId: z.string().uuid(),
        itemIdOrKey: z.string().trim().min(1).max(80),
      }),
      outputSchema: z.object({ revisions: z.array(workItemContentRevisionSchema) }),
    },
    ({ projectId, itemIdOrKey }) => {
      try {
        const result = { revisions: listWorkItemRevisions(database, projectId, principalId, itemIdOrKey) };
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          structuredContent: result,
        };
      } catch (error) {
        return toToolError(error);
      }
    },
  );

  server.registerTool(
    "work_item_revision_propose",
    {
      title: "Propor revisão de item",
      description: "Cria snapshot candidato sem alterar o conteúdo publicado; critérios existentes preservam seus IDs.",
      inputSchema: z.object({
        projectId: z.string().uuid(),
        requestId: z.string().trim().min(1).max(128),
        itemIdOrKey: z.string().trim().min(1).max(80),
        expectedVersion: z.number().int().positive(),
        title: z.string().trim().min(1).max(200).optional(),
        description: z.string().max(10_000).nullable().optional(),
        priority: z.number().int().min(1).max(4).optional(),
        businessValueScore: z.number().int().min(0).max(100).nullable().optional(),
        businessValueRationale: z.string().trim().max(1000).nullable().optional(),
        criteria: z.array(z.object({
          id: z.string().uuid().optional(),
          description: z.string().trim().min(1).max(2_000),
          required: z.boolean().optional(),
        })).max(50).optional(),
      }),
      outputSchema: z.object({
        revision: workItemContentRevisionSchema,
        version: z.number().int().positive(),
        auditEventIds: z.array(z.string().uuid()),
      }),
    },
    ({ projectId, requestId, itemIdOrKey, expectedVersion, title, description, priority, businessValueScore, businessValueRationale, criteria }) => {
      try {
        const receipt = proposeWorkItemRevision(database, {
          projectId,
          principalId,
          requestId,
          itemIdOrKey,
          expectedVersion,
          ...(title === undefined ? {} : { title }),
          ...(description === undefined ? {} : { description }),
          ...(priority === undefined ? {} : { priority }),
          ...(businessValueScore === undefined ? {} : { businessValueScore }),
          ...(businessValueRationale === undefined ? {} : { businessValueRationale }),
          ...(criteria === undefined
            ? {}
            : {
                criteria: criteria.map((criterion) => ({
                  ...(criterion.id === undefined ? {} : { id: criterion.id }),
                  description: criterion.description,
                  ...(criterion.required === undefined ? {} : { required: criterion.required }),
                })),
              }),
        });
        const result = { revision: receipt.value, version: currentItemVersion(database, projectId, receipt.value.itemId), auditEventIds: receipt.auditEventIds };
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          structuredContent: result,
        };
      } catch (error) {
        return toToolError(error);
      }
    },
  );

  server.registerTool(
    "work_item_revision_publish",
    {
      title: "Publicar revisão de item",
      description: "Publica o rascunho mais recente com confirmação humana PO e atualiza o conteúdo corrente do item.",
      inputSchema: z.object({
        projectId: z.string().uuid(),
        requestId: z.string().trim().min(1).max(128),
        itemIdOrKey: z.string().trim().min(1).max(80),
        revisionNumber: z.number().int().positive(),
        expectedVersion: z.number().int().positive(),
      }),
      outputSchema: z.object({
        revision: workItemContentRevisionSchema,
        version: z.number().int().positive(),
        auditEventIds: z.array(z.string().uuid()),
      }),
    },
    ({ projectId, requestId, itemIdOrKey, revisionNumber, expectedVersion }) => {
      try {
        const receipt = publishWorkItemRevision(database, {
          projectId,
          principalId,
          requestId,
          itemIdOrKey,
          revisionNumber,
          expectedVersion,
        });
        const result = { revision: receipt.value, version: currentItemVersion(database, projectId, receipt.value.itemId), auditEventIds: receipt.auditEventIds };
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          structuredContent: result,
        };
      } catch (error) {
        return toToolError(error);
      }
    },
  );

  server.registerTool(
    "work_item_list",
    {
      title: "Listar itens de trabalho",
      description:
        "Lista itens com filtros combináveis, busca textual e cursor estável. assignedToMe=true limita aos itens atribuídos à identidade autenticada.",
      inputSchema: z.object({
        projectId: z.string().uuid(),
        types: z.array(z.enum(workItemTypes)).max(5).optional(),
        states: z.array(z.enum(workItemStates)).max(7).optional(),
        parentId: z.string().trim().min(1).max(80).optional(),
        search: z.string().trim().min(1).max(200).optional(),
        assignedToMe: z.boolean().optional(),
        limit: z.number().int().min(1).max(100).optional(),
        cursor: z.string().min(1).max(4096).optional(),
      }),
      outputSchema: z.object({
        items: z.array(workItemListItemSchema),
        nextCursor: z.string().nullable(),
      }),
    },
    ({ projectId, types, states, parentId, search, assignedToMe, limit, cursor }) => {
      try {
        const page = listWorkItems(database, {
          projectId,
          principalId,
          ...(types === undefined ? {} : { types }),
          ...(states === undefined ? {} : { states }),
          ...(parentId === undefined ? {} : { parentId }),
          ...(search === undefined ? {} : { search }),
          ...(assignedToMe === undefined ? {} : { assignedToMe }),
          ...(limit === undefined ? {} : { limit }),
          ...(cursor === undefined ? {} : { cursor }),
        });
        return {
          content: [{ type: "text", text: JSON.stringify(page) }],
          structuredContent: page,
        };
      } catch (error) {
        return toToolError(error);
      }
    },
  );

  server.registerTool(
    "task_execution_queue_get",
    {
      title: "Consultar fila priorizada de execução",
      description: "Lista tarefas Ready/in_progress atribuídas ao principal (por padrão), validadas pelos bloqueios reais de início. Ordena por prioridade efetiva (P1 primeiro), valor de negócio herdado/definido (maior primeiro) e rank; valores ausentes ficam por último. Se nada puder iniciar, emptyReason explica e upNext lista as próximas tarefas ainda não Ready (sem dependência aberta primeiro), excluindo as já entregues localmente e sem aceite formal (awaitingAcceptance/awaitingAcceptanceCount) com o que falta e a próxima ação. Read-only; inicie somente com task_start após task_start_check.",
      inputSchema: z.object({
        projectId: z.string().uuid(),
        assignedToMe: z.boolean().optional().default(true),
        limit: z.number().int().min(1).max(50).optional().default(20),
      }),
      outputSchema: z.object({
        projectId: z.string().uuid(),
        order: z.array(z.enum(["startable_first", "priority_ascending", "business_value_descending", "feature_rank", "task_rank", "key"])),
        assignedToMe: z.boolean(),
        scannedCount: z.number().int().nonnegative(),
        candidateLimitReached: z.boolean(),
        blockedCount: z.number().int().nonnegative(),
        businessValueMissingCount: z.number().int().nonnegative(),
        blocked: z.array(z.object({
          id: z.string().uuid(), key: z.string(), title: z.string(), state: z.string(), assigneeId: z.string().uuid().nullable(),
          priority: z.number().int().min(1).max(4), prioritySource: z.string(),
          businessValueScore: z.number().int().min(0).max(100).nullable(), businessValueRationale: z.string().nullable(),
          businessValueSource: z.string().nullable(), featureKey: z.string().nullable(), rank: z.number().int().positive(),
          blockerCodes: z.array(z.string()),
        })),
        tasks: z.array(z.object({
          id: z.string().uuid(), key: z.string(), title: z.string(), state: z.string(), assigneeId: z.string().uuid().nullable(),
          priority: z.number().int().min(1).max(4), prioritySource: z.string(),
          businessValueScore: z.number().int().min(0).max(100).nullable(), businessValueRationale: z.string().nullable(),
          businessValueSource: z.string().nullable(), featureKey: z.string().nullable(), rank: z.number().int().positive(),
        })),
        emptyReason: z.enum(["no_ready_tasks", "ready_tasks_blocked"]).nullable(),
        inFlight: z.array(z.object({ key: z.string(), state: z.string(), assigneeId: z.string().uuid().nullable() })),
        awaitingAcceptanceCount: z.number().int().nonnegative(),
        awaitingAcceptance: z.array(z.string()),
        upNext: z.array(z.object({
          id: z.string().uuid(), key: z.string(), title: z.string(), state: z.string(), assigneeId: z.string().uuid().nullable(),
          priority: z.number().int().min(1).max(4), prioritySource: z.string(),
          businessValueScore: z.number().int().min(0).max(100).nullable(), businessValueRationale: z.string().nullable(),
          businessValueSource: z.string().nullable(), featureKey: z.string().nullable(), rank: z.number().int().positive(),
          unmetDependencies: z.array(z.string()),
          missing: z.array(z.enum(["not_ready_state", "assignee", "estimate", "business_value", "dependencies"])),
          nextAction: z.string(),
        })),
      }),
    },
    ({ projectId, assignedToMe, limit }) => {
      try {
        const result = getTaskExecutionQueue(database, {
          projectId,
          principalId,
          assignedToMe,
          limit,
        });
        return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
      } catch (error) {
        return toToolError(error);
      }
    },
  );

  server.registerTool(
    "work_item_semantic_index",
    {
      title: "Indexar tarefas para busca semântica",
      description: "Gera ou atualiza vetores de título, descrição e critérios para uma página de itens. Use o cursor até completar o projeto; requer provedor de embeddings configurado.",
      inputSchema: z.object({
        projectId: z.string().uuid(),
        assignedToMe: z.boolean().optional(),
        limit: z.number().int().min(1).max(200).optional(),
        cursor: z.string().trim().min(1).max(4096).optional(),
      }),
      outputSchema: z.object({
        indexedCount: z.number().int().nonnegative(),
        unchangedCount: z.number().int().nonnegative(),
        skippedChangedCount: z.number().int().nonnegative(),
        model: z.string(),
        watermarkSequence: z.number().int().nonnegative(),
        nextCursor: z.string().nullable(),
      }),
    },
    async ({ projectId, assignedToMe, limit, cursor }) => {
      try {
        const result = await indexWorkItemSemantics(database, embeddingProvider, {
          projectId,
          principalId,
          ...(assignedToMe === undefined ? {} : { assignedToMe }),
          ...(limit === undefined ? {} : { limit }),
          ...(cursor === undefined ? {} : { cursor }),
        });
        return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
      } catch (error) { return toToolError(error); }
    },
  );

  server.registerTool(
    "work_item_semantic_search",
    {
      title: "Buscar tarefas por significado",
      description: "Busca vetorial por similaridade de embeddings, pode completar automaticamente uma página de índice e informa quando faltam itens indexados.",
      inputSchema: z.object({
        projectId: z.string().uuid(),
        query: z.string().trim().min(3).max(1_000),
        assignedToMe: z.boolean().optional(),
        types: z.array(z.enum(workItemTypes)).max(5).optional(),
        states: z.array(z.enum(workItemStates)).max(7).optional(),
        limit: z.number().int().min(1).max(50).optional(),
      }),
      outputSchema: z.object({
        query: z.string(),
        model: z.string(),
        results: z.array(z.object({
          id: z.string().uuid(),
          key: z.string(),
          type: z.enum(workItemTypes),
          title: z.string(),
          description: z.string().nullable(),
          state: z.enum(workItemStates),
          assigneeId: z.string().uuid().nullable(),
          similarity: z.number().min(-1).max(1),
        })),
        indexedCount: z.number().int().nonnegative(),
        missingEmbeddingCount: z.number().int().nonnegative(),
        indexComplete: z.boolean(),
        nextIndexCursor: z.string().nullable(),
      }),
    },
    async ({ projectId, query, assignedToMe, types, states, limit }) => {
      try {
        const result = await searchWorkItemsSemantically(database, embeddingProvider, {
          projectId,
          principalId,
          query,
          ...(assignedToMe === undefined ? {} : { assignedToMe }),
          ...(types === undefined ? {} : { types }),
          ...(states === undefined ? {} : { states }),
          ...(limit === undefined ? {} : { limit }),
        });
        return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
      } catch (error) { return toToolError(error); }
    },
  );

  server.registerTool(
    "work_item_assign",
    {
      title: "Atribuir item de trabalho",
      description: "Define ou remove o responsável após verificar papel de equipe e versão do item.",
      inputSchema: z.object({
        projectId: z.string().uuid(),
        requestId: z.string().trim().min(1).max(128),
        itemIdOrKey: z.string().trim().min(1).max(80),
        assigneeId: z.string().uuid().nullable(),
        expectedVersion: z.number().int().positive(),
      }),
      outputSchema: z.object({
        assignment: z.object({
          itemId: z.string().uuid(),
          itemKey: z.string(),
          assigneeId: z.string().uuid().nullable(),
          version: z.number().int().positive(),
        }),
        auditEventIds: z.array(z.string().uuid()),
      }),
    },
    ({ projectId, requestId, itemIdOrKey, assigneeId, expectedVersion }) => {
      try {
        const receipt = assignWorkItem(database, {
          projectId,
          principalId,
          requestId,
          itemIdOrKey,
          assigneeId,
          expectedVersion,
        });
        const result = { assignment: receipt.value, auditEventIds: receipt.auditEventIds };
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          structuredContent: result,
        };
      } catch (error) {
        return toToolError(error);
      }
    },
  );

  server.registerTool(
    "work_item_rank",
    {
      title: "Ordenar item de trabalho",
      description: "Move um item entre irmãos com controle de versão e auditoria.",
      inputSchema: z
        .object({
          projectId: z.string().uuid(),
          requestId: z.string().trim().min(1).max(128),
          itemIdOrKey: z.string().trim().min(1).max(80),
          beforeIdOrKey: z.string().trim().min(1).max(80).optional(),
          afterIdOrKey: z.string().trim().min(1).max(80).optional(),
          expectedVersion: z.number().int().positive(),
        })
        .refine((input) => (input.beforeIdOrKey === undefined) !== (input.afterIdOrKey === undefined), {
          message: "Specify exactly one beforeIdOrKey or afterIdOrKey.",
        }),
      outputSchema: z.object({
        rank: z.object({
          itemId: z.string().uuid(),
          itemKey: z.string(),
          rank: z.number().int().positive(),
          version: z.number().int().positive(),
        }),
        auditEventIds: z.array(z.string().uuid()),
      }),
    },
    ({ projectId, requestId, itemIdOrKey, beforeIdOrKey, afterIdOrKey, expectedVersion }) => {
      try {
        const receipt = rankWorkItem(database, {
          projectId,
          principalId,
          requestId,
          itemIdOrKey,
          expectedVersion,
          ...(beforeIdOrKey === undefined ? {} : { beforeIdOrKey }),
          ...(afterIdOrKey === undefined ? {} : { afterIdOrKey }),
        });
        const result = { rank: receipt.value, auditEventIds: receipt.auditEventIds };
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          structuredContent: result,
        };
      } catch (error) {
        return toToolError(error);
      }
    },
  );

  server.registerTool(
    "comment_add",
    {
      title: "Comentar item de trabalho",
      description: "Adiciona comentário imutável ao histórico de um item.",
      inputSchema: z.object({
        projectId: z.string().uuid(),
        requestId: z.string().trim().min(1).max(128),
        itemIdOrKey: z.string().trim().min(1).max(80),
        body: z.string().trim().min(1).max(5_000),
      }),
      outputSchema: z.object({
        comment: workItemCommentSchema,
        auditEventIds: z.array(z.string().uuid()),
      }),
    },
    ({ projectId, requestId, itemIdOrKey, body }) => {
      try {
        const receipt = addWorkItemComment(database, {
          projectId,
          principalId,
          requestId,
          itemIdOrKey,
          body,
        });
        const result = { comment: receipt.value, auditEventIds: receipt.auditEventIds };
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          structuredContent: result,
        };
      } catch (error) {
        return toToolError(error);
      }
    },
  );

  server.registerTool(
    "comment_list",
    {
      title: "Listar comentários",
      description: "Lista comentários do item em ordem imutável com cursor preso ao item e à identidade.",
      inputSchema: z.object({
        projectId: z.string().uuid(),
        itemIdOrKey: z.string().trim().min(1).max(80),
        limit: z.number().int().min(1).max(100).optional(),
        cursor: z.string().min(1).max(2048).optional(),
      }),
      outputSchema: z.object({
        comments: z.array(workItemCommentSchema),
        nextCursor: z.string().nullable(),
      }),
    },
    ({ projectId, itemIdOrKey, limit, cursor }) => {
      try {
        const page = listWorkItemComments(database, {
          projectId,
          principalId,
          itemIdOrKey,
          ...(limit === undefined ? {} : { limit }),
          ...(cursor === undefined ? {} : { cursor }),
        });
        return {
          content: [{ type: "text", text: JSON.stringify(page) }],
          structuredContent: page,
        };
      } catch (error) {
        return toToolError(error);
      }
    },
  );

  server.registerTool(
    "work_item_estimate",
    {
      title: "Propor estimativa",
      description: "Registra proposta de pontos para história/bug ou horas para tarefa.",
      inputSchema: z.object({
        projectId: z.string().uuid(),
        requestId: z.string().trim().min(1).max(128),
        itemIdOrKey: z.string().trim().min(1).max(80),
        unit: z.enum(["points", "hours"]),
        value: z.number().int().min(1).max(10_000),
        rationale: z.string().trim().min(1).max(1_000),
        expectedVersion: z.number().int().positive(),
      }),
      outputSchema: z.object({
        proposal: workItemEstimateProposalSchema,
        version: z.number().int().positive(),
        auditEventIds: z.array(z.string().uuid()),
      }),
    },
    ({ projectId, requestId, itemIdOrKey, unit, value, rationale, expectedVersion }) => {
      try {
        const receipt = proposeWorkItemEstimate(database, {
          projectId,
          principalId,
          requestId,
          itemIdOrKey,
          unit,
          value,
          rationale,
          expectedVersion,
        });
        const result = { proposal: receipt.value, version: currentItemVersion(database, projectId, receipt.value.itemId), auditEventIds: receipt.auditEventIds };
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          structuredContent: result,
        };
      } catch (error) {
        return toToolError(error);
      }
    },
  );

  server.registerTool(
    "work_item_estimate_confirm",
    {
      title: "Confirmar estimativa",
      description: "Confirma uma proposta específica e atualiza a estimativa corrente do item.",
      inputSchema: z.object({
        projectId: z.string().uuid(),
        requestId: z.string().trim().min(1).max(128),
        itemIdOrKey: z.string().trim().min(1).max(80),
        proposalId: z.string().uuid(),
        expectedVersion: z.number().int().positive(),
      }),
      outputSchema: z.object({
        proposal: workItemEstimateProposalSchema,
        version: z.number().int().positive(),
        auditEventIds: z.array(z.string().uuid()),
      }),
    },
    ({ projectId, requestId, itemIdOrKey, proposalId, expectedVersion }) => {
      try {
        const receipt = confirmWorkItemEstimate(database, {
          projectId,
          principalId,
          requestId,
          itemIdOrKey,
          proposalId,
          expectedVersion,
        });
        const result = { ...receipt.value, auditEventIds: receipt.auditEventIds };
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          structuredContent: result,
        };
      } catch (error) {
        return toToolError(error);
      }
    },
  );

  server.registerTool(
    "spec_create",
    {
      title: "Criar especificação",
      description: "Cria uma regra, glossário, contrato, ADR ou requisito não funcional com revisão inicial em rascunho.",
      inputSchema: z.object({
        projectId: z.string().uuid(),
        requestId: z.string().trim().min(1).max(128),
        key: z.string().trim().min(1).max(32),
        kind: z.enum(specificationKinds),
        title: z.string().trim().min(1).max(200),
        content: specificationContentSchema,
      }),
      outputSchema: z.object({
        revision: specificationRevisionSchema,
        auditEventIds: z.array(z.string().uuid()),
      }),
    },
    ({ projectId, requestId, key, kind, title, content }) => {
      try {
        const receipt = createSpecification(database, {
          projectId,
          principalId,
          requestId,
          key,
          kind,
          title,
          content,
        });
        const result = { revision: receipt.value, auditEventIds: receipt.auditEventIds };
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          structuredContent: result,
        };
      } catch (error) {
        return toToolError(error);
      }
    },
  );

  server.registerTool(
    "adr_create",
    {
      title: "Cadastrar ADR",
      description: "Cria uma decisão de arquitetura como revisão Draft imutável. A publicação posterior continua sujeita ao gate humano de Tech Lead.",
      inputSchema: z.object({
        projectId: z.string().uuid(),
        requestId: z.string().trim().min(1).max(128),
        key: z.string().trim().min(1).max(32),
        title: z.string().trim().min(1).max(200),
        content: specificationContentSchema,
      }),
      outputSchema: z.object({ revision: specificationRevisionSchema, auditEventIds: z.array(z.string().uuid()) }),
    },
    ({ projectId, requestId, key, title, content }) => {
      try {
        const receipt = createSpecification(database, { projectId, principalId, requestId, key, kind: "adr", title, content });
        const result = { revision: receipt.value, auditEventIds: receipt.auditEventIds };
        return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
      } catch (error) { return toToolError(error); }
    },
  );

  server.registerTool(
    "spec_revision_propose",
    {
      title: "Propor revisão de especificação",
      description: "Cria um snapshot imutável em rascunho com controle de versão otimista.",
      inputSchema: z.object({
        projectId: z.string().uuid(),
        requestId: z.string().trim().min(1).max(128),
        specIdOrKey: z.string().trim().min(1).max(80),
        expectedVersion: z.number().int().positive(),
        content: specificationContentSchema,
      }),
      outputSchema: z.object({
        revision: specificationRevisionSchema,
        auditEventIds: z.array(z.string().uuid()),
      }),
    },
    ({ projectId, requestId, specIdOrKey, expectedVersion, content }) => {
      try {
        const receipt = proposeSpecificationRevision(database, {
          projectId,
          principalId,
          requestId,
          specIdOrKey,
          expectedVersion,
          content,
        });
        const result = { revision: receipt.value, auditEventIds: receipt.auditEventIds };
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          structuredContent: result,
        };
      } catch (error) {
        return toToolError(error);
      }
    },
  );

  server.registerTool(
    "spec_revision_publish",
    {
      title: "Publicar revisão de especificação",
      description: "Publica a revisão mais recente após validar versão, papel funcional e identidade humana.",
      inputSchema: z.object({
        projectId: z.string().uuid(),
        requestId: z.string().trim().min(1).max(128),
        specIdOrKey: z.string().trim().min(1).max(80),
        revisionNumber: z.number().int().positive(),
        expectedVersion: z.number().int().positive(),
      }),
      outputSchema: z.object({
        revision: specificationRevisionSchema,
        auditEventIds: z.array(z.string().uuid()),
      }),
    },
    ({ projectId, requestId, specIdOrKey, revisionNumber, expectedVersion }) => {
      try {
        const receipt = publishSpecificationRevision(database, {
          projectId,
          principalId,
          requestId,
          specIdOrKey,
          revisionNumber,
          expectedVersion,
        });
        const result = { revision: receipt.value, auditEventIds: receipt.auditEventIds };
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          structuredContent: result,
        };
      } catch (error) {
        return toToolError(error);
      }
    },
  );

  server.registerTool(
    "spec_revision_withdraw",
    {
      title: "Retirar rascunho de especificação",
      description: "Retira a última revisão Draft/In Review quando foi abandonada ou substituída; exige pessoa PO para regra/glossário e Tech Lead para decisão técnica, motivo auditado, versão esperada e revisão mais recente.",
      inputSchema: z.object({
        projectId: z.string().uuid(),
        requestId: z.string().trim().min(1).max(128),
        specIdOrKey: z.string().trim().min(1).max(80),
        revisionNumber: z.number().int().positive(),
        expectedVersion: z.number().int().positive(),
        reason: z.string().trim().min(1).max(1000),
      }),
      outputSchema: z.object({ revision: specificationRevisionSchema, auditEventIds: z.array(z.string().uuid()) }),
    },
    ({ projectId, requestId, specIdOrKey, revisionNumber, expectedVersion, reason }) => {
      try {
        const receipt = withdrawSpecificationRevision(database, {
          projectId, principalId, requestId, specIdOrKey, revisionNumber, expectedVersion, reason,
        });
        const result = { revision: receipt.value, auditEventIds: receipt.auditEventIds };
        return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
      } catch (error) {
        return toToolError(error);
      }
    },
  );

  server.registerTool(
    "spec_get",
    {
      title: "Consultar especificação",
      description: "Lê uma especificação e todas as revisões autorizadas pelo projeto.",
      inputSchema: z.object({
        projectId: z.string().uuid(),
        specIdOrKey: z.string().trim().min(1).max(80),
      }),
      outputSchema: z.object({ specification: specificationSchema }),
    },
    ({ projectId, specIdOrKey }) => {
      try {
        const result = { specification: getSpecification(database, projectId, principalId, specIdOrKey) };
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          structuredContent: result,
        };
      } catch (error) {
        return toToolError(error);
      }
    },
  );

  server.registerTool(
    "spec_list",
    {
      title: "Listar especificações",
      description: "Lista ou pesquisa especificações em páginas estáveis, com filtro por tipo e cursor vinculado a projeto, identidade, filtros e watermark.",
      inputSchema: z.object({
        projectId: z.string().uuid(),
        kind: z.enum(specificationKinds).optional(),
        search: z.string().trim().min(2).max(160).optional(),
        limit: z.number().int().min(1).max(100).optional(),
        cursor: z.string().min(1).max(4_096).optional(),
      }),
      outputSchema: z.object({
        specifications: z.array(specificationSchema),
        nextCursor: z.string().nullable(),
        watermark: z.number().int().nonnegative(),
      }),
    },
    ({ projectId, kind, search, limit, cursor }) => {
      try {
        const result = listSpecifications(database, projectId, principalId, {
          ...(kind === undefined ? {} : { kind }),
          ...(search === undefined ? {} : { search }),
          ...(limit === undefined ? {} : { limit }),
          ...(cursor === undefined ? {} : { cursor }),
        });
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          structuredContent: result,
        };
      } catch (error) {
        return toToolError(error);
      }
    },
  );

  server.registerTool(
    "adr_search",
    {
      title: "Buscar ADRs",
      description: "Busca ADRs por chave, título ou conteúdo da revisão mais recente; retorna resumos paginados para manter o contexto compacto.",
      inputSchema: z.object({
        projectId: z.string().uuid(),
        query: z.string().trim().min(2).max(160),
        limit: z.number().int().min(1).max(100).optional(),
        cursor: z.string().trim().min(1).max(4_096).optional(),
      }),
      outputSchema: z.object({
        specifications: z.array(specificationSchema),
        nextCursor: z.string().nullable(),
        watermark: z.number().int().nonnegative(),
      }),
    },
    ({ projectId, query, limit, cursor }) => {
      try {
        const result = listSpecifications(database, projectId, principalId, {
          kind: "adr",
          search: query,
          ...(limit === undefined ? {} : { limit }),
          ...(cursor === undefined ? {} : { cursor }),
        });
        return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
      } catch (error) { return toToolError(error); }
    },
  );

  server.registerTool(
    "adr_link_task",
    {
      title: "Vincular ADR a tarefa",
      description: "Vincula uma tarefa a um ADR com relação implements (padrão) ou relates_to; valida os tipos e retorna as revisões disponíveis.",
      inputSchema: z.object({
        projectId: z.string().uuid(),
        requestId: z.string().trim().min(1).max(128),
        taskIdOrKey: z.string().trim().min(1).max(120),
        adrIdOrKey: z.string().trim().min(1).max(80),
        relationship: z.enum(["implements", "relates_to"]).default("implements"),
      }),
      outputSchema: z.object({
        link: traceLinkReceiptSchema,
        adrRevision: z.object({ latest: z.number().int().nonnegative(), published: z.number().int().positive().nullable() }),
        auditEventIds: z.array(z.string().uuid()),
      }),
    },
    ({ projectId, requestId, taskIdOrKey, adrIdOrKey, relationship }) => {
      try {
        const receipt = linkTaskToAdr(database, { projectId, principalId, requestId, taskIdOrKey, adrIdOrKey, relationship });
        const result = { ...receipt.value, auditEventIds: receipt.auditEventIds };
        return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
      } catch (error) { return toToolError(error); }
    },
  );

  server.registerTool(
    "scenario_create",
    {
      title: "Criar cenário",
      description: "Cria cenário de QA com primeira revisão em rascunho e cobertura de critérios ou especificações.",
      inputSchema: scenarioContentInputSchema.extend({
        projectId: z.string().uuid(),
        requestId: z.string().trim().min(1).max(128),
        key: z.string().trim().min(1).max(32),
        kind: z.enum(scenarioKinds),
      }),
      outputSchema: z.object({
        revision: scenarioRevisionSchema,
        auditEventIds: z.array(z.string().uuid()),
      }),
    },
    ({ projectId, requestId, key, kind, title, preconditions, steps, coverage, workItemIdOrKeys }) => {
      try {
        const receipt = createScenario(database, {
          projectId,
          principalId,
          requestId,
          key,
          kind,
          title,
          steps,
          ...(preconditions === undefined ? {} : { preconditions }),
          ...(coverage === undefined ? {} : { coverage }),
          ...(workItemIdOrKeys === undefined ? {} : { workItemIdOrKeys }),
        });
        const result = { revision: receipt.value, auditEventIds: receipt.auditEventIds };
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          structuredContent: result,
        };
      } catch (error) {
        return toToolError(error);
      }
    },
  );

  server.registerTool(
    "scenario_revision_propose",
    {
      title: "Propor revisão de cenário",
      description: "Cria snapshot imutável candidato e valida novamente os vínculos de cobertura.",
      inputSchema: scenarioContentInputSchema.extend({
        projectId: z.string().uuid(),
        requestId: z.string().trim().min(1).max(128),
        scenarioIdOrKey: z.string().trim().min(1).max(80),
        expectedVersion: z.number().int().positive(),
      }),
      outputSchema: z.object({
        revision: scenarioRevisionSchema,
        auditEventIds: z.array(z.string().uuid()),
      }),
    },
    ({ projectId, requestId, scenarioIdOrKey, expectedVersion, title, preconditions, steps, coverage, workItemIdOrKeys }) => {
      try {
        const receipt = proposeScenarioRevision(database, {
          projectId,
          principalId,
          requestId,
          scenarioIdOrKey,
          expectedVersion,
          title,
          steps,
          ...(preconditions === undefined ? {} : { preconditions }),
          ...(coverage === undefined ? {} : { coverage }),
          ...(workItemIdOrKeys === undefined ? {} : { workItemIdOrKeys }),
        });
        const result = { revision: receipt.value, auditEventIds: receipt.auditEventIds };
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          structuredContent: result,
        };
      } catch (error) {
        return toToolError(error);
      }
    },
  );

  server.registerTool(
    "scenario_revision_publish",
    {
      title: "Publicar revisão de cenário",
      description: "Publica o rascunho mais recente com confirmação humana QA.",
      inputSchema: z.object({
        projectId: z.string().uuid(),
        requestId: z.string().trim().min(1).max(128),
        scenarioIdOrKey: z.string().trim().min(1).max(80),
        revisionNumber: z.number().int().positive(),
        expectedVersion: z.number().int().positive(),
      }),
      outputSchema: z.object({
        revision: scenarioRevisionSchema,
        auditEventIds: z.array(z.string().uuid()),
      }),
    },
    ({ projectId, requestId, scenarioIdOrKey, revisionNumber, expectedVersion }) => {
      try {
        const receipt = publishScenarioRevision(database, {
          projectId,
          principalId,
          requestId,
          scenarioIdOrKey,
          revisionNumber,
          expectedVersion,
        });
        const result = { revision: receipt.value, auditEventIds: receipt.auditEventIds };
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          structuredContent: result,
        };
      } catch (error) {
        return toToolError(error);
      }
    },
  );

  server.registerTool(
    "scenario_get",
    {
      title: "Consultar cenário",
      description: "Consulta cenário pelo UUID ou chave e devolve todas as revisões.",
      inputSchema: z.object({
        projectId: z.string().uuid(),
        scenarioIdOrKey: z.string().trim().min(1).max(80),
      }),
      outputSchema: z.object({ scenario: scenarioSchema }),
    },
    ({ projectId, scenarioIdOrKey }) => {
      try {
        const result = { scenario: getScenario(database, projectId, principalId, scenarioIdOrKey) };
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          structuredContent: result,
        };
      } catch (error) {
        return toToolError(error);
      }
    },
  );

  server.registerTool(
    "scenario_list",
    {
      title: "Listar cenários",
      description: "Lista cenários em páginas estáveis, com filtro por tipo e cursor vinculado a projeto, identidade, filtros e watermark.",
      inputSchema: z.object({
        projectId: z.string().uuid(),
        kind: z.enum(scenarioKinds).optional(),
        limit: z.number().int().min(1).max(100).optional(),
        cursor: z.string().min(1).max(4_096).optional(),
      }),
      outputSchema: z.object({
        scenarios: z.array(scenarioSummarySchema),
        nextCursor: z.string().nullable(),
        watermark: z.number().int().nonnegative(),
      }),
    },
    ({ projectId, kind, limit, cursor }) => {
      try {
        const result = listScenarios(database, projectId, principalId, {
          ...(kind === undefined ? {} : { kind }),
          ...(limit === undefined ? {} : { limit }),
          ...(cursor === undefined ? {} : { cursor }),
        });
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          structuredContent: result,
        };
      } catch (error) {
        return toToolError(error);
      }
    },
  );

  server.registerTool(
    "scenario_criterion_search",
    {
      title: "Buscar cenários por critério",
      description: "Retorna revisões publicadas que cobrem o critério e o resultado mais recente por build.",
      inputSchema: z.object({
        projectId: z.string().uuid(),
        criterionRef: z.string().trim().min(1).max(120),
      }),
      outputSchema: z.object({ matches: z.array(scenarioCoverageMatchSchema) }),
    },
    ({ projectId, criterionRef }) => {
      try {
        const result = { matches: searchScenariosByCriterion(database, projectId, principalId, criterionRef) };
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          structuredContent: result,
        };
      } catch (error) {
        return toToolError(error);
      }
    },
  );

  server.registerTool(
    "test_run_record",
    {
      title: "Registrar resultado de teste",
      description: "Registra resultado imutável por revisão publicada e build.",
      inputSchema: z.object({
        projectId: z.string().uuid(),
        requestId: z.string().trim().min(1).max(128),
        scenarioIdOrKey: z.string().trim().min(1).max(80),
        revisionNumber: z.number().int().positive(),
        buildId: z.string().trim().min(1).max(128),
        result: z.enum(testRunResults),
        notes: z.string().max(2_000).optional(),
        evidenceUri: z.string().trim().min(1).max(2_048).optional(),
        workItemIdOrKeys: z.array(z.string().trim().min(1).max(120)).max(100).optional(),
      }),
      outputSchema: z.object({ run: testRunSchema, auditEventIds: z.array(z.string().uuid()) }),
    },
    ({ projectId, requestId, scenarioIdOrKey, revisionNumber, buildId, result, notes, evidenceUri, workItemIdOrKeys }) => {
      try {
        const receipt = recordTestRun(database, {
          projectId,
          principalId,
          requestId,
          scenarioIdOrKey,
          revisionNumber,
          buildId,
          result,
          ...(notes === undefined ? {} : { notes }),
          ...(evidenceUri === undefined ? {} : { evidenceUri }),
          ...(workItemIdOrKeys === undefined ? {} : { workItemIdOrKeys }),
        });
        const payload = { run: receipt.value, auditEventIds: receipt.auditEventIds };
        return {
          content: [{ type: "text", text: JSON.stringify(payload) }],
          structuredContent: payload,
        };
      } catch (error) {
        return toToolError(error);
      }
    },
  );

  server.registerTool(
    "task_workflow_get",
    {
      title: "Consultar workflow ponderado da tarefa",
      description: "Retorna o plano publicado, Draft atual, estados auditados das etapas e percentual calculado apenas pelas etapas concluídas.",
      inputSchema: z.object({
        projectId: z.string().uuid(), taskIdOrKey: z.string().trim().min(1).max(120),
        revisionNumber: z.number().int().positive().optional(),
      }),
      outputSchema: taskWorkflowViewSchema,
    },
    ({ projectId, taskIdOrKey, revisionNumber }) => {
      try {
        const view = getTaskWorkflow(database, { projectId, principalId, taskIdOrKey, ...(revisionNumber === undefined ? {} : { revisionNumber }) });
        return { content: [{ type: "text", text: JSON.stringify(view) }], structuredContent: view };
      } catch (error) { return toToolError(error); }
    },
  );

  server.registerTool(
    "task_workflow_propose",
    {
      title: "Propor workflow técnico ponderado",
      description: "Cria revisão Draft imutável com 1-50 etapas cuja soma de esforço é exatamente 100.00%; novo Draft substitui o Draft anterior sem apagar histórico.",
      inputSchema: z.object({
        projectId: z.string().uuid(), requestId: z.string().trim().min(1).max(128), taskIdOrKey: z.string().trim().min(1).max(120),
        expectedTaskVersion: z.number().int().positive(), expectedWorkflowVersion: z.number().int().nonnegative(),
        steps: z.array(z.object({ id: z.string().uuid().optional(), title: z.string().trim().min(1).max(160),
          description: z.string().trim().min(1).max(4_000), effortPercent: z.number().positive().max(100) })).min(1).max(50),
        reason: z.string().trim().min(1).max(1_000),
      }),
      outputSchema: z.object({ workflow: taskWorkflowRevisionSchema, auditEventIds: z.array(z.string().uuid()) }),
    },
    ({ projectId, requestId, taskIdOrKey, expectedTaskVersion, expectedWorkflowVersion, steps, reason }) => {
      try {
        const receipt = proposeTaskWorkflow(database, {
          projectId, principalId, requestId, taskIdOrKey, expectedTaskVersion, expectedWorkflowVersion,
          steps: steps.map((step) => ({ title: step.title, description: step.description, effortPercent: step.effortPercent,
            ...(step.id === undefined ? {} : { id: step.id }) })), reason,
        });
        const result = { workflow: receipt.value, auditEventIds: receipt.auditEventIds };
        return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
      } catch (error) { return toToolError(error); }
    },
  );

  server.registerTool(
    "task_workflow_publish",
    {
      title: "Publicar workflow da tarefa",
      description: "Publica uma revisão Draft por Tech Lead humano sem sessões abertas; preserva etapa não alterada e volta etapas com definição alterada para Pendente.",
      inputSchema: z.object({
        projectId: z.string().uuid(), requestId: z.string().trim().min(1).max(128), taskIdOrKey: z.string().trim().min(1).max(120),
        revisionNumber: z.number().int().positive(), expectedTaskVersion: z.number().int().positive(), reason: z.string().trim().min(1).max(1_000),
      }),
      outputSchema: z.object({
        workflow: taskWorkflowRevisionSchema,
        migration: z.object({ preservedStepIds: z.array(z.string().uuid()), resetStepIds: z.array(z.string().uuid()), previousProgressPercent: z.number().min(0).max(100).nullable() }),
        auditEventIds: z.array(z.string().uuid()),
      }),
    },
    ({ projectId, requestId, taskIdOrKey, revisionNumber, expectedTaskVersion, reason }) => {
      try {
        const receipt = publishTaskWorkflow(database, { projectId, principalId, requestId, taskIdOrKey, revisionNumber, expectedTaskVersion, reason });
        const result = { ...receipt.value, auditEventIds: receipt.auditEventIds };
        return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
      } catch (error) { return toToolError(error); }
    },
  );

  server.registerTool(
    "task_workflow_step_transition",
    {
      title: "Atualizar etapa do workflow",
      description: "Atualiza status da etapa na revisão publicada; apenas etapa Done compõe o percentual e o Developer precisa de sessão ativa pinned à revisão.",
      inputSchema: z.object({
        projectId: z.string().uuid(), requestId: z.string().trim().min(1).max(128), taskIdOrKey: z.string().trim().min(1).max(120),
        revisionNumber: z.number().int().positive(), stepId: z.string().uuid(), expectedTaskVersion: z.number().int().positive(),
        targetStatus: z.enum(taskWorkflowStepStatuses), reason: z.string().trim().min(1).max(1_000),
      }),
      outputSchema: z.object({
        transition: z.object({ projectId: z.string().uuid(), taskId: z.string().uuid(), taskKey: z.string(), taskVersion: z.number().int().positive(),
          revisionNumber: z.number().int().positive(), stepId: z.string().uuid(), fromStatus: z.enum(taskWorkflowStepStatuses),
          toStatus: z.enum(taskWorkflowStepStatuses), changedAt: z.string().datetime(), progressPercent: z.number().min(0).max(100) }),
        auditEventIds: z.array(z.string().uuid()),
      }),
    },
    ({ projectId, requestId, taskIdOrKey, revisionNumber, stepId, expectedTaskVersion, targetStatus, reason }) => {
      try {
        const receipt = transitionTaskWorkflowStep(database, {
          projectId, principalId, requestId, taskIdOrKey, revisionNumber, stepId, expectedTaskVersion, targetStatus, reason,
        });
        const result = { transition: receipt.value, auditEventIds: receipt.auditEventIds };
        return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
      } catch (error) { return toToolError(error); }
    },
  );

  server.registerTool(
    "development_session_start",
    {
      title: "Iniciar sessão de desenvolvimento",
      description: "Inicia uma sessão rastreável para a tarefa atribuída ao principal autenticado e fixa as revisões técnicas e cenários ligados à tarefa.",
      inputSchema: z.object({
        projectId: z.string().uuid(), requestId: z.string().trim().min(1).max(128),
        itemIdOrKey: z.string().trim().min(1).max(120), expectedVersion: z.number().int().positive(),
        sessionReference: z.string().trim().min(1).max(160).optional(),
      }),
      outputSchema: z.object({ session: developmentSessionSchema, auditEventIds: z.array(z.string().uuid()) }),
    },
    ({ projectId, requestId, itemIdOrKey, expectedVersion, sessionReference }) => {
      try {
        const receipt = startDevelopmentSession(database, {
          projectId, principalId, requestId, itemIdOrKey, expectedVersion,
          ...(sessionReference === undefined ? {} : { sessionReference }),
        });
        const result = { session: receipt.value, auditEventIds: receipt.auditEventIds };
        return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
      } catch (error) { return toToolError(error); }
    },
  );

  server.registerTool(
    "task_start_check",
    {
      title: "Verificar se a tarefa pode iniciar",
      description: "Diagnostica estado, atribuição, papel Developer, PBI pai e baseline, dependências e sessão aberta antes de iniciar uma tarefa.",
      inputSchema: z.object({ projectId: z.string().uuid(), taskIdOrKey: z.string().trim().min(1).max(120) }),
      outputSchema: z.object({
        itemId: z.string().uuid(), itemKey: z.string(), title: z.string(), state: z.string(), version: z.number().int().positive(),
        assigneeId: z.string().uuid().nullable(),
        parent: z.object({ id: z.string().uuid(), key: z.string(), state: z.string(), baselineId: z.string().uuid().nullable() }).nullable(),
        dependencies: z.array(z.object({ id: z.string().uuid(), key: z.string(), title: z.string(), state: z.string(), complete: z.boolean() })),
        openSession: z.object({ id: z.string().uuid(), status: z.enum(["active", "paused"]), developerPrincipalId: z.string().uuid() }).nullable(),
        blockers: z.array(z.object({ code: z.string(), message: z.string(), details: z.unknown().optional() })),
        warnings: z.array(z.object({ code: z.string(), message: z.string(), keys: z.array(z.string()) })),
        canStart: z.boolean(),
      }),
    },
    ({ projectId, taskIdOrKey }) => {
      try {
        const report = getTaskStartReadiness(database, { projectId, principalId, itemIdOrKey: taskIdOrKey });
        return { content: [{ type: "text", text: JSON.stringify(report) }], structuredContent: report };
      } catch (error) { return toToolError(error); }
    },
  );

  server.registerTool(
    "task_start",
    {
      title: "Iniciar tarefa atomicamente",
      description: "Valida todos os gates e, se a tarefa estiver Ready, transiciona para in_progress e abre a sessão numa única transação; uma falha reverte ambas as operações.",
      inputSchema: z.object({
        projectId: z.string().uuid(),
        requestId: z.string().trim().min(1).max(100),
        taskIdOrKey: z.string().trim().min(1).max(120),
        expectedVersion: z.number().int().positive(),
        reason: z.string().trim().min(1).max(1_000),
        sessionReference: z.string().trim().min(1).max(160).optional(),
      }),
      outputSchema: z.object({ task: z.object({ id: z.string().uuid(), key: z.string(), state: z.literal("in_progress"), version: z.number().int().positive() }),
        transition: workItemTransitionSchema.nullable(), session: developmentSessionSchema, auditEventIds: z.array(z.string().uuid()) }),
    },
    ({ projectId, requestId, taskIdOrKey, expectedVersion, reason, sessionReference }) => {
      try {
        const receipt = startTaskDevelopment(database, {
          projectId, principalId, requestId, itemIdOrKey: taskIdOrKey, expectedVersion, reason,
          ...(sessionReference === undefined ? {} : { sessionReference }),
        });
        const { operationAuditEventIds, ...started } = receipt.value;
        const result = { ...started, auditEventIds: [...operationAuditEventIds, ...receipt.auditEventIds] };
        return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
      } catch (error) { return toToolError(error); }
    },
  );

  server.registerTool(
    "development_session_transition",
    {
      title: "Atualizar sessão de desenvolvimento",
      description: "Pausa, retoma, conclui ou cancela a sessão do próprio desenvolvedor com duração ativa acumulada e histórico imutável.",
      inputSchema: z.object({
        projectId: z.string().uuid(), requestId: z.string().trim().min(1).max(128), sessionId: z.string().uuid(),
        action: z.enum(["pause", "resume", "complete", "cancel"]), expectedVersion: z.number().int().positive(),
        reason: z.string().trim().min(1).max(500),
      }),
      outputSchema: z.object({ session: developmentSessionSchema, auditEventIds: z.array(z.string().uuid()) }),
    },
    ({ projectId, requestId, sessionId, action, expectedVersion, reason }) => {
      try {
        const receipt = transitionDevelopmentSession(database, { projectId, principalId, requestId, sessionId, action, expectedVersion, reason });
        const result = { session: receipt.value, auditEventIds: receipt.auditEventIds };
        return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
      } catch (error) { return toToolError(error); }
    },
  );

  server.registerTool(
    "development_session_list",
    {
      title: "Consultar sessões de desenvolvimento",
      description: "Lista sessões por tarefa, desenvolvedor ou status; sessões ativas incluem a duração acumulada até agora.",
      inputSchema: z.object({
        projectId: z.string().uuid(), itemIdOrKey: z.string().trim().min(1).max(120).optional(),
        developerPrincipalId: z.string().uuid().optional(), status: z.enum(["active", "paused", "completed", "cancelled"]).optional(),
        limit: z.number().int().min(1).max(200).optional(),
      }),
      outputSchema: z.object({ sessions: z.array(developmentSessionSchema) }),
    },
    ({ projectId, itemIdOrKey, developerPrincipalId, status, limit }) => {
      try {
        const result = { sessions: listDevelopmentSessions(database, {
          projectId, principalId,
          ...(itemIdOrKey === undefined ? {} : { itemIdOrKey }),
          ...(developerPrincipalId === undefined ? {} : { developerPrincipalId }),
          ...(status === undefined ? {} : { status }), ...(limit === undefined ? {} : { limit }),
        }) };
        return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
      } catch (error) { return toToolError(error); }
    },
  );

  server.registerTool(
    "developer_execution_metrics_get",
    {
      title: "Consultar esforço e calibração por desenvolvedor",
      description: "Resume horas ativas no período, tarefas com última conclusão no período e calibração apenas sobre tarefas com estimativa confirmada. As datas usam o fuso do projeto; a amostra mínima é de cinco tarefas estimadas. Não calcula velocidade em pontos por pessoa nem produz ranking.",
      inputSchema: z.object({
        projectId: z.string().uuid(), from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u).optional(),
        to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u).optional(), developerPrincipalId: z.string().uuid().optional(),
      }),
      outputSchema: z.object({
        projectId: z.string().uuid(), period: z.object({ from: z.string(), to: z.string() }), minimumSampleTasks: z.number().int(),
        developers: z.array(z.object({
          principalId: z.string().uuid(), name: z.string(), completedSessions: z.number().int(), completedTasks: z.number().int(),
          estimatedCompletedTasks: z.number().int(), activeHours: z.number(), activeHoursOnCompletedTasks: z.number(),
          activeHoursOnEstimatedCompletedTasks: z.number(), estimatedHoursOnCompletedTasks: z.number(),
          estimateVariancePercent: z.number().nullable(), effortCalibrationFactor: z.number().nullable(), sampleSufficient: z.boolean(),
        })),
      }),
    },
    ({ projectId, from, to, developerPrincipalId }) => {
      try {
        const result = getDeveloperExecutionMetrics(database, {
          projectId, principalId, ...(from === undefined ? {} : { from }), ...(to === undefined ? {} : { to }),
          ...(developerPrincipalId === undefined ? {} : { developerPrincipalId }),
        });
        return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
      } catch (error) { return toToolError(error); }
    },
  );

  server.registerTool(
    "deployment_event_record",
    {
      title: "Registrar evento de implantação",
      description: "Registra sucesso, falha ou rollback em homologação/produção e liga o evento a tarefas, PBIs ou marcos; produção exige Done e homologação bem-sucedida do mesmo build.",
      inputSchema: z.object({
        projectId: z.string().uuid(), requestId: z.string().trim().min(1).max(128),
        environment: z.enum(["homologation", "production"]), buildId: z.string().trim().min(1).max(128),
        releaseVersion: z.string().trim().min(1).max(128).optional(), pipelineRunId: z.string().trim().min(1).max(160).optional(),
        outcome: z.enum(["succeeded", "failed", "rolled_back"]), occurredAt: z.string().datetime().optional(),
        itemIdOrKeys: z.array(z.string().trim().min(1).max(120)).max(100).default([]),
        milestoneIdOrKeys: z.array(z.string().trim().min(1).max(120)).max(50).optional(),
        rollbackOfEventId: z.string().uuid().optional(), notes: z.string().max(2_000).optional(),
      }),
      outputSchema: z.object({ event: deploymentEventSchema, auditEventIds: z.array(z.string().uuid()) }),
    },
    ({ projectId, requestId, environment, buildId, releaseVersion, pipelineRunId, outcome, occurredAt, itemIdOrKeys, milestoneIdOrKeys, rollbackOfEventId, notes }) => {
      try {
        const receipt = recordDeployment(database, {
          projectId, principalId, requestId, environment, buildId, outcome, itemIdOrKeys,
          ...(releaseVersion === undefined ? {} : { releaseVersion }), ...(pipelineRunId === undefined ? {} : { pipelineRunId }),
          ...(occurredAt === undefined ? {} : { occurredAt }), ...(milestoneIdOrKeys === undefined ? {} : { milestoneIdOrKeys }),
          ...(rollbackOfEventId === undefined ? {} : { rollbackOfEventId }), ...(notes === undefined ? {} : { notes }),
        });
        const result = { event: receipt.value, auditEventIds: receipt.auditEventIds };
        return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
      } catch (error) { return toToolError(error); }
    },
  );

  server.registerTool(
    "deployment_event_list",
    {
      title: "Consultar histórico de implantações",
      description: "Lista eventos de release por projeto, ambiente e work item, mantendo falhas e rollbacks no histórico.",
      inputSchema: z.object({
        projectId: z.string().uuid(), itemIdOrKey: z.string().trim().min(1).max(120).optional(),
        environment: z.enum(["homologation", "production"]).optional(), limit: z.number().int().min(1).max(200).optional(),
      }),
      outputSchema: z.object({ events: z.array(deploymentEventSchema) }),
    },
    ({ projectId, itemIdOrKey, environment, limit }) => {
      try {
        const result = { events: listDeploymentEvents(database, {
          projectId, principalId, ...(itemIdOrKey === undefined ? {} : { itemIdOrKey }),
          ...(environment === undefined ? {} : { environment }), ...(limit === undefined ? {} : { limit }),
        }) };
        return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
      } catch (error) { return toToolError(error); }
    },
  );

  server.registerTool(
    "test_run_list",
    {
      title: "Consultar histórico de execuções de teste",
      description: "Lista observações QA recentes do projeto, com filtros por cenário, build e resultado e cursor estável para continuar o histórico.",
      inputSchema: z.object({
        projectId: z.string().uuid().describe("UUID do projeto retornado por project_list."),
        scenarioIdOrKey: z.string().trim().min(1).max(80).optional()
          .describe("Filtra por ID ou chave do cenário; omita para consultar o projeto inteiro."),
        buildId: z.string().trim().min(1).max(128).optional()
          .describe("Filtra pela identificação exata da build registrada."),
        result: z.enum(testRunResults).optional()
          .describe("Filtra por passed, failed, blocked ou skipped."),
        limit: z.number().int().min(1).max(100).optional()
          .describe("Quantidade máxima de execuções na página; padrão 25 e máximo 100."),
        cursor: z.string().max(4_096).optional()
          .describe("Cursor opaco nextCursor retornado na página anterior; reinicie sem cursor após STALE_CURSOR."),
      }),
      outputSchema: testRunPageSchema,
    },
    ({ projectId, scenarioIdOrKey, buildId, result, limit, cursor }) => {
      try {
        const page = listTestRunPage(database, projectId, principalId, {
          ...(scenarioIdOrKey === undefined ? {} : { scenarioIdOrKey }),
          ...(buildId === undefined ? {} : { buildId }),
          ...(result === undefined ? {} : { result }),
          ...(limit === undefined ? {} : { limit }),
          ...(cursor === undefined ? {} : { cursor }),
        });
        return {
          content: [{ type: "text", text: JSON.stringify(page) }],
          structuredContent: page,
        };
      } catch (error) {
        return toToolError(error);
      }
    },
  );

  server.registerTool(
    "milestone_create",
    {
      title: "Criar marco com escopo aprovado",
      description: "Cria um marco e fixa os snapshots dos PBIs Ready aprovados pelo PO, incluindo baseline, revisão e pontos.",
      inputSchema: z.object({
        projectId: z.string().uuid(),
        requestId: z.string().trim().min(1).max(128),
        milestoneKey: z.string().trim().min(1).max(32),
        title: z.string().trim().min(1).max(120),
        goal: z.string().trim().min(1).max(1_000),
        targetDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        itemIdsOrKeys: z.array(z.string().trim().min(1).max(80)).min(1).max(100),
        reason: z.string().trim().min(1).max(1_000),
      }),
      outputSchema: z.object({ milestone: milestoneSchema, auditEventIds: z.array(z.string().uuid()) }),
    },
    ({ projectId, requestId, milestoneKey, title, goal, targetDate, itemIdsOrKeys, reason }) => {
      try {
        const receipt = createMilestone(database, {
          projectId, principalId, requestId, milestoneKey, title, goal, targetDate, itemIdsOrKeys, reason,
        });
        const result = { milestone: receipt.value, auditEventIds: receipt.auditEventIds };
        return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
      } catch (error) {
        return toToolError(error);
      }
    },
  );

  server.registerTool(
    "milestone_scope_change",
    {
      title: "Alterar escopo aprovado do marco",
      description: "Registra inclusão e remoção de PBIs com snapshot imutável, motivo e controle otimista de versão.",
      inputSchema: z.object({
        projectId: z.string().uuid(),
        requestId: z.string().trim().min(1).max(128),
        milestoneIdOrKey: z.string().trim().min(1).max(80),
        expectedVersion: z.number().int().positive(),
        addItemIdsOrKeys: z.array(z.string().trim().min(1).max(80)).min(1).max(100).optional(),
        removeItemIdsOrKeys: z.array(z.string().trim().min(1).max(80)).min(1).max(100).optional(),
        reason: z.string().trim().min(1).max(1_000),
      }),
      outputSchema: z.object({ milestone: milestoneSchema, auditEventIds: z.array(z.string().uuid()) }),
    },
    ({ projectId, requestId, milestoneIdOrKey, expectedVersion, addItemIdsOrKeys, removeItemIdsOrKeys, reason }) => {
      try {
        const receipt = changeMilestoneScope(database, {
          projectId, principalId, requestId, milestoneIdOrKey, expectedVersion, reason,
          ...(addItemIdsOrKeys === undefined ? {} : { addItemIdsOrKeys }),
          ...(removeItemIdsOrKeys === undefined ? {} : { removeItemIdsOrKeys }),
        });
        const result = { milestone: receipt.value, auditEventIds: receipt.auditEventIds };
        return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
      } catch (error) {
        return toToolError(error);
      }
    },
  );

  server.registerTool(
    "milestone_get",
    {
      title: "Consultar marco",
      description: "Retorna o marco, o escopo corrente e todo o histórico de aprovações e remoções.",
      inputSchema: z.object({ projectId: z.string().uuid(), milestoneIdOrKey: z.string().trim().min(1).max(80) }),
      outputSchema: z.object({ milestone: milestoneSchema }),
    },
    ({ projectId, milestoneIdOrKey }) => {
      try {
        const milestone = getMilestone(database, projectId, principalId, milestoneIdOrKey);
        return { content: [{ type: "text", text: JSON.stringify({ milestone }) }], structuredContent: { milestone } };
      } catch (error) {
        return toToolError(error);
      }
    },
  );

  server.registerTool(
    "milestone_list",
    {
      title: "Listar marcos",
      description: "Lista marcos do projeto com data alvo, pontos e quantidade de PBIs no escopo aprovado corrente.",
      inputSchema: z.object({ projectId: z.string().uuid(), limit: z.number().int().min(1).max(100).optional() }),
      outputSchema: z.object({ milestones: z.array(milestoneSummarySchema) }),
    },
    ({ projectId, limit }) => {
      try {
        const milestones = listMilestones(database, projectId, principalId, limit);
        return { content: [{ type: "text", text: JSON.stringify({ milestones }) }], structuredContent: { milestones } };
      } catch (error) {
        return toToolError(error);
      }
    },
  );

  server.registerTool(
    "milestone_forecast_history",
    {
      title: "Consultar histórico de previsões",
      description: "Lista snapshots imutáveis recentes de um marco/time; retorna os resultados, sem insumos completos da simulação.",
      inputSchema: z.object({
        projectId: z.string().uuid().describe("UUID do projeto retornado por project_list."),
        milestoneIdOrKey: z.string().trim().min(1).max(80).describe("UUID ou chave do marco."),
        teamId: z.string().uuid().optional().describe("Time da previsão; obrigatório quando o projeto tem vários times."),
        limit: z.number().int().min(1).max(20).optional().describe("Máximo de snapshots recentes; padrão 10, máximo 20."),
      }),
      outputSchema: z.object({ forecasts: z.array(metricsObjectSchema) }),
    },
    ({ projectId, milestoneIdOrKey, teamId, limit }) => {
      try {
        const entries = listMilestoneForecastHistory(database, {
          projectId, principalId, milestoneIdOrKey,
          ...(teamId === undefined ? {} : { teamId }),
          limit: limit ?? 10,
        });
        const result = { forecasts: entries.map(({ forecast }) => forecast) };
        return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
      } catch (error) {
        return toToolError(error);
      }
    },
  );

  server.registerTool(
    "milestone_forecast_recalculate",
    {
      title: "Recalcular snapshot de previsão",
      description: "Reexecuta o algoritmo e insumos imutáveis do snapshot indicado para verificar reprodutibilidade; não grava dados.",
      inputSchema: z.object({
        projectId: z.string().uuid().describe("UUID do projeto retornado por project_list."),
        forecastId: z.string().uuid().describe("ID do snapshot retornado por metrics_get ou milestone_forecast_history."),
      }),
      outputSchema: forecastRecalculationSchema,
    },
    ({ projectId, forecastId }) => {
      try {
        const recalculation = recalculateMilestoneForecast(database, { projectId, principalId, forecastId });
        return { content: [{ type: "text", text: JSON.stringify(recalculation) }], structuredContent: recalculation };
      } catch (error) {
        return toToolError(error);
      }
    },
  );

  server.registerTool(
    "metrics_get",
    {
      title: "Consultar métricas do projeto",
      description: "Retorna a mesma projeção auditável do dashboard: burnup, previsão, sprint, velocidade, WIP e cobertura, em um único snapshot SQLite.",
      inputSchema: z.object({
        projectId: z.string().uuid(),
        teamId: z.string().uuid().optional(),
        milestoneId: z.string().trim().min(1).max(80).optional(),
        sprintId: z.string().trim().min(1).max(80).optional(),
        asOfDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u).optional(),
      }),
      outputSchema: dashboardMetricsSchema,
    },
    ({ projectId, teamId, milestoneId, sprintId, asOfDate }) => {
      try {
        const metrics = getProjectDashboardMetrics(database, {
          projectId,
          principalId,
          ...(teamId === undefined ? {} : { teamId }),
          ...(milestoneId === undefined ? {} : { milestoneId }),
          ...(sprintId === undefined ? {} : { sprintId }),
          ...(asOfDate === undefined ? {} : { asOfDate }),
        });
        return { content: [{ type: "text", text: JSON.stringify(metrics) }], structuredContent: metrics };
      } catch (error) {
        return toToolError(error);
      }
    },
  );

  server.registerTool(
    "project_feature_roadmap_get",
    {
      title: "Consultar roadmap priorizado por feature",
      description: "Retorna Features ordenadas por prioridade efetiva e valor de negócio, progresso por story points confirmados, bloqueios externos, sprints planejadas e previsão P25/P50/P75. Exige três sprints fechadas comparáveis para datas; escopo sem estimativa, dependências abertas ou ausência de capacidade mantém datas indisponíveis.",
      inputSchema: z.object({
        projectId: z.string().uuid(),
        teamId: z.string().uuid().optional(),
        asOfDate: z.string().regex(/^\\d{4}-\\d{2}-\\d{2}$/u).optional(),
      }),
      outputSchema: z.object({
        projectId: z.string().uuid(), teamId: z.string().uuid().nullable(), teamName: z.string().nullable(),
        teamGenerationNumber: z.number().int().nonnegative().nullable(), asOfDate: z.string(), timezone: z.string(),
        watermarkSequence: z.number().int().nonnegative(), velocitySampleSize: z.number().int().nonnegative(),
        minimumVelocitySamples: z.number().int().positive(),
        forecastBasis: z.enum(["historical_sprint_velocity_sequential_priority", "unavailable"]),
        forecastAssumption: z.string(),
        forecastUnavailableReason: z.enum(["team_required", "insufficient_velocity_samples", "unknown_feature_scope", "external_dependency", "zero_velocity"]).nullable(),
        featuresTruncated: z.boolean(),
        sprintTimeline: z.array(z.object({ index: z.number().int().positive(), startsOn: z.string(), endsOn: z.string(), source: z.enum(["planned_sprint", "historical_median"]) })),
        features: z.array(z.object({
          id: z.string().uuid(), key: z.string(), title: z.string(), state: z.string(), priority: z.number().int().min(1).max(4),
          effectivePriority: z.number().int().min(1).max(4), businessValueScore: z.number().int().min(0).max(100).nullable(),
          businessValueRationale: z.string().nullable(), businessValueSource: z.string().nullable(), rank: z.number().int().positive(),
          completedPoints: z.number().nonnegative(), remainingPoints: z.number().nonnegative(), cancelledPoints: z.number().nonnegative(),
          unestimatedItemCount: z.number().int().nonnegative(), totalItems: z.number().int().nonnegative(), completedItems: z.number().int().nonnegative(),
          cancelledItems: z.number().int().nonnegative(),
          progressPercent: z.number().min(0).max(100).nullable(),
          externalBlockers: z.array(z.object({ key: z.string(), state: z.string() })),
          forecast: z.object({ status: z.enum(["completed", "forecast_ready", "insufficient_data", "incomplete_scope", "blocked", "zero_velocity"]),
            favorableDate: z.string().nullable(), baseDate: z.string().nullable(), cautiousDate: z.string().nullable(),
            favorableSprint: z.number().int().positive().nullable(), baseSprint: z.number().int().positive().nullable(), cautiousSprint: z.number().int().positive().nullable() }),
        })),
      }),
    },
    ({ projectId, teamId, asOfDate }) => {
      try {
        const result = getProjectFeatureRoadmap(database, {
          projectId,
          principalId,
          ...(teamId === undefined ? {} : { teamId }),
          ...(asOfDate === undefined ? {} : { asOfDate }),
        });
        return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
      } catch (error) {
        return toToolError(error);
      }
    },
  );

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
        return {
          content: [{ type: "text", text: JSON.stringify(references) }],
          structuredContent: references,
        };
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
        return { content: [{ type: "text", text: JSON.stringify(preview) }], structuredContent: preview };
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
        return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
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
        return { content: [{ type: "text", text: JSON.stringify(preview) }], structuredContent: preview };
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
        return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
      } catch (error) {
        return toToolError(error);
      }
    },
  );

  server.registerTool(
    "team_list",
    {
      title: "Listar times",
      description: "Lista os times do projeto, incluindo configuração corrente, membros e versões.",
      inputSchema: z.object({ projectId: z.string().uuid() }),
      outputSchema: z.object({ teams: z.array(teamSummarySchema) }),
    },
    ({ projectId }) => {
      try {
        const teams = listProjectTeams(database, projectId, principalId);
        return { content: [{ type: "text", text: JSON.stringify({ teams }) }], structuredContent: { teams } };
      } catch (error) {
        return toToolError(error);
      }
    },
  );

  server.registerTool(
    "team_create",
    {
      title: "Criar time",
      description: "Cria um novo time com configuração inicial, calendário e composição próprios.",
      inputSchema: z.object({
        projectId: z.string().uuid(),
        requestId: z.string().trim().min(1).max(128),
      }).extend(teamCapacityInputFieldsSchema.shape),
      outputSchema: z.object({ configuration: teamCapacityConfigurationSchema, auditEventIds: z.array(z.string().uuid()) }),
    },
    ({ projectId, requestId, teamName, timezone, hoursPerDay, workingDays, members, holidays, absences, reason }) => {
      try {
        const receipt = createTeamCapacityConfiguration(database, {
          projectId, principalId, requestId, teamName, timezone, hoursPerDay, workingDays, members, reason,
          ...(holidays === undefined ? {} : { holidays }),
          ...(absences === undefined ? {} : { absences }),
        });
        const result = { configuration: receipt.value, auditEventIds: receipt.auditEventIds };
        return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
      } catch (error) {
        return toToolError(error);
      }
    },
  );

  server.registerTool(
    "team_capacity_set",
    {
      title: "Configurar capacidade do time",
      description: "Cria uma versão imutável da capacidade do time selecionado; em projetos com vários times, informe teamId.",
      inputSchema: z.object({
        projectId: z.string().uuid(),
        requestId: z.string().trim().min(1).max(128),
        expectedVersion: z.number().int().min(0),
        teamId: z.string().uuid().optional(),
      }).extend(teamCapacityInputFieldsSchema.shape),
      outputSchema: z.object({
        configuration: teamCapacityConfigurationSchema,
        auditEventIds: z.array(z.string().uuid()),
      }),
    },
    ({ projectId, requestId, expectedVersion, teamId, teamName, timezone, hoursPerDay, workingDays, members, holidays, absences, reason }) => {
      try {
        const receipt = setTeamCapacityConfiguration(database, {
          projectId, principalId, requestId, expectedVersion, teamName, timezone, hoursPerDay, workingDays, members, reason,
          ...(teamId === undefined ? {} : { teamId }),
          ...(holidays === undefined ? {} : { holidays }),
          ...(absences === undefined ? {} : { absences }),
        });
        const result = { configuration: receipt.value, auditEventIds: receipt.auditEventIds };
        return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
      } catch (error) {
        return toToolError(error);
      }
    },
  );

  server.registerTool(
    "team_capacity_get",
    {
      title: "Consultar capacidade do time",
      description: "Calcula horas disponíveis por pessoa e por dia útil, considerando dedicação, calendário, período ativo e ausências.",
      inputSchema: z.object({
        projectId: z.string().uuid(),
        startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        configVersion: z.number().int().positive().optional(),
        teamId: z.string().uuid().optional(),
      }),
      outputSchema: teamCapacityReportSchema,
    },
    ({ projectId, startDate, endDate, configVersion, teamId }) => {
      try {
        const report = getTeamCapacity(database, {
          projectId, principalId, startDate, endDate,
          ...(configVersion === undefined ? {} : { configVersion }),
          ...(teamId === undefined ? {} : { teamId }),
        });
        return { content: [{ type: "text", text: JSON.stringify(report) }], structuredContent: report };
      } catch (error) {
        return toToolError(error);
      }
    },
  );

  server.registerTool(
    "definition_of_done_set",
    {
      title: "Definir Definition of Done",
      description: "Cria uma revisão imutável dos critérios compartilhados de conclusão do projeto.",
      inputSchema: z.object({
        projectId: z.string().uuid(),
        requestId: z.string().trim().min(1).max(128),
        expectedVersion: z.number().int().min(0),
        criteria: z.array(z.object({ id: z.string().uuid().optional(), description: z.string().trim().min(1).max(500) })).min(1).max(50),
        reason: z.string().trim().min(1).max(1_000),
      }),
      outputSchema: z.object({ revision: definitionOfDoneRevisionSchema, auditEventIds: z.array(z.string().uuid()) }),
    },
    ({ projectId, requestId, expectedVersion, criteria, reason }) => {
      try {
        const receipt = setDefinitionOfDone(database, { projectId, principalId, requestId, expectedVersion, criteria, reason });
        const result = { revision: receipt.value, auditEventIds: receipt.auditEventIds };
        return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
      } catch (error) {
        return toToolError(error);
      }
    },
  );

  server.registerTool(
    "definition_of_done_get",
    {
      title: "Consultar Definition of Done",
      description: "Retorna a revisão atual ou uma revisão histórica da Definition of Done do projeto.",
      inputSchema: z.object({ projectId: z.string().uuid(), revisionNumber: z.number().int().positive().optional() }),
      outputSchema: definitionOfDoneRevisionSchema,
    },
    ({ projectId, revisionNumber }) => {
      try {
        const revision = getDefinitionOfDone(database, projectId, principalId, revisionNumber);
        return { content: [{ type: "text", text: JSON.stringify(revision) }], structuredContent: revision };
      } catch (error) {
        return toToolError(error);
      }
    },
  );

  server.registerTool(
    "sprint_draft",
    {
      title: "Planejar sprint",
      description: "Cria um rascunho de sprint com versão de capacidade e Definition of Done fixadas e PBIs Ready comprometidos.",
      inputSchema: z.object({
        projectId: z.string().uuid(),
        requestId: z.string().trim().min(1).max(128),
        teamId: z.string().uuid().optional(),
        sprintKey: z.string().trim().min(1).max(32),
        title: z.string().trim().min(1).max(120),
        goal: z.string().trim().min(1).max(1_000),
        startsOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        endsOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        itemIdsOrKeys: z.array(z.string().trim().min(1).max(80)).min(1).max(100),
        capacityConfigVersion: z.number().int().positive().optional(),
        definitionOfDoneRevision: z.number().int().positive().optional(),
        reason: z.string().trim().min(1).max(1_000),
      }),
      outputSchema: z.object({ sprint: sprintSchema, auditEventIds: z.array(z.string().uuid()) }),
    },
    ({ projectId, requestId, teamId, sprintKey, title, goal, startsOn, endsOn, itemIdsOrKeys, capacityConfigVersion, definitionOfDoneRevision, reason }) => {
      try {
        const receipt = createSprintDraft(database, {
          projectId, principalId, requestId, sprintKey, title, goal, startsOn, endsOn, itemIdsOrKeys, reason,
          ...(teamId === undefined ? {} : { teamId }),
          ...(capacityConfigVersion === undefined ? {} : { capacityConfigVersion }),
          ...(definitionOfDoneRevision === undefined ? {} : { definitionOfDoneRevision }),
        });
        const result = { sprint: receipt.value, auditEventIds: receipt.auditEventIds };
        return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
      } catch (error) {
        return toToolError(error);
      }
    },
  );

  server.registerTool(
    "sprint_scope_change",
    {
      title: "Alterar escopo da sprint",
      description: "Inclui ou remove PBIs do escopo, preservando cada alteração no histórico imutável.",
      inputSchema: z.object({
        projectId: z.string().uuid(),
        requestId: z.string().trim().min(1).max(128),
        sprintIdOrKey: z.string().trim().min(1).max(80),
        expectedVersion: z.number().int().positive(),
        addItemIdsOrKeys: z.array(z.string().trim().min(1).max(80)).max(100).optional(),
        removeItemIdsOrKeys: z.array(z.string().trim().min(1).max(80)).max(100).optional(),
        reason: z.string().trim().min(1).max(1_000),
      }),
      outputSchema: z.object({ sprint: sprintSchema, auditEventIds: z.array(z.string().uuid()) }),
    },
    ({ projectId, requestId, sprintIdOrKey, expectedVersion, addItemIdsOrKeys, removeItemIdsOrKeys, reason }) => {
      try {
        const receipt = changeSprintScope(database, {
          projectId, principalId, requestId, sprintIdOrKey, expectedVersion, reason,
          ...(addItemIdsOrKeys === undefined ? {} : { addItemIdsOrKeys }),
          ...(removeItemIdsOrKeys === undefined ? {} : { removeItemIdsOrKeys }),
        });
        const result = { sprint: receipt.value, auditEventIds: receipt.auditEventIds };
        return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
      } catch (error) {
        return toToolError(error);
      }
    },
  );

  server.registerTool(
    "sprint_start",
    {
      title: "Iniciar sprint",
      description: "Valida escopo, baseline e capacidade; inicia a sprint com snapshots de capacidade e Definition of Done.",
      inputSchema: z.object({
        projectId: z.string().uuid(), requestId: z.string().trim().min(1).max(128),
        sprintIdOrKey: z.string().trim().min(1).max(80), expectedVersion: z.number().int().positive(),
        reason: z.string().trim().min(1).max(1_000),
      }),
      outputSchema: z.object({ sprint: sprintSchema, auditEventIds: z.array(z.string().uuid()) }),
    },
    ({ projectId, requestId, sprintIdOrKey, expectedVersion, reason }) => {
      try {
        const receipt = startSprint(database, { projectId, principalId, requestId, sprintIdOrKey, expectedVersion, reason });
        const result = { sprint: receipt.value, auditEventIds: receipt.auditEventIds };
        return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
      } catch (error) {
        return toToolError(error);
      }
    },
  );

  server.registerTool(
    "sprint_close",
    {
      title: "Encerrar sprint",
      description: "Registra a revisão, PBIs aceitos e itens incompletos em um snapshot auditável.",
      inputSchema: z.object({
        projectId: z.string().uuid(), requestId: z.string().trim().min(1).max(128),
        sprintIdOrKey: z.string().trim().min(1).max(80), expectedVersion: z.number().int().positive(),
        acceptedItemIds: z.array(z.string().trim().min(1).max(80)).max(100),
        reviewSummary: z.string().trim().min(1).max(2_000), reason: z.string().trim().min(1).max(1_000),
      }),
      outputSchema: z.object({ sprint: sprintSchema, auditEventIds: z.array(z.string().uuid()) }),
    },
    ({ projectId, requestId, sprintIdOrKey, expectedVersion, acceptedItemIds, reviewSummary, reason }) => {
      try {
        const receipt = closeSprint(database, {
          projectId, principalId, requestId, sprintIdOrKey, expectedVersion, acceptedItemIds, reviewSummary, reason,
        });
        const result = { sprint: receipt.value, auditEventIds: receipt.auditEventIds };
        return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
      } catch (error) {
        return toToolError(error);
      }
    },
  );

  server.registerTool(
    "sprint_cancel",
    {
      title: "Cancelar sprint",
      description: "Cancela uma sprint draft ou ativa, preservando escopo e transição no histórico.",
      inputSchema: z.object({
        projectId: z.string().uuid(), requestId: z.string().trim().min(1).max(128),
        sprintIdOrKey: z.string().trim().min(1).max(80), expectedVersion: z.number().int().positive(),
        reason: z.string().trim().min(1).max(1_000),
      }),
      outputSchema: z.object({ sprint: sprintSchema, auditEventIds: z.array(z.string().uuid()) }),
    },
    ({ projectId, requestId, sprintIdOrKey, expectedVersion, reason }) => {
      try {
        const receipt = cancelSprint(database, { projectId, principalId, requestId, sprintIdOrKey, expectedVersion, reason });
        const result = { sprint: receipt.value, auditEventIds: receipt.auditEventIds };
        return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
      } catch (error) {
        return toToolError(error);
      }
    },
  );

  server.registerTool(
    "sprint_retrospective_set",
    {
      title: "Registrar retrospectiva da sprint",
      description: "Cria uma revisão imutável da retrospectiva de uma sprint fechada. Exige facilitador humano e responsáveis humanos do projeto.",
      inputSchema: z.object({
        projectId: z.string().uuid(),
        requestId: z.string().trim().min(1).max(128),
        sprintIdOrKey: z.string().trim().min(1).max(80),
        expectedVersion: z.number().int().nonnegative(),
        summary: z.string().trim().min(1).max(2_000),
        keepDoing: z.array(z.string().trim().min(1).max(500)).max(20),
        stopDoing: z.array(z.string().trim().min(1).max(500)).max(20),
        tryNext: z.array(z.string().trim().min(1).max(500)).max(20),
        actions: z.array(z.object({
          id: z.string().uuid().optional(),
          title: z.string().trim().min(1).max(300),
          ownerPrincipalId: z.string().uuid(),
          linkedWorkItemIdOrKey: z.string().trim().min(1).max(80).optional(),
        })).max(50),
        reason: z.string().trim().min(1).max(1_000),
      }),
      outputSchema: z.object({
        retrospective: sprintRetrospectiveRevisionSchema,
        auditEventIds: z.array(z.string().uuid()),
      }),
    },
    async (input) => {
      try {
        const receipt = setSprintRetrospective(database, { ...input, principalId });
        const result = { retrospective: receipt.value, auditEventIds: receipt.auditEventIds };
        return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
      } catch (error) {
        return toToolError(error);
      }
    },
  );

  server.registerTool(
    "sprint_retrospective_get",
    {
      title: "Consultar retrospectiva da sprint",
      description: "Retorna retrospectiva atual ou revisão histórica e a lista de revisões da sprint.",
      inputSchema: z.object({
        projectId: z.string().uuid(),
        sprintIdOrKey: z.string().trim().min(1).max(80),
        revisionNumber: z.number().int().positive().optional(),
      }),
      outputSchema: sprintRetrospectiveReadSchema,
    },
    ({ projectId, sprintIdOrKey, revisionNumber }) => {
      try {
        const result = getSprintRetrospective(database, {
          projectId,
          principalId,
          sprintIdOrKey,
          ...(revisionNumber === undefined ? {} : { revisionNumber }),
        });
        return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
      } catch (error) {
        return toToolError(error);
      }
    },
  );

  server.registerTool(
    "sprint_get",
    {
      title: "Consultar sprint",
      description: "Retorna sprint, escopo vigente, histórico de alterações e snapshots de início e encerramento.",
      inputSchema: z.object({ projectId: z.string().uuid(), sprintIdOrKey: z.string().trim().min(1).max(80) }),
      outputSchema: sprintSchema,
    },
    ({ projectId, sprintIdOrKey }) => {
      try {
        const sprint = getSprint(database, projectId, principalId, sprintIdOrKey);
        return { content: [{ type: "text", text: JSON.stringify(sprint) }], structuredContent: sprint };
      } catch (error) {
        return toToolError(error);
      }
    },
  );

  server.registerTool(
    "sprint_list",
    {
      title: "Listar sprints",
      description: "Lista sprints do projeto, com filtros opcionais por estado.",
      inputSchema: z.object({
        projectId: z.string().uuid(), teamId: z.string().uuid().optional(),
        statuses: z.array(z.enum(sprintStates)).max(4).optional(), limit: z.number().int().min(1).max(100).optional(),
      }),
      outputSchema: z.object({ sprints: z.array(sprintSchema) }),
    },
    ({ projectId, teamId, statuses, limit }) => {
      try {
        const sprints = listSprints(database, projectId, principalId, {
          ...(statuses === undefined ? {} : { statuses }),
          ...(limit === undefined ? {} : { limit }),
          ...(teamId === undefined ? {} : { teamId }),
        });
        const result = { sprints };
        return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
      } catch (error) {
        return toToolError(error);
      }
    },
  );

  server.registerTool(
    "work_item_gate_check",
    {
      title: "Verificar gates do item",
      description: "Mostra os critérios pendentes para Ready ou Done, incluindo baseline, evidência, cenários e build candidato. transitionPath lista os estados a percorrer (ex.: in_review, in_validation, done) a partir do estado atual.",
      inputSchema: z.object({
        projectId: z.string().uuid(),
        itemIdOrKey: z.string().trim().min(1).max(80),
        targetState: z.enum(["ready", "done"]),
        buildId: z.string().trim().min(1).max(128).optional(),
      }),
      outputSchema: workItemGateReportSchema,
    },
    ({ projectId, itemIdOrKey, targetState, buildId }) => {
      try {
        const report = getWorkItemGateReport(database, {
          projectId, principalId, itemIdOrKey, targetState,
          ...(buildId === undefined ? {} : { buildId }),
        });
        return { content: [{ type: "text", text: JSON.stringify(report) }], structuredContent: report };
      } catch (error) {
        return toToolError(error);
      }
    },
  );

  server.registerTool(
    "work_item_quality_get",
    {
      title: "Consultar qualidade do item",
      description: "Consolida critérios, cenários, últimas execuções por build, certificações e evidências na baseline ou em modo preview.",
      inputSchema: z.object({
        projectId: z.string().uuid().describe("UUID do projeto retornado por project_list."),
        itemIdOrKey: z.string().trim().min(1).max(80).describe("UUID ou chave de uma história ou bug."),
        evidenceCursor: z.string().max(4_096).optional()
          .describe("Cursor nextEvidenceCursor da resposta anterior para continuar a página de evidências."),
      }),
      outputSchema: workItemQualityReportSchema,
    },
    ({ projectId, itemIdOrKey, evidenceCursor }) => {
      try {
        const report = getWorkItemQualityReport(database, {
          projectId, principalId, itemIdOrKey,
          ...(evidenceCursor === undefined ? {} : { evidenceCursor }),
        });
        return { content: [{ type: "text", text: JSON.stringify(report) }], structuredContent: report };
      } catch (error) {
        return toToolError(error);
      }
    },
  );

  server.registerTool(
    "work_item_transition",
    {
      title: "Alterar estado do item",
      description: "Executa uma transição autorizada, registra histórico auditado e cria a baseline ao entrar em Ready.",
      inputSchema: z.object({
        projectId: z.string().uuid(),
        requestId: z.string().trim().min(1).max(128),
        itemIdOrKey: z.string().trim().min(1).max(80),
        targetState: z.enum(workItemStates),
        expectedVersion: z.number().int().positive(),
        reason: z.string().trim().min(1).max(1_000),
        buildId: z.string().trim().min(1).max(128).optional(),
      }),
      outputSchema: z.object({
        transition: workItemTransitionSchema,
        baseline: z.object({ id: z.string().uuid(), sequence: z.number().int().positive() }).nullable(),
        auditEventIds: z.array(z.string().uuid()),
      }),
    },
    ({ projectId, requestId, itemIdOrKey, targetState, expectedVersion, reason, buildId }) => {
      try {
        const receipt = transitionWorkItem(database, {
          projectId, principalId, requestId, itemIdOrKey, targetState, expectedVersion, reason,
          ...(buildId === undefined ? {} : { buildId }),
        });
        const result = { ...receipt.value, auditEventIds: receipt.auditEventIds };
        return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
      } catch (error) {
        return toToolError(error);
      }
    },
  );

  server.registerTool(
    "evidence_add",
    {
      title: "Adicionar evidência",
      description: "Anexa uma referência imutável a PR, commit, build, artefato ou relatório ao item e à baseline atual.",
      inputSchema: z.object({
        projectId: z.string().uuid(),
        requestId: z.string().trim().min(1).max(128),
        itemIdOrKey: z.string().trim().min(1).max(80),
        kind: z.enum(evidenceKinds),
        uri: z.string().trim().min(1).max(2_048),
        buildId: z.string().trim().min(1).max(128).optional(),
        description: z.string().trim().min(1).max(2_000),
      }),
      outputSchema: z.object({ evidence: workItemEvidenceSchema, auditEventIds: z.array(z.string().uuid()) }),
    },
    ({ projectId, requestId, itemIdOrKey, kind, uri, buildId, description }) => {
      try {
        const receipt = addWorkItemEvidence(database, {
          projectId, principalId, requestId, itemIdOrKey, kind, uri, description,
          ...(buildId === undefined ? {} : { buildId }),
        });
        const result = { evidence: receipt.value, auditEventIds: receipt.auditEventIds };
        return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
      } catch (error) {
        return toToolError(error);
      }
    },
  );

  server.registerTool(
    "evidence_list",
    {
      title: "Listar evidências",
      description: "Lista evidências em páginas estáveis; cursor fica obsoleto após alteração do projeto.",
      inputSchema: z.object({
        projectId: z.string().uuid(),
        itemIdOrKey: z.string().trim().min(1).max(80),
        limit: z.number().int().min(1).max(100).optional(),
        cursor: z.string().max(2_048).optional(),
      }),
      outputSchema: z.object({ evidence: z.array(workItemEvidenceSchema), nextCursor: z.string().nullable() }),
    },
    ({ projectId, itemIdOrKey, limit, cursor }) => {
      try {
        const result = listWorkItemEvidence(database, {
          projectId, principalId, itemIdOrKey,
          ...(limit === undefined ? {} : { limit }),
          ...(cursor === undefined ? {} : { cursor }),
        });
        return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
      } catch (error) {
        return toToolError(error);
      }
    },
  );

  server.registerTool(
    "test_run_certify",
    {
      title: "Certificar execução de QA",
      description: "Permite a uma pessoa QA certificar a última execução aprovada de cenário da baseline enquanto o PBI está em validação.",
      inputSchema: z.object({
        projectId: z.string().uuid(),
        requestId: z.string().trim().min(1).max(128),
        itemIdOrKey: z.string().trim().min(1).max(80),
        runId: z.string().uuid(),
        expectedVersion: z.number().int().positive(),
        reason: z.string().trim().min(1).max(1_000),
      }),
      outputSchema: z.object({ certification: testRunCertificationSchema.extend({ version: z.number().int().positive() }), auditEventIds: z.array(z.string().uuid()) }),
    },
    ({ projectId, requestId, itemIdOrKey, runId, expectedVersion, reason }) => {
      try {
        const receipt = certifyTestRun(database, {
          projectId, principalId, requestId, itemIdOrKey, runId, expectedVersion, reason,
        });
        const result = { certification: receipt.value, auditEventIds: receipt.auditEventIds };
        return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
      } catch (error) {
        return toToolError(error);
      }
    },
  );

  server.registerTool(
    "trace_link_add",
    {
      title: "Adicionar ligação de rastreabilidade",
      description: "Adiciona depends_on, relates_to ou implements, validando tipos de endpoint e ciclos de dependência.",
      inputSchema: z.object({
        projectId: z.string().uuid(),
        requestId: z.string().trim().min(1).max(128),
        sourceIdOrKey: z.string().trim().min(1).max(80),
        targetIdOrKey: z.string().trim().min(1).max(80),
        type: z.enum(traceLinkTypes),
      }),
      outputSchema: z.object({
        link: traceLinkReceiptSchema,
        auditEventIds: z.array(z.string().uuid()),
      }),
    },
    ({ projectId, requestId, sourceIdOrKey, targetIdOrKey, type }) => {
      try {
        const receipt = addTraceLink(database, {
          projectId,
          principalId,
          requestId,
          sourceIdOrKey,
          targetIdOrKey,
          type,
        });
        const result = { link: receipt.value, auditEventIds: receipt.auditEventIds };
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          structuredContent: result,
        };
      } catch (error) {
        return toToolError(error);
      }
    },
  );

  server.registerTool(
    "trace_link_remove",
    {
      title: "Remover ligação de rastreabilidade",
      description: "Retira uma ligação da visão corrente sem apagar o histórico.",
      inputSchema: z.object({
        projectId: z.string().uuid(),
        requestId: z.string().trim().min(1).max(128),
        linkId: z.string().uuid(),
      }),
      outputSchema: z.object({
        link: z.object({ id: z.string().uuid(), removedAt: z.string().datetime() }),
        auditEventIds: z.array(z.string().uuid()),
      }),
    },
    ({ projectId, requestId, linkId }) => {
      try {
        const receipt = removeTraceLink(database, { projectId, principalId, requestId, linkId });
        const result = { link: receipt.value, auditEventIds: receipt.auditEventIds };
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          structuredContent: result,
        };
      } catch (error) {
        return toToolError(error);
      }
    },
  );

  server.registerTool(
    "trace_query",
    {
      title: "Consultar rastreabilidade",
      description: "Expande ligações ativas até três níveis e sinaliza cortes por orçamento.",
      inputSchema: z.object({
        projectId: z.string().uuid(),
        nodeIdOrKey: z.string().trim().min(1).max(80),
        direction: z.enum(["inbound", "outbound", "both"]).optional(),
        linkTypes: z.array(z.enum(traceLinkTypes)).min(1).max(3).optional(),
        depth: z.number().int().min(1).max(3).optional(),
        maxNodes: z.number().int().min(1).max(100).optional(),
      }),
      outputSchema: traceGraphSchema,
    },
    ({ projectId, nodeIdOrKey, direction, linkTypes, depth, maxNodes }) => {
      try {
        const graph = queryTraceGraph(database, {
          projectId,
          principalId,
          nodeIdOrKey,
          ...(direction === undefined ? {} : { direction }),
          ...(linkTypes === undefined ? {} : { linkTypes }),
          ...(depth === undefined ? {} : { depth }),
          ...(maxNodes === undefined ? {} : { maxNodes }),
        });
        return {
          content: [{ type: "text", text: JSON.stringify(graph) }],
          structuredContent: graph,
        };
      } catch (error) {
        return toToolError(error);
      }
    },
  );

  server.registerPrompt(
    "ssdd_refine_backlog",
    {
      title: "Refinar backlog SSDD",
      description: "Transforma uma necessidade em PBIs e tarefas verificáveis, preservando hierarquia, dependências e aprovação humana.",
      argsSchema: z.object({
        projectId: z.string().uuid(),
        epicIdOrKey: z.string().trim().min(1).max(80).optional(),
        outcome: z.string().trim().min(1).max(1_000).optional(),
      }),
    },
    ({ projectId, epicIdOrKey, outcome }) => ({
      messages: [{
        role: "user",
        content: {
          type: "text",
          text: [
            "Atue como Product Owner SSDD e refine o resultado desejado antes de propor implementação.",
            `Projeto: ${projectId}.`,
            ...(epicIdOrKey ? [`Épico em foco: ${epicIdOrKey}.`] : []),
            ...(outcome ? [`Resultado solicitado: ${outcome}.`] : []),
            "Leia project_get e work_item_list; localize itens existentes, estados, revisões publicadas, critérios e tarefas filhas. Use trace_query e task_context_get quando rastreabilidade, dependências ou baseline mudarem a decisão.",
            "Use project_feature_roadmap_get para comparar prioridade efetiva, valor de negócio, progresso e dependências. Separe prioridade P1–P4 de score 0–100. Para o score, proponha evidências nas cinco dimensões PO (impacto, risco, alinhamento, habilitação/reuso, urgência), 0–20 cada; o PO publica a soma e registra a decomposição/rationale. Não invente scores nem complete dados sem avaliação humana.",
            "Use spec_list/spec_get para consultar regras de negócio e o glossário publicados quando termos de domínio afetarem a política. O contexto de tarefa não inclui o glossário automaticamente; use spec_get para SSDD-GLOSS-CORE-01 quando termos de domínio forem relevantes.",
            "Separe necessidade do usuário, história/bug, critérios de aceite observáveis e tarefas técnicas testáveis. Proponha cobertura de cada critério por cenário publicado e identifique quais tarefas devem ser associadas ao cenário e aos runs que as validarem. Cubra sucesso, validações, falhas e autorização quando aplicável; identifique dependências em vez de duplicar trabalho.",
            "Não invente chaves SSDD-###: ao criar itens por solicitação explícita, deixe work_item_create emitir as chaves. Sugira pontos somente para PBIs e horas somente para tarefas; nunca converta uma unidade na outra.",
            "Sem solicitação explícita para gravar, entregue somente a proposta. Mesmo quando solicitada a gravação, mantenha itens novos em Draft e não publique revisões, confirme estimativas, altere escopo ou avance estados sem autorização humana e gates válidos.",
            "Retorne fatos encontrados, hierarquia proposta, critérios, tarefas, dependências, estimativas com premissas, riscos e perguntas que bloqueiam o aceite.",
          ].join("\n"),
        },
      }],
    }),
  );

  server.registerPrompt(
    "ssdd_refine_technical_design",
    {
      title: "Refinar desenho técnico SSDD",
      description: "Transforma um PBI aceito em decisões técnicas, tarefas implementáveis e rastreabilidade verificável.",
      argsSchema: z.object({
        projectId: z.string().uuid(),
        itemIdOrKey: z.string().trim().min(1).max(80),
        outcome: z.string().trim().min(1).max(1_000).optional(),
      }),
    },
    ({ projectId, itemIdOrKey, outcome }) => ({
      messages: [{
        role: "user",
        content: {
          type: "text",
          text: [
            "Atue como Technical Lead SSDD e refine o desenho técnico sem redefinir a necessidade de negócio.",
            `Projeto: ${projectId}; PBI ou tarefa em foco: ${itemIdOrKey}.`,
            ...(outcome ? [`Resultado ou restrição adicional: ${outcome}.`] : []),
            "Leia project_get, work_item_get, task_context_get com profile=dev, include=[hierarchy, acceptanceCriteria, businessRules, technicalDecisions, scenarios, testRuns, baseline], e work_item_gate_check; confira revisões publicadas, baseline, critérios, regras, decisões, cenários, runs por build, avisos de drift, dependências e papéis disponíveis. Use trace_query, spec_get, spec_list e adr_search para entender decisões relacionadas.",
            "O contexto de tarefa não inclui o glossário automaticamente; use spec_get para SSDD-GLOSS-CORE-01 quando termos de domínio forem relevantes. Siga nextCursor e resources quando o contexto estiver truncado ou mover uma entrada para resource.",
            "Separe requisito/critério de aceite de decisão técnica. Proponha componentes, contratos, fluxo de dados, limites de transação, autorização, isolamento por projeto, idempotência, migração/rollback, observabilidade, riscos e estratégia de testes conforme o escopo exigir.",
            "Decomponha apenas trabalho implementável e verificável; preserve a prioridade e o valor herdados da Feature, levante lacunas para decisão PO e descreva dependências e aceite por tarefa. Use horas para tarefas e pontos somente para PBIs, com premissas explícitas e sem converter unidades.",
            "Para cada tarefa que precise de execução detalhada, use task_workflow_get e proponha 1-50 etapas ordenadas, com instrução e resultado observável. Os pesos relativos aceitam até duas casas e precisam totalizar exatamente 100.00%; eles não representam horas/pontos nem cobertura QA. Etapas avançam Pendente→Em andamento→Concluída em ordem; só Concluída soma no progresso. Não publique Draft: somente Tech Lead humano publica e apenas sem sessões abertas.",
            "Quando houver especificação técnica publicada, proponha rastreabilidade work item → specification com trace_link_add do tipo implements e valide que task_context_get devolve a decisão esperada. Se faltar uma decisão duradoura, recomende criar/revisar uma specification; não trate texto do prompt ou comentário como especificação aprovada.",
            "Sem solicitação explícita para gravar, entregue somente a proposta. Mesmo se solicitada gravação, mantenha revisões em Draft e não publique, confirme estimativas ou avance workflow sem pessoa autorizada e gates válidos. Não invente dados, chaves, métricas nem evidência de teste.",
            "Entregue: fatos verificados; decisões e alternativas; tarefas/dependências; vínculos de rastreabilidade propostos; matriz requisito→regra/especificação→tarefa→cenário→build/run; riscos, rollout/rollback e perguntas bloqueantes.",
          ].join("\n"),
        },
      }],
    }),
  );

  server.registerPrompt(
    "ssdd_plan_sprint",
    {
      title: "Refinar o planejamento SSDD",
      description: "Ajuda PO e facilitador a decompor escopo em itens verificáveis, dependências e capacidade.",
      argsSchema: z.object({
        projectId: z.string().uuid(),
        epicIdOrKey: z.string().trim().min(1).max(80).optional(),
        sprintGoal: z.string().trim().min(1).max(500).optional(),
      }),
    },
    ({ projectId, epicIdOrKey, sprintGoal }) => ({
      messages: [{
        role: "user",
        content: {
          type: "text",
          text: [
            "Atue como Product Owner/facilitador deste projeto SSDD.",
            `Projeto: ${projectId}.`,
            ...(epicIdOrKey ? [`Épico em foco: ${epicIdOrKey}.`] : []),
            ...(sprintGoal ? [`Objetivo informado: ${sprintGoal}.`] : []),
            "Consulte project_get, team_list, sprint_list, definition_of_done_get e work_item_list. Se houver vários times, peça ou use o teamId informado; consulte team_capacity_get para o intervalo exato proposto.",
            "Para cada PBI candidato, consulte work_item_gate_check e task_context_get; use trace_query para dependências. Diferencie pontos de PBIs de horas de tarefas e explicite cobertura de capacidade, DoD, bloqueios e itens fora de Ready.",
            "Consulte project_feature_roadmap_get para ordenar Features por prioridade efetiva (P1 primeiro), depois business value score (0–100, maior primeiro), rank e chave. São dimensões distintas: score ausente não é zero; não invente nem faça backfill, solicite avaliação PO com justificativa. Planeje as sprints nessa sequência sem contrariar dependências e capacidade. Datas só podem ser usadas quando há três sprints comparáveis, escopo estimado e nenhum bloqueio externo; uma previsão continua sendo hipótese, não compromisso.",
            "Proponha objetivo de sprint claro, seleção pequena e critérios observáveis. Preserve as chaves existentes; apresente lacunas e premissas sem inventar dados de capacidade ou velocidade.",
            "Entregue proposta, total de pontos, horas de tarefas e capacidade em unidades separadas, dependências, riscos e perguntas abertas. Não grave sprint draft/escopo nem inicie sprint sem solicitação explícita e confirmação humana exigida pelo gate.",
          ].join("\n"),
        },
      }],
    }),
  );

  server.registerPrompt(
    "ssdd_start_task",
    {
      title: "Iniciar desenvolvimento de uma tarefa",
      description: "Carrega contexto Dev, critérios, baseline e dependências antes de implementar e testar.",
      argsSchema: z.object({
        projectId: z.string().uuid(),
        taskIdOrKey: z.string().trim().min(1).max(80),
      }),
    },
    ({ projectId, taskIdOrKey }) => ({
      messages: [{
        role: "user",
        content: {
          type: "text",
          text: [
            "Atue como Developer neste projeto SSDD.",
            `Projeto: ${projectId}; tarefa: ${taskIdOrKey}.`,
            "Use work_item_list com assignedToMe=true quando precisar descobrir ou conferir as tarefas atribuídas ao principal Developer autenticado; nunca escolha a identidade de outra pessoa para esse filtro.",
            "Para selecionar a próxima tarefa, consulte task_execution_queue_get (assignedToMe=true por padrão) e escolha a primeira tarefa startable. Ordem: P1 antes de P4; entre prioridades iguais, maior valor de negócio (0–100), depois rank da Feature/tarefa. Valor desconhecido fica no fim e deve ser refinado pelo PO; fila não substitui task_start_check.",
            "Antes de editar, consulte work_item_get e task_context_get com profile=dev e include=[hierarchy, acceptanceCriteria, businessRules, technicalDecisions, scenarios, testRuns, baseline]. Leia critérios, regras, decisões, cenários, execuções por build, revisões pinned e avisos de drift; siga cursor/resource quando necessário. Use task_start_check para conferir status, atribuição, PBI pai, baseline, dependências, papel, ADRs implementing publicados e sessões abertas.",
            "O contexto de tarefa não inclui o glossário automaticamente; use spec_get para SSDD-GLOSS-CORE-01 quando termos de domínio forem relevantes. Siga nextCursor e resources quando o contexto estiver truncado ou mover uma entrada para resource.",
            "Consulte task_workflow_get antes de começar. Se houver Draft sem workflow publicado, o início está bloqueado até publicação por Tech Lead humano; não tente contornar. Siga a revisão publicada pinada pela sessão e avance uma etapa por vez: Pendente→Em andamento→Concluída. O percentual é somente a soma dos pesos Done; 100% não significa QA aprovado. Se não houver workflow publicado, progresso é desconhecido.",
            "Quando a pessoa pedir para iniciar, consulte task_start_check. Draft precisa ser refinada e aprovada em Ready; não tente iniciar Draft. Se houver uma sessão pausada sua, retome-a com development_session_transition; uma sessão pausada de outro Developer exige que o dono a encerre ou cancele. Para qualquer outro bloqueio — dependência, baseline, ADR implementing não publicado, atribuição/papel, status ou sessão concorrente — explique o código e a ação necessária; não altere a tarefa para contornar o gate. Só chame task_start quando canStart=true, usando expectedVersion retornada, motivo e requestId novo; task_start revalida e muda Ready para in_progress e abre a sessão atomicamente. Guarde session.id, sua version e task.version. Para iniciar várias tarefas independentes em paralelo, cada agente precisa de atribuição e sessão próprias e checkout/worktree Git isolado; o MCP não reserva arquivos e não evita conflito de edição entre worktrees.",
            "Ao interromper, retome ou terminar o esforço de desenvolvimento, chame development_session_transition com pause/resume/complete e motivo; conclua a sessão mesmo que o item continue em revisão. O serviço registra timestamps UTC e duração ativa. Nunca invente nome, sessão, data ou horas.",
            "Inspecione git status e os diffs existentes antes de editar. Preserve alterações preexistentes e não reverta trabalho alheio à tarefa.",
            "Implemente somente o escopo aceito e acrescente testes de regressão para o comportamento alterado. Execute npm run check quando o repositório usar esse comando e reporte a saída real.",
            "Atualize documentação e status na mesma mudança. Preserve IDs SSDD-###. Não invente evidência de build/QA nem certifique cenários; peça confirmação humana para transições ou operações gated.",
            "Ao concluir, resuma arquivos alterados, decisões, comandos executados, resultados e riscos restantes.",
          ].join("\n"),
        },
      }],
    }),
  );

  server.registerPrompt(
    "ssdd_validate_quality",
    {
      title: "Validar qualidade SSDD",
      description: "Prepara uma validação de QA baseada em critérios, cenários publicados, build e evidência real.",
      argsSchema: z.object({
        projectId: z.string().uuid(),
        itemIdOrKey: z.string().trim().min(1).max(80),
        buildId: z.string().trim().min(1).max(200).optional(),
      }),
    },
    ({ projectId, itemIdOrKey, buildId }) => ({
      messages: [{
        role: "user",
        content: {
          type: "text",
          text: [
            "Atue como QA deste projeto SSDD e valide o PBI sem presumir aprovação.",
            `Projeto: ${projectId}; item: ${itemIdOrKey}.`,
            ...(buildId ? [`Build candidata: ${buildId}.`] : []),
            "Comece por work_item_quality_get para ver critérios, cobertura, cenário, execução mais recente por build, certificação e evidências na baseline/preview. Confira baseline_get e work_item_gate_check; use scenario_criterion_search e test_run_list para investigar lacunas ou filtrar a build candidata. Confirme que as revisões são as mesmas da baseline.",
            "Para uma tarefa, task_workflow_get mostra a decomposição publicada e ajuda a selecionar casos de teste; progresso ponderado, mesmo em 100%, não é resultado, cobertura nem certificação QA.",
            "O contexto de tarefa não inclui o glossário automaticamente; use spec_get para SSDD-GLOSS-CORE-01 quando termos de domínio forem relevantes.",
            "test_run_record é uma gravação, não uma consulta: use-o somente depois de executar ou observar de fato o teste, com cenário/revisão publicada, build exata, resultado e evidência reproduzível. Nunca crie um run para preencher lacunas de documentação.",
            "Reporte falhas, cobertura ausente, revisão/build incompatível e drift. Se não houver build ou acesso aos testes, declare a validação bloqueada em vez de inferir aprovação.",
            "Nunca invente execução, build, evidência ou certificação. test_run_certify e a transição para Done exigem o papel QA/gates aplicáveis; deixe a certificação para uma pessoa QA autorizada.",
            "Entregue matriz critério→cenário→resultado→evidência e uma recomendação explícita: bloqueado, pronto para revisão humana ou validado com gate aplicável.",
          ].join("\n"),
        },
      }],
    }),
  );

  server.registerPrompt(
    "ssdd_release_readiness",
    {
      title: "Revisar prontidão de release",
      description: "Reúne gates, métricas, validação local/remota, documentação e pendências antes de uma release.",
      argsSchema: z.object({
        projectId: z.string().uuid(),
        milestoneIdOrKey: z.string().trim().min(1).max(80).optional(),
      }),
    },
    ({ projectId, milestoneIdOrKey }) => ({
      messages: [{
        role: "user",
        content: {
          type: "text",
          text: [
            "Atue como release manager deste projeto SSDD.",
            `Projeto: ${projectId}.`,
            ...(milestoneIdOrKey ? [`Marco em análise: ${milestoneIdOrKey}.`] : []),
            "Consulte project_get, metrics_get, milestone_get ou milestone_list, work_item_list e work_item_gate_check para consolidar o escopo. Para cada item da release, confira o gate com build explícita e leia deployment_event_list para preservar o histórico.",
            "Use milestone_forecast_history e milestone_forecast_recalculate para conferir snapshots e reprodutibilidade quando houver previsões. Use github_reference_list somente quando existir mapeamento GitHub e trate seu resultado como referências de PR/workflow recebidas pelo webhook; não infira o estado geral da CI. Verifique pacote, versão do manifesto, documentação e comandos locais apenas com evidência acessível.",
            "Homologação e produção são eventos imutáveis, independentes do estado Done. Registre deployment_event_record somente após confirmar o resultado no ambiente; produção aprovada precisa usar o mesmo build que passou em homologação. Rollback é outro evento e referencia o deploy revertido.",
            "Separe fatos verificados de itens não verificados e associe evidências ao commit/build candidato exatos. Para cada gap, cite a ferramenta, arquivo ou comando que pode resolvê-lo.",
            "Não publique artefato, crie tag ou faça deploy. Essas ações precisam de solicitação explícita do usuário e de aceite dos gates.",
            "Retorne decisão recomendada, itens bloqueantes, evidências, riscos residuais e próximo passo de menor custo.",
          ].join("\n"),
        },
      }],
    }),
  );

  server.registerPrompt(
    "ssdd_design_tests",
    {
      title: "Desenhar cobertura de testes SSDD",
      description: "Converte critérios e regras publicadas em cenários rastreáveis, sem registrar execução fictícia.",
      argsSchema: z.object({
        projectId: z.string().uuid(),
        itemIdOrKey: z.string().trim().min(1).max(80),
      }),
    },
    ({ projectId, itemIdOrKey }) => ({
      messages: [{
        role: "user",
        content: {
          type: "text",
          text: [
            "Atue como Test Designer SSDD. Projete cobertura verificável a partir do contrato publicado; não declare teste executado.",
            `Projeto: ${projectId}; item: ${itemIdOrKey}.`,
            "Leia project_get, work_item_get, work_item_quality_get e work_item_gate_check. Para uma tarefa, use task_context_get com profile=qa e seções hierarchy, acceptanceCriteria, businessRules, technicalDecisions, scenarios, testRuns e baseline.",
            "O contexto de tarefa não inclui o glossário automaticamente; use spec_get para SSDD-GLOSS-CORE-01 quando termos de domínio forem relevantes. Siga nextCursor e resources quando o contexto estiver truncado ou mover uma entrada para resource.",
            "Use scenario_criterion_search e test_run_list para conferir cobertura existente, revisão publicada e resultados por build antes de propor novos cenários.",
            "Produza uma matriz critério → regra/especificação → cenário → tarefa vinculada. Para cada cenário, defina pré-condições, dados, ação e resultado observável; inclua sucesso, entradas inválidas, falhas, limites, autorização e regressão quando se aplicarem.",
            "Identifique IDs reais de critério, especificações e tarefas. Sugira cenários ou vínculos em Draft somente se o usuário pedir para registrar a proposta. Não publique revisão nem use test_run_record, test_run_certify ou evidência sem execução real e pessoa QA autorizada.",
            "Reporte lacunas, duplicatas, drift, dependências de ambiente/build e decisões de negócio ainda não resolvidas.",
          ].join("\n"),
        },
      }],
    }),
  );

  server.registerPrompt(
    "ssdd_security_review",
    {
      title: "Revisar segurança de uma mudança SSDD",
      description: "Faz uma revisão de engenharia baseada em evidências para identidade, autorização, isolamento e operação.",
      argsSchema: z.object({
        projectId: z.string().uuid(),
        itemIdOrKey: z.string().trim().min(1).max(80).optional(),
        focus: z.string().trim().min(1).max(500).optional(),
      }),
    },
    ({ projectId, itemIdOrKey, focus }) => ({
      messages: [{
        role: "user",
        content: {
          type: "text",
          text: [
            "Atue como security reviewer SSDD em modo somente leitura. Esta revisão de engenharia não é pentest nem certificação de conformidade.",
            `Projeto: ${projectId}.`,
            ...(itemIdOrKey ? [`Item em foco: ${itemIdOrKey}.`] : []),
            ...(focus ? [`Foco informado: ${focus}.`] : []),
            "Confirme escopo, versões publicadas e baseline com project_get, work_item_get/work_item_list, spec_list/spec_get, trace_query, cenário/qualidade e gates. Para uma tarefa, leia task_context_get incluindo regras, decisões, cenários, execuções e baseline.",
            "O contexto de tarefa não inclui o glossário automaticamente; use spec_get para SSDD-GLOSS-CORE-01 quando termos de domínio forem relevantes.",
            "Inspecione fronteiras de confiança, autenticação/autorização, isolamento por projeto, menor privilégio, segredos, validação, replay/idempotência, concorrência, limites contra abuso, dados enviados a integrações, persistência, logs, erros e recuperação operacional conforme aplicável.",
            "Para cada achado, informe severidade e justificativa, evidência/localização, pré-condições do atacante, impacto e mitigação concreta. Separe comportamento verificado, inferência e evidência ausente. Não recomende uma severidade sem explicar o risco.",
            "Associe achados a critérios/especificações e proponha cenários de regressão. Não altere registros, não alegue que um bug foi corrigido sem verificação e não declare conformidade sem escopo e evidência adequados.",
          ].join("\n"),
        },
      }],
    }),
  );

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

async function configuredGithubIssues(
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

async function configuredAzureDevOpsWorkItems(
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

/** Versão otimista corrente do item, para encadear escritas sem releitura. */
function currentItemVersion(database: ReturnType<typeof openSqliteDatabase>, projectId: string, itemId: string): number {
  const row = database.prepare("SELECT version FROM work_items WHERE project_id = ? AND item_id = ?").get(projectId, itemId) as { version: number } | undefined;
  return row?.version ?? 1;
}

function toToolError(error: unknown) {
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
