export const traceLinkTypes = ["depends_on", "relates_to", "implements"] as const;

export type TraceLinkType = (typeof traceLinkTypes)[number];

export type TraceNodeType = "work_item" | "specification";

export type TraceDirection = "inbound" | "outbound" | "both";

export interface TraceNode {
  readonly id: string;
  readonly type: TraceNodeType;
  readonly key: string;
  readonly title: string;
}

export interface TraceEdge {
  readonly id: string;
  readonly type: TraceLinkType;
  readonly source: TraceNode;
  readonly target: TraceNode;
  readonly depth: number;
}

export interface TraceGraph {
  readonly root: TraceNode;
  readonly nodes: readonly TraceNode[];
  readonly links: readonly TraceEdge[];
  readonly truncated: boolean;
}
