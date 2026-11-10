export const baselineReferenceTypes = ["work_item_revision", "specification_revision", "scenario_revision"] as const;
export type BaselineReferenceType = (typeof baselineReferenceTypes)[number];

export interface BaselineReference {
  readonly entityType: BaselineReferenceType;
  readonly entityId: string;
  readonly key: string;
  readonly revisionNumber: number;
  readonly snapshot: unknown;
}

export interface WorkBaseline {
  readonly id: string;
  readonly projectId: string;
  readonly itemId: string;
  readonly itemKey: string;
  readonly sequence: number;
  readonly kind: "ready" | "revalidation";
  readonly reason: string;
  readonly createdByPrincipalId: string;
  readonly createdAt: string;
  readonly references: readonly BaselineReference[];
}

export interface ImpactFlag {
  readonly id: string;
  readonly projectId: string;
  readonly itemId: string;
  readonly itemKey: string;
  readonly baselineId: string;
  readonly specificationId: string;
  readonly specificationKey: string;
  readonly baselineRevision: number;
  readonly publishedRevision: number;
  readonly reason: string;
  readonly status: "open" | "revalidated";
  readonly createdAt: string;
  readonly resolvedByPrincipalId: string | null;
  readonly resolvedAt: string | null;
  readonly revalidatedBaselineId: string | null;
}
