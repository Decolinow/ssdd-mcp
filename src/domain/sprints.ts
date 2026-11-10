import type { DefinitionOfDoneRevision } from "./definition-of-done.js";
import type { TeamCapacityReport } from "./teams.js";

export const sprintStates = ["draft", "active", "closed", "cancelled"] as const;
export type SprintState = (typeof sprintStates)[number];

export interface SprintScopeItem {
  readonly itemId: string;
  readonly itemKey: string;
  readonly title: string;
  readonly stateAtSelection: string;
  readonly currentState: string;
  readonly points: number;
  readonly baselineId: string;
  readonly itemRevisionNumber: number;
}

export interface SprintScopeEvent extends SprintScopeItem {
  readonly id: string;
  readonly sequence: number;
  readonly action: "add" | "remove";
  readonly reason: string;
  readonly changedByPrincipalId: string;
  readonly changedAt: string;
}

export interface SprintStateTransition {
  readonly id: string;
  readonly projectId: string;
  readonly sprintId: string;
  readonly fromState: SprintState;
  readonly toState: SprintState;
  readonly sprintVersion: number;
  readonly reason: string;
  readonly transitionedByPrincipalId: string;
  readonly transitionedAt: string;
}

export interface SprintRetrospectiveAction {
  readonly id: string;
  readonly position: number;
  readonly title: string;
  readonly ownerPrincipalId: string;
  readonly ownerDisplayName: string;
  readonly linkedWorkItemId: string | null;
  readonly linkedWorkItemKey: string | null;
  readonly linkedWorkItemTitle: string | null;
}

export interface SprintRetrospectiveRevision {
  readonly sprintId: string;
  readonly revisionNumber: number;
  readonly version: number;
  readonly summary: string;
  readonly keepDoing: readonly string[];
  readonly stopDoing: readonly string[];
  readonly tryNext: readonly string[];
  readonly actions: readonly SprintRetrospectiveAction[];
  readonly reason: string;
  readonly createdByPrincipalId: string;
  readonly createdAt: string;
}

export interface SprintRetrospectiveHistoryEntry {
  readonly revisionNumber: number;
  readonly summary: string;
  readonly reason: string;
  readonly createdByPrincipalId: string;
  readonly createdAt: string;
}

export interface SprintRetrospectiveRead {
  readonly sprint: {
    readonly id: string;
    readonly key: string;
    readonly title: string;
    readonly status: SprintState;
    readonly closedAt: string | null;
  };
  readonly version: number;
  readonly selectedRevisionNumber: number | null;
  readonly retrospective: SprintRetrospectiveRevision | null;
  readonly history: readonly SprintRetrospectiveHistoryEntry[];
}

export interface SprintStartSnapshot {
  readonly startedAt: string;
  readonly reason: string;
  readonly capacity: TeamCapacityReport;
  readonly definitionOfDone: DefinitionOfDoneRevision;
  readonly commitments: readonly SprintScopeItem[];
}

export interface SprintCloseSnapshot {
  readonly closedAt: string;
  readonly reviewSummary: string;
  readonly acceptedItemIds: readonly string[];
  readonly acceptedItems: readonly SprintScopeItem[];
  readonly incompleteItems: readonly SprintScopeItem[];
  readonly definitionOfDone: DefinitionOfDoneRevision;
  readonly start: SprintStartSnapshot;
}

export interface Sprint {
  readonly id: string;
  readonly projectId: string;
  readonly key: string;
  readonly title: string;
  readonly goal: string;
  readonly startsOn: string;
  readonly endsOn: string;
  readonly status: SprintState;
  readonly teamId: string;
  readonly capacityConfigVersion: number;
  readonly definitionOfDoneRevision: number;
  readonly version: number;
  readonly createdByPrincipalId: string;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly closedAt: string | null;
  readonly cancelledAt: string | null;
  readonly reason: string;
  readonly reviewSummary: string | null;
  readonly startedSnapshot: SprintStartSnapshot | null;
  readonly closedSnapshot: SprintCloseSnapshot | null;
  readonly scope: readonly SprintScopeItem[];
  readonly scopeHistory: readonly SprintScopeEvent[];
  readonly transitions: readonly SprintStateTransition[];
}
