export const taskWorkflowRevisionStatuses = ["draft", "published", "superseded", "withdrawn"] as const;
export type TaskWorkflowRevisionStatus = (typeof taskWorkflowRevisionStatuses)[number];

export const taskWorkflowStepStatuses = ["pending", "in_progress", "done"] as const;
export type TaskWorkflowStepStatus = (typeof taskWorkflowStepStatuses)[number];

export interface TaskWorkflowStep {
  readonly id: string;
  readonly position: number;
  readonly title: string;
  readonly description: string;
  /** Percent in hundredths, e.g. 12.5 means 12.50%. */
  readonly effortPercent: number;
  readonly status: TaskWorkflowStepStatus;
  readonly statusChangedAt: string | null;
  readonly statusChangedByPrincipalId: string | null;
  readonly statusReason: string | null;
}

export interface TaskWorkflowRevision {
  readonly id: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly taskKey: string;
  readonly revisionNumber: number;
  readonly status: TaskWorkflowRevisionStatus;
  readonly reason: string;
  readonly createdByPrincipalId: string;
  readonly createdAt: string;
  readonly publishedByPrincipalId: string | null;
  readonly publishedAt: string | null;
  readonly steps: readonly TaskWorkflowStep[];
  /** Null for Draft/withdrawn revisions; published snapshots always have a 0-100 percent value. */
  readonly progressPercent: number | null;
  readonly completedEffortPercent: number | null;
  readonly remainingEffortPercent: number | null;
  readonly allStepsDone: boolean | null;
}

export interface TaskWorkflowRevisionHistoryEntry {
  readonly revisionNumber: number;
  readonly status: TaskWorkflowRevisionStatus;
  readonly reason: string;
  readonly createdAt: string;
  readonly publishedAt: string | null;
}

export interface TaskWorkflowView {
  readonly projectId: string;
  readonly taskId: string;
  readonly taskKey: string;
  readonly taskState: string;
  readonly taskVersion: number;
  readonly latestRevisionNumber: number;
  readonly revisionHistory: readonly TaskWorkflowRevisionHistoryEntry[];
  readonly revisionHistoryTruncated: boolean;
  readonly workflow: TaskWorkflowRevision | null;
  readonly draft: TaskWorkflowRevision | null;
  readonly selectedRevision: TaskWorkflowRevision | null;
  readonly selectedRevisionNumber: number | null;
  readonly selectedRevisionIsCurrent: boolean;
}
