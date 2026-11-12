import type { ProjectRole } from "./local-identity.js";
import type { SqliteDatabase } from "../storage-sqlite/database.js";
import { getProject } from "./project-queries.js";
import { getTaskExecutionQueue, type PrioritizedTask } from "./prioritized-roadmap.js";
import { listWorkItems } from "./work-item-queries.js";
import { getTaskClaimReadiness } from "./work-item-workflow.js";

const maximumClaimCandidates = 100;
const quickListLimit = 8;

export interface QuickAccessTask {
  readonly id: string;
  readonly key: string;
  readonly title: string;
  readonly version: number;
  readonly priority: number;
  readonly prioritySource: string;
  readonly businessValueScore: number | null;
  readonly businessValueRationale: string | null;
  readonly businessValueSource: string | null;
  readonly featureKey: string | null;
  readonly rank: number;
}

interface CandidateRow {
  readonly item_id: string;
  readonly item_key: string;
  readonly title: string;
  readonly version: number;
  readonly task_priority: number;
  readonly task_value: number | null;
  readonly task_value_rationale: string | null;
  readonly task_rank: number;
  readonly feature_key: string | null;
  readonly feature_rank: number | null;
  readonly feature_priority: number | null;
  readonly feature_value: number | null;
  readonly feature_value_rationale: string | null;
  readonly epic_key: string | null;
  readonly epic_priority: number | null;
  readonly epic_value: number | null;
  readonly epic_value_rationale: string | null;
  readonly story_key: string | null;
  readonly story_priority: number | null;
}

export interface DashboardQuickAccess {
  readonly projectId: string;
  readonly roles: readonly ProjectRole[];
  readonly developer: {
    readonly startableTasks: readonly PrioritizedTask[];
    readonly blockedTasks: readonly (PrioritizedTask & { readonly blockerCodes: readonly string[] })[];
    readonly blockedCount: number;
    readonly activeTasks: readonly { readonly id: string; readonly key: string; readonly title: string; readonly state: string; readonly version: number }[];
    readonly claimableTasks: readonly QuickAccessTask[];
    readonly claimCandidatesTruncated: boolean;
  } | null;
  readonly qa: {
    readonly pendingValidation: readonly { readonly id: string; readonly key: string; readonly title: string; readonly state: string; readonly version: number }[];
  } | null;
  readonly productOwner: {
    readonly drafts: readonly { readonly id: string; readonly key: string; readonly title: string; readonly state: string; readonly version: number }[];
  } | null;
  readonly techLead: {
    readonly awaitingReview: readonly { readonly id: string; readonly key: string; readonly title: string; readonly state: string; readonly version: number }[];
    readonly draftTasks: readonly { readonly id: string; readonly key: string; readonly title: string; readonly state: string; readonly version: number }[];
  } | null;
}

/** Provides a small, role-aware landing projection without changing project permissions. */
export function getDashboardQuickAccess(
  database: SqliteDatabase,
  input: { readonly projectId: string; readonly principalId: string },
): DashboardQuickAccess {
  const project = getProject(database, input.principalId, input.projectId);
  const roles = new Set(project.roles);
  const developer = roles.has("developer")
    ? buildDeveloperQuickAccess(database, input.projectId, input.principalId)
    : null;
  const qa = roles.has("qa")
    ? {
      pendingValidation: listWorkItems(database, {
        projectId: input.projectId,
        principalId: input.principalId,
        types: ["story", "bug"],
        states: ["in_validation"],
        limit: quickListLimit,
      }).items,
    }
    : null;
  const productOwner = roles.has("po")
    ? {
      drafts: listWorkItems(database, {
        projectId: input.projectId,
        principalId: input.principalId,
        types: ["story", "bug"],
        states: ["draft"],
        limit: quickListLimit,
      }).items,
    }
    : null;
  const techLead = roles.has("tech_lead")
    ? {
      awaitingReview: listWorkItems(database, {
        projectId: input.projectId,
        principalId: input.principalId,
        types: ["story", "bug", "task"],
        states: ["in_review"],
        limit: quickListLimit,
      }).items,
      draftTasks: listWorkItems(database, {
        projectId: input.projectId,
        principalId: input.principalId,
        types: ["task"],
        states: ["draft"],
        limit: quickListLimit,
      }).items,
    }
    : null;

  return { projectId: input.projectId, roles: project.roles, developer, qa, productOwner, techLead };
}

function buildDeveloperQuickAccess(
  database: SqliteDatabase,
  projectId: string,
  principalId: string,
): NonNullable<DashboardQuickAccess["developer"]> {
  const queue = getTaskExecutionQueue(database, { projectId, principalId, assignedToMe: true, limit: 8 });
  const activeTasks = listWorkItems(database, {
    projectId,
    principalId,
    types: ["task"],
    states: ["in_progress"],
    assignedToMe: true,
    limit: quickListLimit,
  }).items;
  const claimRows = database.prepare(
    `SELECT task.item_id, task.item_key, task.title, task.version,
            task.priority AS task_priority, task.business_value_score AS task_value,
            task.business_value_rationale AS task_value_rationale, task.rank AS task_rank,
            feature.item_key AS feature_key, feature.rank AS feature_rank,
            feature.priority AS feature_priority, feature.business_value_score AS feature_value,
            feature.business_value_rationale AS feature_value_rationale,
            epic.item_key AS epic_key, epic.priority AS epic_priority,
            epic.business_value_score AS epic_value, epic.business_value_rationale AS epic_value_rationale,
            story.item_key AS story_key, story.priority AS story_priority
     FROM work_items task
     LEFT JOIN work_items story ON story.project_id = task.project_id AND story.item_id = task.parent_id
     LEFT JOIN work_items feature ON feature.project_id = story.project_id AND feature.item_id = story.parent_id
     LEFT JOIN work_items epic ON epic.project_id = feature.project_id AND epic.item_id = feature.parent_id
     WHERE task.project_id = ? AND task.type = 'task' AND task.state = 'ready'
       AND task.assignee_principal_id IS NULL
     ORDER BY MIN(COALESCE(task.priority, 4), COALESCE(story.priority, 4),
                  COALESCE(feature.priority, 4), COALESCE(epic.priority, 4)),
              CASE WHEN COALESCE(task.business_value_score, feature.business_value_score, epic.business_value_score) IS NULL THEN 1 ELSE 0 END,
              COALESCE(task.business_value_score, feature.business_value_score, epic.business_value_score) DESC,
              COALESCE(feature.rank, 2147483647), task.rank, task.item_key COLLATE NOCASE
     LIMIT ?`,
  ).all(projectId, maximumClaimCandidates + 1) as CandidateRow[];
  const claimCandidatesTruncated = claimRows.length > maximumClaimCandidates;
  const eligible = claimRows.slice(0, maximumClaimCandidates).flatMap((row) => {
    const readiness = getTaskClaimReadiness(database, {
      projectId,
      principalId,
      itemIdOrKey: row.item_id,
    });
    if (!readiness.canStart) return [];
    const priorities = [row.task_priority, row.story_priority, row.feature_priority, row.epic_priority]
      .filter((value): value is number => value !== null);
    const priority = Math.min(...priorities);
    return [{
      id: row.item_id,
      key: row.item_key,
      title: row.title,
      version: row.version,
      priority,
      prioritySource: row.task_priority === priority ? row.item_key
        : row.story_priority === priority ? row.story_key ?? row.item_key
          : row.feature_priority === priority ? row.feature_key ?? row.item_key
            : row.epic_key ?? row.item_key,
      businessValueScore: row.task_value ?? row.feature_value ?? row.epic_value,
      businessValueRationale: row.task_value !== null ? row.task_value_rationale
        : row.feature_value !== null ? row.feature_value_rationale
          : row.epic_value_rationale,
      businessValueSource: row.task_value !== null ? row.item_key
        : row.feature_value !== null ? row.feature_key
          : row.epic_value !== null ? row.epic_key
            : null,
      featureKey: row.feature_key,
      rank: row.task_rank,
      featureRank: row.feature_rank ?? Number.MAX_SAFE_INTEGER,
    }];
  }).sort((left, right) => left.priority - right.priority ||
    (right.businessValueScore ?? -1) - (left.businessValueScore ?? -1) ||
    left.featureRank - right.featureRank || left.rank - right.rank || left.key.localeCompare(right.key, "en"));

  return {
    startableTasks: queue.tasks,
    blockedTasks: queue.blocked.filter((task) => task.state === "ready"),
    blockedCount: Math.min(queue.blockedCount, queue.scannedCount),
    activeTasks,
    claimableTasks: eligible.slice(0, 8),
    claimCandidatesTruncated,
  };
}
