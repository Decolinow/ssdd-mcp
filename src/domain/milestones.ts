export interface MilestoneScopeItem {
  readonly itemId: string;
  readonly itemKey: string;
  readonly title: string;
  readonly stateAtApproval: string;
  readonly currentState: string;
  readonly points: number;
  readonly baselineId: string;
  readonly itemRevisionNumber: number;
}

export interface MilestoneScopeEvent extends MilestoneScopeItem {
  readonly id: string;
  readonly sequence: number;
  readonly action: "add" | "remove";
  readonly reason: string;
  readonly changedByPrincipalId: string;
  readonly changedAt: string;
}

export interface Milestone {
  readonly id: string;
  readonly projectId: string;
  readonly key: string;
  readonly title: string;
  readonly goal: string;
  readonly targetDate: string;
  readonly version: number;
  readonly createdByPrincipalId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly reason: string;
  readonly scope: readonly MilestoneScopeItem[];
  readonly scopeHistory: readonly MilestoneScopeEvent[];
}

export interface MilestoneSummary {
  readonly id: string;
  readonly projectId: string;
  readonly key: string;
  readonly title: string;
  readonly goal: string;
  readonly targetDate: string;
  readonly version: number;
  readonly scopeItemCount: number;
  readonly scopePoints: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}
