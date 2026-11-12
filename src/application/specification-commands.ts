import { randomUUID } from "node:crypto";
import type {
  JsonValue,
  SpecificationContent,
  SpecificationKind,
  SpecificationRevision,
} from "../domain/specifications.js";
import type { SqliteDatabase } from "../storage-sqlite/database.js";
import { ApplicationError } from "./errors.js";
import {
  executeIdempotentCommand,
  type CommandReceipt,
} from "./idempotent-command.js";
import { assertProjectAuthorization, type ProjectRole } from "./local-identity.js";
import { recordBaselineImpactsForPublishedSpecification } from "./baseline-commands.js";

export interface CreateSpecificationInput {
  readonly projectId: string;
  readonly principalId: string;
  readonly requestId: string;
  readonly key: string;
  readonly kind: SpecificationKind;
  readonly title: string;
  readonly content: SpecificationContent;
}

export interface ProposeSpecificationRevisionInput {
  readonly projectId: string;
  readonly principalId: string;
  readonly requestId: string;
  readonly specIdOrKey: string;
  readonly expectedVersion: number;
  readonly content: SpecificationContent;
}

export interface PublishSpecificationRevisionInput {
  readonly projectId: string;
  readonly principalId: string;
  readonly requestId: string;
  readonly specIdOrKey: string;
  readonly revisionNumber: number;
  readonly expectedVersion: number;
}

export interface WithdrawSpecificationRevisionInput {
  readonly projectId: string;
  readonly principalId: string;
  readonly requestId: string;
  readonly specIdOrKey: string;
  readonly revisionNumber: number;
  readonly expectedVersion: number;
  readonly reason: string;
}

const rolesBySpecificationKind: Readonly<Record<SpecificationKind, readonly ProjectRole[]>> = {
  business_rule: ["po"],
  glossary: ["po"],
  api_contract: ["tech_lead"],
  adr: ["tech_lead"],
  non_functional: ["tech_lead"],
};

export function createSpecification(
  database: SqliteDatabase,
  input: CreateSpecificationInput,
): CommandReceipt<SpecificationRevision> {
  const normalized = normalizeCreateInput(input);
  return executeIdempotentCommand(database, {
    projectId: input.projectId,
    principalId: input.principalId,
    action: "specification.create",
    requestId: input.requestId,
    payload: {
      projectId: input.projectId,
      key: normalized.key,
      kind: normalized.kind,
      title: normalized.title,
      content: normalized.content as JsonValue,
    },
    requiredRoles: rolesBySpecificationKind[normalized.kind],
    auditEvent: (revision) => ({
      projectId: input.projectId,
      principalId: input.principalId,
      eventType: "specification.created",
      entityType: "specification",
      entityId: revision.specId,
      payload: { key: revision.key, kind: revision.kind, revisionNumber: revision.revisionNumber },
    }),
    execute: () => {
      const duplicate = database
        .prepare("SELECT spec_id FROM specifications WHERE project_id = ? AND spec_key = ?")
        .get(input.projectId, normalized.key);
      if (duplicate !== undefined) {
        throw new ApplicationError(
          "SPECIFICATION_KEY_CONFLICT",
          `Specification key '${normalized.key}' already exists in this project.`,
        );
      }

      const specificationId = randomUUID();
      const revisionId = randomUUID();
      const now = new Date().toISOString();
      database
        .prepare(
          `INSERT INTO specifications
            (spec_id, project_id, spec_key, kind, title, version, created_by_principal_id, created_at)
           VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
        )
        .run(
          specificationId,
          input.projectId,
          normalized.key,
          normalized.kind,
          normalized.title,
          input.principalId,
          now,
        );
      database
        .prepare(
          `INSERT INTO specification_revisions
            (revision_id, project_id, spec_id, revision_number, status, content_json,
             created_by_principal_id, created_at)
           VALUES (?, ?, ?, 1, 'draft', ?, ?, ?)`,
        )
        .run(
          revisionId,
          input.projectId,
          specificationId,
          JSON.stringify(normalized.content),
          input.principalId,
          now,
        );
      return {
        id: revisionId,
        projectId: input.projectId,
        specId: specificationId,
        key: normalized.key,
        kind: normalized.kind,
        title: normalized.title,
        revisionNumber: 1,
        status: "draft" as const,
        content: normalized.content,
        createdByPrincipalId: input.principalId,
        createdAt: now,
        publishedByPrincipalId: null,
        publishedAt: null,
      };
    },
  });
}

export function proposeSpecificationRevision(
  database: SqliteDatabase,
  input: ProposeSpecificationRevisionInput,
): CommandReceipt<SpecificationRevision> {
  const reference = input.specIdOrKey.trim();
  const content = normalizeContent(input.content);
  const target = findSpecification(database, input.projectId, input.principalId, reference);
  const requiredRoles = rolesBySpecificationKind[target.kind];
  return executeIdempotentCommand(database, {
    projectId: input.projectId,
    principalId: input.principalId,
    action: "specification.revision.propose",
    requestId: input.requestId,
    payload: {
      projectId: input.projectId,
      specId: target.id,
      expectedVersion: input.expectedVersion,
      content: content as JsonValue,
    },
    requiredRoles,
    auditEvent: (revision) => ({
      projectId: input.projectId,
      principalId: input.principalId,
      eventType: "specification.revision_proposed",
      entityType: "specification",
      entityId: target.id,
      payload: { key: target.key, revisionNumber: revision.revisionNumber },
    }),
    execute: () => {
      assertSpecificationVersion(database, input.projectId, target.id, input.expectedVersion);
      const openRevision = database
        .prepare(
          `SELECT revision_number FROM specification_revisions
           WHERE project_id = ? AND spec_id = ? AND status IN ('draft', 'in_review') LIMIT 1`,
        )
        .get(input.projectId, target.id);
      if (openRevision !== undefined) {
        throw new ApplicationError(
          "VALIDATION_FAILED",
          "Publish or withdraw the existing draft before proposing another revision.",
        );
      }
      const current = database
        .prepare(
          "SELECT COALESCE(MAX(revision_number), 0) AS revision FROM specification_revisions WHERE project_id = ? AND spec_id = ?",
        )
        .get(input.projectId, target.id) as { revision: number };
      const revisionNumber = current.revision + 1;
      const revisionId = randomUUID();
      const now = new Date().toISOString();
      database
        .prepare(
          `INSERT INTO specification_revisions
            (revision_id, project_id, spec_id, revision_number, status, content_json,
             created_by_principal_id, created_at)
           VALUES (?, ?, ?, ?, 'draft', ?, ?, ?)`,
        )
        .run(
          revisionId,
          input.projectId,
          target.id,
          revisionNumber,
          JSON.stringify(content),
          input.principalId,
          now,
        );
      database
        .prepare("UPDATE specifications SET version = version + 1 WHERE spec_id = ?")
        .run(target.id);
      return {
        id: revisionId,
        projectId: input.projectId,
        specId: target.id,
        key: target.key,
        kind: target.kind,
        title: target.title,
        revisionNumber,
        status: "draft" as const,
        content,
        createdByPrincipalId: input.principalId,
        createdAt: now,
        publishedByPrincipalId: null,
        publishedAt: null,
      };
    },
  });
}

export function publishSpecificationRevision(
  database: SqliteDatabase,
  input: PublishSpecificationRevisionInput,
): CommandReceipt<SpecificationRevision> {
  const reference = input.specIdOrKey.trim();
  const target = findSpecification(database, input.projectId, input.principalId, reference);
  const requiredRoles = rolesBySpecificationKind[target.kind];
  let impactedItems: readonly { itemId: string; itemKey: string; baselineRevision: number; publishedRevision: number }[] = [];
  return executeIdempotentCommand(database, {
    projectId: input.projectId,
    principalId: input.principalId,
    action: "specification.revision.publish",
    requestId: input.requestId,
    payload: {
      projectId: input.projectId,
      specId: target.id,
      revisionNumber: input.revisionNumber,
      expectedVersion: input.expectedVersion,
    },
    requiredRoles,
    auditEvent: (revision) => ({
      projectId: input.projectId,
      principalId: input.principalId,
      eventType: "specification.revision_published",
      entityType: "specification",
      entityId: target.id,
      payload: {
        key: revision.key,
        revisionNumber: revision.revisionNumber,
        impactedItems: impactedItems.map((item) => ({
          itemId: item.itemId,
          itemKey: item.itemKey,
          baselineRevision: item.baselineRevision,
          publishedRevision: item.publishedRevision,
        })),
      },
    }),
    execute: () => {
      assertSpecificationVersion(database, input.projectId, target.id, input.expectedVersion);
      const principal = database
        .prepare("SELECT principal_type FROM principals WHERE principal_id = ?")
        .get(input.principalId) as { principal_type: string } | undefined;
      if (principal?.principal_type !== "human") {
        throw new ApplicationError("FORBIDDEN", "Only a human principal may publish a specification.");
      }

      const revision = database
        .prepare(
          `SELECT revision_id, revision_number, status, content_json,
                  created_by_principal_id, created_at
           FROM specification_revisions
           WHERE project_id = ? AND spec_id = ? AND revision_number = ?`,
        )
        .get(input.projectId, target.id, input.revisionNumber) as
        | {
            revision_id: string;
            revision_number: number;
            status: string;
            content_json: string;
            created_by_principal_id: string;
            created_at: string;
          }
        | undefined;
      if (revision === undefined) {
        throw new ApplicationError("NOT_FOUND", "Specification revision was not found.");
      }
      if (revision.status !== "draft" && revision.status !== "in_review") {
        throw new ApplicationError("VALIDATION_FAILED", "Only a draft revision can be published.");
      }
      const latest = database
        .prepare(
          "SELECT MAX(revision_number) AS revision FROM specification_revisions WHERE project_id = ? AND spec_id = ?",
        )
        .get(input.projectId, target.id) as { revision: number };
      if (latest.revision !== revision.revision_number) {
        throw new ApplicationError("VALIDATION_FAILED", "Only the latest specification revision can be published.");
      }

      const now = new Date().toISOString();
      database
        .prepare(
          `UPDATE specification_revisions
           SET status = 'superseded'
           WHERE project_id = ? AND spec_id = ? AND status = 'published'`,
        )
        .run(input.projectId, target.id);
      database
        .prepare(
          `UPDATE specification_revisions
           SET status = 'published', published_by_principal_id = ?, published_at = ?
           WHERE project_id = ? AND spec_id = ? AND revision_number = ?`,
        )
        .run(input.principalId, now, input.projectId, target.id, input.revisionNumber);
      database
        .prepare("UPDATE specifications SET version = version + 1 WHERE spec_id = ?")
        .run(target.id);
      impactedItems = recordBaselineImpactsForPublishedSpecification(database, {
        projectId: input.projectId,
        principalId: input.principalId,
        specificationId: target.id,
        revisionNumber: revision.revision_number,
        now,
      });
      return {
        id: revision.revision_id,
        projectId: input.projectId,
        specId: target.id,
        key: target.key,
        kind: target.kind,
        title: target.title,
        revisionNumber: revision.revision_number,
        status: "published" as const,
        content: JSON.parse(revision.content_json) as SpecificationContent,
        createdByPrincipalId: revision.created_by_principal_id,
        createdAt: revision.created_at,
        publishedByPrincipalId: input.principalId,
        publishedAt: now,
      };
    },
  });
}

export function withdrawSpecificationRevision(
  database: SqliteDatabase,
  input: WithdrawSpecificationRevisionInput,
): CommandReceipt<SpecificationRevision> {
  const reference = input.specIdOrKey.trim();
  const reason = input.reason.trim();
  if (reason.length < 1 || reason.length > 1000) {
    throw new ApplicationError("VALIDATION_FAILED", "Withdrawal reason must contain 1-1000 characters.");
  }
  const target = findSpecification(database, input.projectId, input.principalId, reference);
  return executeIdempotentCommand(database, {
    projectId: input.projectId,
    principalId: input.principalId,
    action: "specification.revision.withdraw",
    requestId: input.requestId,
    payload: {
      projectId: input.projectId,
      specId: target.id,
      revisionNumber: input.revisionNumber,
      expectedVersion: input.expectedVersion,
      reason,
    },
    requiredRoles: rolesBySpecificationKind[target.kind],
    auditEvent: (revision) => ({
      projectId: input.projectId,
      principalId: input.principalId,
      eventType: "specification.revision_withdrawn",
      entityType: "specification",
      entityId: target.id,
      payload: { key: target.key, revisionNumber: revision.revisionNumber, reason },
    }),
    execute: () => {
      assertSpecificationVersion(database, input.projectId, target.id, input.expectedVersion);
      const principal = database.prepare("SELECT principal_type FROM principals WHERE principal_id = ?")
        .get(input.principalId) as { principal_type: string } | undefined;
      if (principal?.principal_type !== "human") {
        throw new ApplicationError("FORBIDDEN", "Only a human principal may withdraw a specification revision.");
      }
      const row = database.prepare(
        `SELECT revision_id, revision_number, status, content_json, created_by_principal_id, created_at
         FROM specification_revisions WHERE project_id = ? AND spec_id = ? AND revision_number = ?`,
      ).get(input.projectId, target.id, input.revisionNumber) as {
        revision_id: string; revision_number: number; status: string; content_json: string;
        created_by_principal_id: string; created_at: string;
      } | undefined;
      if (row === undefined) throw new ApplicationError("NOT_FOUND", "Specification revision was not found.");
      if (row.status !== "draft" && row.status !== "in_review") {
        throw new ApplicationError("VALIDATION_FAILED", "Only a draft or in-review revision can be withdrawn.");
      }
      const latest = database.prepare(
        "SELECT MAX(revision_number) AS revision FROM specification_revisions WHERE project_id = ? AND spec_id = ?",
      ).get(input.projectId, target.id) as { revision: number };
      if (latest.revision !== row.revision_number) {
        throw new ApplicationError("VALIDATION_FAILED", "Only the latest open specification revision can be withdrawn.");
      }
      database.prepare(
        `UPDATE specification_revisions SET status = 'withdrawn'
         WHERE project_id = ? AND spec_id = ? AND revision_number = ?`,
      ).run(input.projectId, target.id, input.revisionNumber);
      database.prepare("UPDATE specifications SET version = version + 1 WHERE spec_id = ?").run(target.id);
      return {
        id: row.revision_id,
        projectId: input.projectId,
        specId: target.id,
        key: target.key,
        kind: target.kind,
        title: target.title,
        revisionNumber: row.revision_number,
        status: "withdrawn" as const,
        content: JSON.parse(row.content_json) as SpecificationContent,
        createdByPrincipalId: row.created_by_principal_id,
        createdAt: row.created_at,
        publishedByPrincipalId: null,
        publishedAt: null,
      };
    },
  });
}

interface SpecificationTarget {
  readonly id: string;
  readonly key: string;
  readonly kind: SpecificationKind;
  readonly title: string;
}

function findSpecification(
  database: SqliteDatabase,
  projectId: string,
  principalId: string,
  reference: string,
): SpecificationTarget {
  assertProjectAuthorization(database, projectId, principalId);
  const target = database
    .prepare(
      `SELECT spec_id AS id, spec_key AS key, kind, title
       FROM specifications WHERE project_id = ? AND (spec_id = ? OR spec_key = ? COLLATE NOCASE)`,
    )
    .get(projectId, reference, reference) as SpecificationTarget | undefined;
  if (target === undefined) {
    throw new ApplicationError("NOT_FOUND", "Specification was not found.");
  }
  return target;
}

function assertExpectedVersion(actual: number, expected: number): void {
  if (!Number.isSafeInteger(expected) || expected < 1) {
    throw new ApplicationError("VALIDATION_FAILED", "Expected version must be a positive integer.");
  }
  if (actual !== expected) {
    throw new ApplicationError(
      "VERSION_CONFLICT",
      "The specification changed since it was read.",
      { details: { expectedVersion: expected, actualVersion: actual } },
    );
  }
}

function assertSpecificationVersion(
  database: SqliteDatabase,
  projectId: string,
  specificationId: string,
  expectedVersion: number,
): void {
  const current = database
    .prepare("SELECT version FROM specifications WHERE project_id = ? AND spec_id = ?")
    .get(projectId, specificationId) as { version: number } | undefined;
  if (current === undefined) {
    throw new ApplicationError("NOT_FOUND", "Specification was not found.");
  }
  assertExpectedVersion(current.version, expectedVersion);
}

function normalizeCreateInput(input: CreateSpecificationInput): Omit<CreateSpecificationInput, "projectId" | "principalId" | "requestId"> {
  const key = input.key.trim().toUpperCase();
  const title = input.title.trim();
  if (!/^[A-Z][A-Z0-9._-]{0,31}$/.test(key)) {
    throw new ApplicationError("VALIDATION_FAILED", "Specification keys must use 1-32 letters, digits, dots, underscores or dashes.");
  }
  if (title.length === 0 || title.length > 200) {
    throw new ApplicationError("VALIDATION_FAILED", "Specification titles must contain 1-200 characters.");
  }
  return { key, title, kind: input.kind, content: normalizeContent(input.content) };
}

function normalizeContent(content: SpecificationContent): SpecificationContent {
  if (content === null || typeof content !== "object" || Array.isArray(content) || Object.keys(content).length === 0) {
    throw new ApplicationError("VALIDATION_FAILED", "Specification content must be a non-empty JSON object.");
  }
  return content;
}
