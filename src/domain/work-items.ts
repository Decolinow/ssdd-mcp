export const workItemTypes = ["epic", "feature", "story", "bug", "task"] as const;

export type WorkItemType = (typeof workItemTypes)[number];

export const workItemStates = [
  "draft",
  "ready",
  "in_progress",
  "in_review",
  "in_validation",
  "done",
  "cancelled",
] as const;

export type WorkItemState = (typeof workItemStates)[number];

export const allowedParentTypes: Readonly<Record<WorkItemType, readonly WorkItemType[]>> = {
  epic: [],
  feature: ["epic"],
  story: ["feature"],
  bug: ["feature"],
  task: ["story", "bug"],
};

export interface AcceptanceCriterion {
  readonly id: string;
  readonly key: string;
  readonly description: string;
  readonly required: boolean;
  readonly position: number;
}

export type WorkItemEstimateUnit = "points" | "hours";

export interface WorkItemEstimate {
  readonly unit: WorkItemEstimateUnit;
  readonly value: number;
  readonly proposalId: string;
  readonly confirmedByPrincipalId: string;
  readonly confirmedAt: string;
}

export interface WorkItemEstimateProposal {
  readonly id: string;
  readonly projectId: string;
  readonly itemId: string;
  readonly unit: WorkItemEstimateUnit;
  readonly value: number;
  readonly rationale: string;
  readonly status: "pending" | "confirmed" | "rejected" | "superseded";
  readonly proposedByPrincipalId: string;
  readonly proposedAt: string;
  readonly resolvedByPrincipalId: string | null;
  readonly resolvedAt: string | null;
}

export interface WorkItemComment {
  readonly id: string;
  readonly projectId: string;
  readonly itemId: string;
  readonly authorPrincipalId: string;
  readonly body: string;
  readonly createdAt: string;
}

export interface WorkItemContentRevision {
  readonly id: string;
  readonly projectId: string;
  readonly itemId: string;
  readonly revisionNumber: number;
  readonly status: "draft" | "published" | "superseded";
  readonly snapshot: {
    readonly type: WorkItemType;
    readonly parentId: string | null;
    readonly relatedStoryId: string | null;
    readonly title: string;
    readonly description: string | null;
    readonly priority: number;
    readonly criteria: readonly AcceptanceCriterion[];
  };
  readonly createdByPrincipalId: string;
  readonly createdAt: string;
  readonly publishedByPrincipalId: string | null;
  readonly publishedAt: string | null;
}

export interface WorkItem {
  readonly id: string;
  readonly projectId: string;
  readonly key: string;
  readonly type: WorkItemType;
  readonly parentId: string | null;
  readonly relatedStoryId: string | null;
  readonly assigneeId: string | null;
  readonly title: string;
  readonly description: string | null;
  readonly state: string;
  readonly priority: number;
  readonly rank: number;
  readonly version: number;
  readonly revision: number;
  readonly createdByPrincipalId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly criteria: readonly AcceptanceCriterion[];
  readonly estimates: readonly WorkItemEstimate[];
}

export interface WorkItemListItem {
  readonly id: string;
  readonly key: string;
  readonly type: WorkItemType;
  readonly parentId: string | null;
  readonly assigneeId: string | null;
  readonly title: string;
  readonly state: WorkItemState;
  readonly priority: number;
  readonly rank: number;
  readonly version: number;
  readonly revision: number;
  readonly updatedAt: string;
}
