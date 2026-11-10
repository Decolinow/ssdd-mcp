export interface DefinitionOfDoneCriterion {
  readonly id: string;
  readonly description: string;
}

export interface DefinitionOfDoneRevision {
  readonly projectId: string;
  readonly revisionNumber: number;
  readonly criteria: readonly DefinitionOfDoneCriterion[];
  readonly reason: string;
  readonly createdByPrincipalId: string;
  readonly createdAt: string;
}
