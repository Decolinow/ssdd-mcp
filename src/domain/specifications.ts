export const specificationKinds = [
  "business_rule",
  "glossary",
  "api_contract",
  "adr",
  "non_functional",
] as const;

export type SpecificationKind = (typeof specificationKinds)[number];

export const specificationRevisionStatuses = ["draft", "in_review", "published", "superseded"] as const;

export type SpecificationRevisionStatus = (typeof specificationRevisionStatuses)[number];

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { readonly [key: string]: JsonValue };

export interface SpecificationContent {
  readonly [key: string]: JsonValue;
}

export interface SpecificationRevision {
  readonly id: string;
  readonly projectId: string;
  readonly specId: string;
  readonly key: string;
  readonly kind: SpecificationKind;
  readonly title: string;
  readonly revisionNumber: number;
  readonly status: SpecificationRevisionStatus;
  readonly content: SpecificationContent;
  readonly createdByPrincipalId: string;
  readonly createdAt: string;
  readonly publishedByPrincipalId: string | null;
  readonly publishedAt: string | null;
}

export interface Specification {
  readonly id: string;
  readonly projectId: string;
  readonly key: string;
  readonly kind: SpecificationKind;
  readonly title: string;
  readonly version: number;
  readonly latestRevision: number;
  readonly publishedRevision: number | null;
  readonly createdByPrincipalId: string;
  readonly createdAt: string;
  readonly revisions: readonly SpecificationRevision[];
}
