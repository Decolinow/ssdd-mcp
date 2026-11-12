import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  createSpecification,
  proposeSpecificationRevision,
  publishSpecificationRevision,
  withdrawSpecificationRevision,
} from "../../src/application/specification-commands.js";
import { ApplicationError } from "../../src/application/errors.js";
import { initializeProject } from "../../src/application/initialize-project.js";
import { getSpecification, listSpecifications } from "../../src/application/specification-queries.js";
import { openSqliteDatabase, type SqliteDatabase } from "../../src/storage-sqlite/database.js";
import { applyMigrations } from "../../src/storage-sqlite/migrations.js";

describe("versioned specifications", () => {
  let workspace: string;
  let database: SqliteDatabase;
  let projectId: string;
  let principalId: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "ssdd-mcp-specifications-"));
    const initialized = initializeProject({
      workspace,
      key: "PAY",
      name: "Payments",
      productGoal: "Pagamentos confiáveis",
      timezone: "America/Sao_Paulo",
    });
    projectId = initialized.project.id;
    database = openSqliteDatabase(initialized.databasePath);
    applyMigrations(database);
    const project = database
      .prepare("SELECT created_by_principal_id FROM projects WHERE project_id = ?")
      .get(projectId) as { created_by_principal_id: string };
    principalId = project.created_by_principal_id;
  });

  afterEach(() => {
    database.close();
    rmSync(workspace, { recursive: true, force: true });
  });

  it("publishes a newer immutable revision and supersedes the previous one", () => {
    const initial = createSpecification(database, {
      projectId,
      principalId,
      requestId: "create-rule-1",
      key: "BR-04",
      kind: "business_rule",
      title: "Instante de corte",
      content: { text: "O cancelamento ocorre antes do instante de corte." },
    });
    assert.equal(initial.value.revisionNumber, 1);
    assert.equal(initial.value.status, "draft");

    const publishedFirst = publishSpecificationRevision(database, {
      projectId,
      principalId,
      requestId: "publish-rule-1",
      specIdOrKey: "br-04",
      revisionNumber: 1,
      expectedVersion: 1,
    });
    assert.equal(publishedFirst.value.status, "published");

    const proposed = proposeSpecificationRevision(database, {
      projectId,
      principalId,
      requestId: "propose-rule-2",
      specIdOrKey: "BR-04",
      expectedVersion: 2,
      content: { text: "O corte usa o horário de autorização do pagamento." },
    });
    assert.equal(proposed.value.revisionNumber, 2);

    const replay = proposeSpecificationRevision(database, {
      projectId,
      principalId,
      requestId: "propose-rule-2",
      specIdOrKey: "BR-04",
      expectedVersion: 2,
      content: { text: "O corte usa o horário de autorização do pagamento." },
    });
    assert.deepEqual(replay, proposed);

    const publishedSecond = publishSpecificationRevision(database, {
      projectId,
      principalId,
      requestId: "publish-rule-2",
      specIdOrKey: "BR-04",
      revisionNumber: 2,
      expectedVersion: 3,
    });
    assert.equal(publishedSecond.value.status, "published");

    const specification = getSpecification(database, projectId, principalId, "br-04");
    assert.equal(specification.publishedRevision, 2);
    assert.equal(specification.latestRevision, 2);
    assert.equal(specification.latestStatus, "published");
    assert.deepEqual(
      specification.revisions.map(({ revisionNumber, status }) => ({ revisionNumber, status })),
      [
        { revisionNumber: 1, status: "superseded" },
        { revisionNumber: 2, status: "published" },
      ],
    );
    assert.equal(listSpecifications(database, projectId, principalId, { kind: "business_rule" }).specifications.length, 1);

    assert.throws(
      () =>
        database
          .prepare("UPDATE specification_revisions SET content_json = '{}' WHERE revision_number = 2")
          .run(),
    );
    const auditCount = database
      .prepare("SELECT COUNT(*) AS count FROM audit_events WHERE entity_type = 'specification'")
      .get() as { count: number };
    assert.equal(auditCount.count, 4);
  });

  it("rejects stale versions and prevents multiple open drafts", () => {
    createSpecification(database, {
      projectId,
      principalId,
      requestId: "create-adr-1",
      key: "ADR-09",
      kind: "adr",
      title: "Transição atômica",
      content: { context: "Contexto inicial", decision: "Usar transação local." },
    });
    assert.throws(
      () =>
        proposeSpecificationRevision(database, {
          projectId,
          principalId,
          requestId: "propose-adr-stale",
          specIdOrKey: "ADR-09",
          expectedVersion: 9,
          content: { context: "Alterado", decision: "Outra decisão." },
        }),
      (error: unknown) => error instanceof ApplicationError && error.code === "VERSION_CONFLICT",
    );
    assert.throws(
      () =>
        proposeSpecificationRevision(database, {
          projectId,
          principalId,
          requestId: "propose-adr-2",
          specIdOrKey: "ADR-09",
          expectedVersion: 1,
          content: { context: "Alterado", decision: "Outra decisão." },
        }),
      (error: unknown) => error instanceof ApplicationError && error.code === "VALIDATION_FAILED",
    );
  });

  it("withdraws an abandoned draft with a human reason and keeps the audit history", () => {
    createSpecification(database, {
      projectId, principalId, requestId: "withdraw-create-adr", key: "ADR-10", kind: "adr",
      title: "Abandoned direction", content: { decision: "Old implementation direction." },
    });
    const withdrawn = withdrawSpecificationRevision(database, {
      projectId, principalId, requestId: "withdraw-adr-1", specIdOrKey: "ADR-10", revisionNumber: 1,
      expectedVersion: 1, reason: "Superseded by the corrected ADR-11 decision.",
    });
    assert.equal(withdrawn.value.status, "withdrawn");
    const withdrawnSpecification = getSpecification(database, projectId, principalId, "ADR-10");
    assert.equal(withdrawnSpecification.latestStatus, "withdrawn");
    assert.deepEqual(withdrawnSpecification.revisions.map(({ status }) => status), ["withdrawn"]);

    const replacement = proposeSpecificationRevision(database, {
      projectId, principalId, requestId: "withdraw-propose-replacement", specIdOrKey: "ADR-10", expectedVersion: 2,
      content: { decision: "Use the currently implemented workflow contract." },
    });
    assert.equal(replacement.value.revisionNumber, 2);
    const reopenedSpecification = getSpecification(database, projectId, principalId, "ADR-10");
    assert.equal(reopenedSpecification.latestStatus, "draft");
    assert.deepEqual(reopenedSpecification.revisions.map(({ status }) => status), ["withdrawn", "draft"]);
  });

  it("enforces type-specific authoring roles and requires a human publisher", () => {
    const qaId = randomUUID();
    const agentId = randomUUID();
    const createdAt = new Date().toISOString();
    const addPrincipal = database.prepare(
      `INSERT INTO principals (principal_id, principal_type, identity_key, display_name, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    );
    addPrincipal.run(qaId, "human", `test:${qaId}`, "qa-only", createdAt);
    addPrincipal.run(agentId, "agent", `test:${agentId}`, "agent-po", createdAt);
    const addRole = database.prepare(
      "INSERT INTO project_memberships (project_id, principal_id, role, created_at) VALUES (?, ?, ?, ?)",
    );
    addRole.run(projectId, qaId, "qa", createdAt);
    addRole.run(projectId, agentId, "po", createdAt);

    assert.throws(
      () =>
        createSpecification(database, {
          projectId,
          principalId: qaId,
          requestId: "qa-create-rule",
          key: "BR-10",
          kind: "business_rule",
          title: "Rule",
          content: { text: "Text" },
        }),
      (error: unknown) => error instanceof ApplicationError && error.code === "FORBIDDEN",
    );

    const rule = createSpecification(database, {
      projectId,
      principalId,
      requestId: "create-rule-for-agent-test",
      key: "BR-11",
      kind: "business_rule",
      title: "Another rule",
      content: { text: "Text" },
    });
    assert.throws(
      () =>
        publishSpecificationRevision(database, {
          projectId,
          principalId: agentId,
          requestId: "agent-publish",
          specIdOrKey: rule.value.key,
          revisionNumber: 1,
          expectedVersion: 1,
        }),
      (error: unknown) => error instanceof ApplicationError && error.code === "FORBIDDEN",
    );
  });

  it("paginates specifications with a cursor bound to its filters and project watermark", () => {
    for (let index = 1; index <= 101; index += 1) {
      const key = `BR-${String(index).padStart(3, "0")}`;
      createSpecification(database, {
        projectId, principalId, requestId: `page-${key}`, key, kind: "business_rule", title: key,
        content: { text: `Rule ${key}` },
      });
    }
    const empty = listSpecifications(database, projectId, principalId, { kind: "adr" });
    assert.deepEqual(empty.specifications, []);
    assert.equal(empty.nextCursor, null);
    const one = listSpecifications(database, projectId, principalId, { kind: "business_rule", limit: 1 });
    assert.deepEqual(one.specifications.map(({ key }) => key), ["BR-001"]);
    assert.ok(one.nextCursor);

    const first = listSpecifications(database, projectId, principalId, { kind: "business_rule", limit: 100 });
    assert.equal(first.specifications.length, 100);
    assert.equal(first.specifications[0]?.key, "BR-001");
    assert.equal(first.specifications.at(-1)?.key, "BR-100");
    assert.ok(first.watermark > 0);
    assert.ok(first.nextCursor);

    const second = listSpecifications(database, projectId, principalId, {
      kind: "business_rule", limit: 100, cursor: first.nextCursor!,
    });
    assert.deepEqual(second.specifications.map(({ key }) => key), ["BR-101"]);
    assert.equal(second.nextCursor, null);
    assert.throws(
      () => listSpecifications(database, projectId, principalId, { kind: "adr", limit: 100, cursor: first.nextCursor! }),
      (error: unknown) => error instanceof ApplicationError && error.code === "VALIDATION_FAILED",
    );

    createSpecification(database, {
      projectId, principalId, requestId: "page-BR-102", key: "BR-102", kind: "business_rule", title: "BR-102",
      content: { text: "Rule BR-102" },
    });
    assert.throws(
      () => listSpecifications(database, projectId, principalId, { kind: "business_rule", limit: 100, cursor: first.nextCursor! }),
      (error: unknown) => error instanceof ApplicationError && error.code === "STALE_CURSOR",
    );
  });

  it("searches the latest ADR revision by key, title or content with accent-insensitive stable paging", () => {
    const adrOne = createSpecification(database, {
      projectId, principalId, requestId: "search-adr-one", key: "ADR-QUEUE-01", kind: "adr",
      title: "Fila de eventos de pagamento", content: { decision: "Decisão: persistir eventos antes do processamento." },
    }).value;
    createSpecification(database, {
      projectId, principalId, requestId: "search-adr-two", key: "ADR-QUEUE-02", kind: "adr",
      title: "Fila de eventos de reembolso", content: { decision: "Registrar a retomada da fila." },
    });
    createSpecification(database, {
      projectId, principalId, requestId: "search-rule", key: "BR-QUEUE-01", kind: "business_rule",
      title: "Regra para fila", content: { text: "A decisão vale apenas para a fila local." },
    });

    const first = listSpecifications(database, projectId, principalId, { kind: "adr", search: "FILA", limit: 1 });
    assert.equal(first.specifications.length, 1);
    assert.equal(first.specifications[0]?.key, adrOne.key);
    assert.ok(first.nextCursor);
    const second = listSpecifications(database, projectId, principalId, {
      kind: "adr", search: "fila", limit: 1, cursor: first.nextCursor!,
    });
    assert.deepEqual(second.specifications.map(({ key }) => key), ["ADR-QUEUE-02"]);
    assert.equal(second.nextCursor, null);

    const contentSearch = listSpecifications(database, projectId, principalId, { kind: "adr", search: "decisao" });
    assert.deepEqual(contentSearch.specifications.map(({ key }) => key), [adrOne.key]);
    assert.throws(
      () => listSpecifications(database, projectId, principalId, { kind: "adr", search: "pagamento", limit: 1, cursor: first.nextCursor! }),
      (error: unknown) => error instanceof ApplicationError && error.code === "VALIDATION_FAILED",
    );
    assert.throws(
      () => listSpecifications(database, projectId, principalId, { kind: "adr", search: "a" }),
      (error: unknown) => error instanceof ApplicationError && error.code === "VALIDATION_FAILED",
    );
  });
});
