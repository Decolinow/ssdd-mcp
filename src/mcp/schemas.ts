import { z } from "zod";
import { projectRoles } from "../application/local-identity.js";
import { specificationKinds, specificationRevisionStatuses } from "../domain/specifications.js";
import { traceLinkTypes } from "../domain/trace.js";
import { workItemStates, workItemTypes } from "../domain/work-items.js";
import { scenarioKinds, testRunResults } from "../domain/scenarios.js";
import { taskWorkflowRevisionStatuses, taskWorkflowStepStatuses } from "../domain/task-workflow.js";
import { taskContextProfiles, taskContextSections } from "../application/task-context.js";
import { evidenceKinds } from "../domain/workflow.js";
import { sprintStates } from "../domain/sprints.js";

export const projectListItemSchema = z.object({
  id: z.string().uuid(),
  key: z.string(),
  name: z.string(),
  timezone: z.string(),
  version: z.number().int().positive(),
  roles: z.array(z.string()),
});

export const projectDetailsSchema = projectListItemSchema.extend({
  productGoal: z.string(),
  createdAt: z.string().datetime(),
});

export const userProjectAccessSchema = z.object({
  projectId: z.string().uuid(),
  roles: z.array(z.enum(projectRoles)).min(1).max(projectRoles.length),
});
export const managedUserReceiptSchema = z.object({
  principalId: z.string().uuid(),
  displayName: z.string(),
  principalType: z.enum(["human", "agent", "service"]),
  projects: z.array(userProjectAccessSchema),
  authKeyId: z.string().uuid().nullable(),
  authKey: z.string().nullable(),
  authKeyIssued: z.boolean(),
  replayed: z.boolean(),
});
export const managedUsersSchema = z.object({
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

export const criterionStructureShape = {
  given: z.string().trim().min(1).max(2_000).optional(),
  when: z.string().trim().min(1).max(2_000).optional(),
  then: z.string().trim().min(1).max(2_000).optional(),
  verification: z.enum(["automated", "manual", "inspection"]).optional(),
  example: z.string().trim().min(1).max(2_000).optional(),
};

export const criterionSchema = z.object({
  id: z.string().uuid(),
  key: z.string(),
  description: z.string(),
  required: z.boolean(),
  position: z.number().int().positive(),
  ...criterionStructureShape,
});

export const workItemEstimateSchema = z.object({
  unit: z.enum(["points", "hours"]),
  value: z.number().int().positive(),
  proposalId: z.string().uuid(),
  confirmedByPrincipalId: z.string().uuid(),
  confirmedAt: z.string().datetime(),
});

export const workItemEstimateProposalSchema = z.object({
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

export const workItemCommentSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  itemId: z.string().uuid(),
  authorPrincipalId: z.string().uuid(),
  body: z.string(),
  createdAt: z.string().datetime(),
});

export const workItemSchema = z.object({
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

export const workItemContentRevisionSchema = z.object({
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

export const scenarioStepSchema = z.object({ action: z.string(), expected: z.string() });
export const scenarioCoverageTargetSchema = z.object({
  targetType: z.enum(["criterion", "specification"]),
  targetId: z.string().uuid(),
});
export const scenarioSnapshotSchema = z.object({
  title: z.string(),
  preconditions: z.array(z.string()),
  steps: z.array(scenarioStepSchema),
  coverage: z.array(scenarioCoverageTargetSchema),
});
export const scenarioRevisionSchema = z.object({
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
export const scenarioSummarySchema = z.object({
  id: z.string().uuid(),
  key: z.string(),
  kind: z.enum(scenarioKinds),
  title: z.string(),
  version: z.number().int().positive(),
  latestRevision: z.number().int().nonnegative(),
  publishedRevision: z.number().int().positive().nullable(),
});
export const scenarioSchema = scenarioSummarySchema.extend({
  projectId: z.string().uuid(),
  createdByPrincipalId: z.string().uuid(),
  createdAt: z.string().datetime(),
  revisions: z.array(scenarioRevisionSchema),
});
export const testRunSchema = z.object({
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
export const testRunPageSchema = z.object({
  runs: z.array(testRunSchema),
  nextCursor: z.string().nullable(),
  watermark: z.number().int().nonnegative(),
});
export const workflowGateSchema = z.object({
  id: z.string(),
  passed: z.boolean(),
  message: z.string(),
  details: z.unknown().optional(),
});
export const workItemGateReportSchema = z.object({
  itemId: z.string().uuid(),
  itemKey: z.string(),
  itemType: z.enum(workItemTypes),
  currentState: z.string(),
  targetState: z.enum(["ready", "done"]),
  buildId: z.string().nullable(),
  gates: z.array(workflowGateSchema),
  canProceed: z.boolean(),
  transitionPath: z.array(z.string()),
  policy: z.object({ level: z.enum(["lite", "standard", "strict"]), revisionNumber: z.number().int().positive().nullable() }),
  warnings: z.array(z.object({ code: z.string(), message: z.string() })),
});
export const workItemEvidenceSchema = z.object({
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
export const workItemTransitionSchema = z.object({
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
export const testRunCertificationSchema = z.object({
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
export const teamCapacityConfigurationSchema = z.object({
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
export const teamCapacityReportSchema = z.object({
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
export const teamSummarySchema = z.object({
  projectId: z.string().uuid(),
  teamId: z.string().uuid(),
  name: z.string().nullable(),
  isConfigured: z.boolean(),
  currentVersion: z.number().int().nonnegative(),
  currentGeneration: z.number().int().nonnegative(),
  memberCount: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
});
export const teamCapacityInputFieldsSchema = z.object({
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
export const milestoneScopeItemSchema = z.object({
  itemId: z.string().uuid(),
  itemKey: z.string(),
  title: z.string(),
  stateAtApproval: z.string(),
  currentState: z.string(),
  points: z.number().int().positive(),
  baselineId: z.string().uuid(),
  itemRevisionNumber: z.number().int().positive(),
});
export const milestoneSchema = z.object({
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
export const milestoneSummarySchema = z.object({
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
export const definitionOfDoneRevisionSchema = z.object({
  projectId: z.string().uuid(),
  revisionNumber: z.number().int().positive(),
  criteria: z.array(z.object({ id: z.string().uuid(), description: z.string() })),
  reason: z.string(),
  createdByPrincipalId: z.string().uuid(),
  createdAt: z.string().datetime(),
});
export const sprintScopeItemSchema = z.object({
  itemId: z.string().uuid(),
  itemKey: z.string(),
  title: z.string(),
  stateAtSelection: z.string(),
  currentState: z.string(),
  points: z.number().int().positive(),
  baselineId: z.string().uuid(),
  itemRevisionNumber: z.number().int().positive(),
});
export const sprintStateTransitionSchema = z.object({
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
export const sprintRetrospectiveActionSchema = z.object({
  id: z.string().uuid(),
  position: z.number().int().positive(),
  title: z.string(),
  ownerPrincipalId: z.string().uuid(),
  ownerDisplayName: z.string(),
  linkedWorkItemId: z.string().uuid().nullable(),
  linkedWorkItemKey: z.string().nullable(),
  linkedWorkItemTitle: z.string().nullable(),
});
export const sprintRetrospectiveRevisionSchema = z.object({
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
export const sprintRetrospectiveReadSchema = z.object({
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
export const sprintSchema = z.object({
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
export const scenarioCoverageMatchSchema = z.object({
  scenario: z.object({
    id: z.string().uuid(),
    key: z.string(),
    kind: z.enum(scenarioKinds),
    title: z.string(),
  }),
  revision: scenarioRevisionSchema,
  resultsByBuild: z.array(testRunSchema),
});
export const workItemQualityReportSchema = z.object({
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
export const forecastStatusSchema = z.enum([
  "complete", "incomplete_scope", "blocked", "insufficient_data", "no_capacity", "zero_velocity", "forecast_ready",
]);
export const forecastRecalculationSchema = z.object({
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
export const scenarioContentInputSchema = z.object({
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
export const developmentSessionSchema = z.object({
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
export const taskWorkflowStepSchema = z.object({
  id: z.string().uuid(), position: z.number().int().positive(), title: z.string(), description: z.string(),
  effortPercent: z.number().positive().max(100), status: z.enum(taskWorkflowStepStatuses),
  statusChangedAt: z.string().datetime().nullable(), statusChangedByPrincipalId: z.string().uuid().nullable(), statusReason: z.string().nullable(),
});
export const taskWorkflowRevisionSchema = z.object({
  id: z.string().uuid(), projectId: z.string().uuid(), taskId: z.string().uuid(), taskKey: z.string(),
  revisionNumber: z.number().int().positive(), status: z.enum(taskWorkflowRevisionStatuses), reason: z.string(),
  createdByPrincipalId: z.string().uuid(), createdAt: z.string().datetime(),
  publishedByPrincipalId: z.string().uuid().nullable(), publishedAt: z.string().datetime().nullable(),
  steps: z.array(taskWorkflowStepSchema), progressPercent: z.number().min(0).max(100).nullable(),
  completedEffortPercent: z.number().min(0).max(100).nullable(), remainingEffortPercent: z.number().min(0).max(100).nullable(),
  allStepsDone: z.boolean().nullable(),
});
export const taskWorkflowViewSchema = z.object({
  projectId: z.string().uuid(), taskId: z.string().uuid(), taskKey: z.string(), taskState: z.string(), taskVersion: z.number().int().positive(),
  latestRevisionNumber: z.number().int().nonnegative(),
  revisionHistory: z.array(z.object({ revisionNumber: z.number().int().positive(), status: z.enum(taskWorkflowRevisionStatuses), reason: z.string(), createdAt: z.string().datetime(), publishedAt: z.string().datetime().nullable() })),
  revisionHistoryTruncated: z.boolean(), workflow: taskWorkflowRevisionSchema.nullable(),
  draft: taskWorkflowRevisionSchema.nullable(), selectedRevision: taskWorkflowRevisionSchema.nullable(),
  selectedRevisionNumber: z.number().int().positive().nullable(), selectedRevisionIsCurrent: z.boolean(),
});
export const deploymentEventSchema = z.object({
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
export const roadmapItemReferenceSchema = z.object({
  roadmapId: z.string().regex(/^SSDD-\d{3}$/u),
  projectId: z.string().uuid(),
  itemId: z.string().uuid(),
  itemKey: z.string(),
  title: z.string(),
  boundByPrincipalId: z.string().uuid(),
  boundAt: z.string().datetime(),
});
export const baselineSchema = z.object({
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
export const impactFlagSchema = z.object({
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

export const workItemListItemSchema = z.object({
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

export const specificationContentSchema = z.record(z.string(), z.json()).refine(
  (content) => Object.keys(content).length > 0,
  "Specification content must be a non-empty JSON object.",
);

export const specificationRevisionSchema = z.object({
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

export const specificationSchema = z.object({
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

export const traceNodeSchema = z.object({
  id: z.string().uuid(),
  type: z.enum(["work_item", "specification"]),
  key: z.string(),
  title: z.string(),
});

export const traceLinkReceiptSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  source: traceNodeSchema,
  target: traceNodeSchema,
  type: z.enum(traceLinkTypes),
  removedAt: z.string().datetime().nullable(),
});

export const traceGraphSchema = z.object({
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

export const taskContextEntrySchema = z.object({
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
export const taskContextSchema = z.object({
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
    definitionOfDone: z.array(taskContextEntrySchema),
    guidance: z.array(taskContextEntrySchema),
  }),
  warnings: z.array(z.object({ code: z.string(), message: z.string(), key: z.string().optional() })),
  truncated: z.boolean(),
  nextCursor: z.string().nullable(),
});

export const metricsObjectSchema = z.record(z.string(), z.unknown());
export const dashboardMetricsSchema = z.object({
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
