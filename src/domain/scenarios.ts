export const scenarioKinds = ["acceptance", "regression", "integration", "performance", "security", "manual"] as const;
export type ScenarioKind = (typeof scenarioKinds)[number];

export const scenarioRevisionStatuses = ["draft", "published", "superseded"] as const;
export type ScenarioRevisionStatus = (typeof scenarioRevisionStatuses)[number];

export const testRunResults = ["passed", "failed", "blocked", "skipped"] as const;
export type TestRunResult = (typeof testRunResults)[number];

export interface ScenarioCoverageTarget {
  readonly targetType: "criterion" | "specification";
  readonly targetId: string;
}

export interface ScenarioStep {
  readonly action: string;
  readonly expected: string;
}

export interface ScenarioSnapshot {
  readonly title: string;
  readonly preconditions: readonly string[];
  readonly steps: readonly ScenarioStep[];
  readonly coverage: readonly ScenarioCoverageTarget[];
}

export interface ScenarioRevision {
  readonly id: string;
  readonly projectId: string;
  readonly scenarioId: string;
  readonly key: string;
  readonly kind: ScenarioKind;
  readonly revisionNumber: number;
  readonly status: ScenarioRevisionStatus;
  readonly snapshot: ScenarioSnapshot;
  readonly createdByPrincipalId: string;
  readonly createdAt: string;
  readonly publishedByPrincipalId: string | null;
  readonly publishedAt: string | null;
}

export interface Scenario {
  readonly id: string;
  readonly projectId: string;
  readonly key: string;
  readonly kind: ScenarioKind;
  readonly title: string;
  readonly version: number;
  readonly latestRevision: number;
  readonly publishedRevision: number | null;
  readonly createdByPrincipalId: string;
  readonly createdAt: string;
  readonly revisions: readonly ScenarioRevision[];
}

export interface ScenarioSummary {
  readonly id: string;
  readonly key: string;
  readonly kind: ScenarioKind;
  readonly title: string;
  readonly version: number;
  readonly latestRevision: number;
  readonly publishedRevision: number | null;
}

export interface TestRun {
  readonly id: string;
  readonly projectId: string;
  readonly scenarioId: string;
  readonly scenarioKey: string;
  readonly revisionNumber: number;
  readonly buildId: string;
  readonly result: TestRunResult;
  readonly notes: string | null;
  readonly evidenceUri: string | null;
  readonly executedByPrincipalId: string;
  readonly executedAt: string;
}

export interface ScenarioCoverageMatch {
  readonly scenario: {
    readonly id: string;
    readonly key: string;
    readonly kind: ScenarioKind;
    readonly title: string;
  };
  readonly revision: ScenarioRevision;
  readonly resultsByBuild: readonly TestRun[];
}
