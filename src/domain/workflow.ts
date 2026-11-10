import type { WorkItemState } from "./work-items.js";

export const evidenceKinds = ["pull_request", "commit", "build", "artifact", "test_report", "other"] as const;
export type EvidenceKind = (typeof evidenceKinds)[number];

export interface WorkItemEvidence {
  readonly id: string;
  readonly projectId: string;
  readonly itemId: string;
  readonly itemKey: string;
  readonly baselineId: string | null;
  readonly kind: EvidenceKind;
  readonly uri: string;
  readonly buildId: string | null;
  readonly description: string;
  readonly addedByPrincipalId: string;
  readonly createdAt: string;
}

export interface WorkItemTransition {
  readonly id: string;
  readonly projectId: string;
  readonly itemId: string;
  readonly itemKey: string;
  readonly fromState: WorkItemState;
  readonly toState: WorkItemState;
  readonly itemVersion: number;
  readonly baselineId: string | null;
  readonly buildId: string | null;
  readonly reason: string;
  readonly transitionedByPrincipalId: string;
  readonly transitionedAt: string;
}

export interface TestRunCertification {
  readonly id: string;
  readonly projectId: string;
  readonly itemId: string;
  readonly itemKey: string;
  readonly baselineId: string;
  readonly runId: string;
  readonly certifiedByPrincipalId: string;
  readonly reason: string;
  readonly certifiedAt: string;
}

export interface WorkflowGate {
  readonly id: string;
  readonly passed: boolean;
  readonly message: string;
  readonly details?: unknown;
}

export interface WorkItemGateReport {
  readonly itemId: string;
  readonly itemKey: string;
  readonly itemType: string;
  readonly currentState: string;
  readonly targetState: "ready" | "done";
  readonly buildId: string | null;
  readonly gates: readonly WorkflowGate[];
  readonly canProceed: boolean;
}

