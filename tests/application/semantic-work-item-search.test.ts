import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { createWorkItem } from "../../src/application/create-work-item.js";
import { ApplicationError } from "../../src/application/errors.js";
import { initializeProject } from "../../src/application/initialize-project.js";
import { createManagedUser, ensureBootstrapAdministrator } from "../../src/application/user-management.js";
import { assignWorkItem } from "../../src/application/work-item-commands.js";
import { listWorkItems } from "../../src/application/work-item-queries.js";
import {
  indexWorkItemSemantics,
  searchWorkItemsSemantically,
} from "../../src/application/semantic-work-item-search.js";
import type { TextEmbeddingProvider } from "../../src/integrations/embeddings.js";
import { openSqliteDatabase } from "../../src/storage-sqlite/database.js";

describe("semantic work item search", () => {
  const workspaces: string[] = [];
  afterEach(() => {
    for (const workspace of workspaces.splice(0)) rmSync(workspace, { recursive: true, force: true });
  });

  it("indexes authorized work items, ranks meaning and filters the authenticated user's assignments", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "ssdd-mcp-semantic-search-"));
    workspaces.push(workspace);
    const initialized = initializeProject({
      workspace, key: "PAY", name: "Payments", productGoal: "Pagamentos", timezone: "UTC",
    });
    const database = openSqliteDatabase(initialized.databasePath);
    try {
      const adminId = (database.prepare("SELECT created_by_principal_id FROM projects WHERE project_id = ?")
        .get(initialized.project.id) as { created_by_principal_id: string }).created_by_principal_id;
      ensureBootstrapAdministrator(database, adminId);
      const developer = createManagedUser(database, {
        actorPrincipalId: adminId,
        requestId: "semantic-dev-user",
        displayName: "Developer Search",
        principalType: "human",
        projects: [{ projectId: initialized.project.id, roles: ["developer"] }],
        reason: "Acesso de desenvolvimento",
      });
      const epic = createWorkItem(database, {
        projectId: initialized.project.id, principalId: adminId, requestId: randomUUID(),
        type: "epic", title: "Payment platform",
      }).value;
      const feature = createWorkItem(database, {
        projectId: initialized.project.id, principalId: adminId, requestId: randomUUID(),
        type: "feature", parentId: epic.id, title: "Billing workflow",
      }).value;
      const chargeback = createWorkItem(database, {
        projectId: initialized.project.id, principalId: adminId, requestId: randomUUID(),
        type: "story", parentId: feature.id, title: "Chargeback for duplicate payment",
        description: "Resolve card disputes and return funds to the customer.",
      }).value;
      createWorkItem(database, {
        projectId: initialized.project.id, principalId: adminId, requestId: randomUUID(),
        type: "story", parentId: feature.id, title: "Invoice schedule",
        description: "Generate recurring invoices at the end of each billing cycle.",
      });
      assignWorkItem(database, {
        projectId: initialized.project.id, principalId: adminId, requestId: randomUUID(),
        itemIdOrKey: chargeback.key, assigneeId: developer.principalId, expectedVersion: chargeback.version,
      });

      const vectorsFor = (text: string): number[] => /refund|chargeback|dispute|duplicate payment/iu.test(text)
        ? [1, 0]
        : /invoice|billing cycle/iu.test(text) ? [0, 1] : [0.25, 0.25];
      let providerCalls = 0;
      const provider: TextEmbeddingProvider = {
        modelKey: createHash("sha256").update("test-model").digest("hex"),
        modelName: "test-embedding-model",
        embed: async (inputs) => {
          providerCalls += 1;
          return inputs.map(vectorsFor);
        },
      };

      const myItems = listWorkItems(database, {
        projectId: initialized.project.id, principalId: developer.principalId, assignedToMe: true,
      });
      assert.deepEqual(myItems.items.map((item) => item.id), [chargeback.id]);

      const search = await searchWorkItemsSemantically(database, provider, {
        projectId: initialized.project.id,
        principalId: developer.principalId,
        query: "refund a disputed card payment",
        assignedToMe: true,
      });
      assert.equal(search.indexComplete, true);
      assert.equal(search.missingEmbeddingCount, 0);
      assert.equal(search.results[0]?.id, chargeback.id);
      assert.equal(search.results[0]?.similarity, 1);
      assert.equal(providerCalls, 2, "one batch indexes task text and one request embeds the query");

      const unchanged = await indexWorkItemSemantics(database, provider, {
        projectId: initialized.project.id, principalId: developer.principalId, assignedToMe: true,
      });
      assert.equal(unchanged.indexedCount, 0);
      assert.equal(unchanged.unchangedCount, 1);
      assert.equal(providerCalls, 2);

      const filteredSearch = await searchWorkItemsSemantically(database, provider, {
        projectId: initialized.project.id,
        principalId: developer.principalId,
        query: "refund a disputed card payment",
        types: ["story"],
        states: ["draft"],
        limit: 1,
      });
      assert.equal(filteredSearch.indexComplete, true);
      assert.equal(filteredSearch.results[0]?.id, chargeback.id);
      assert.equal(filteredSearch.results[0]?.title, "Chargeback for duplicate payment");

      const tiedSearch = await searchWorkItemsSemantically(database, provider, {
        projectId: initialized.project.id,
        principalId: developer.principalId,
        query: "generic unrelated terms",
        limit: 2,
      });
      assert.deepEqual(
        tiedSearch.results.map((item) => item.key),
        [epic.key, feature.key],
        "top-K ranking must keep the strongest results and order equal similarities by stable key",
      );

      const oversizedProvider: TextEmbeddingProvider = {
        ...provider,
        modelKey: createHash("sha256").update("oversized-model").digest("hex"),
        embed: async (inputs) => inputs.map(() => Array.from({ length: 8_193 }, () => 0)),
      };
      await assert.rejects(
        () => indexWorkItemSemantics(database, oversizedProvider, {
          projectId: initialized.project.id, principalId: developer.principalId, limit: 1,
        }),
        (error: unknown) => error instanceof ApplicationError && error.code === "EMBEDDING_PROVIDER_INVALID_RESPONSE",
      );

      const unauthorized = await assert.rejects(
        () => searchWorkItemsSemantically(database, provider, {
          projectId: initialized.project.id, principalId: randomUUID(), query: "refund payment",
        }),
        (error: unknown) => error instanceof ApplicationError && error.code === "FORBIDDEN",
      );
      assert.equal(unauthorized, undefined);

      const page = await indexWorkItemSemantics(database, provider, {
        projectId: initialized.project.id, principalId: developer.principalId, limit: 1,
      });
      assert.ok(page.nextCursor);
      createWorkItem(database, {
        projectId: initialized.project.id, principalId: adminId, requestId: randomUUID(),
        type: "story", parentId: feature.id, title: "New payment reconciliation",
      });
      await assert.rejects(
        () => indexWorkItemSemantics(database, provider, {
          projectId: initialized.project.id, principalId: developer.principalId, limit: 1, cursor: page.nextCursor!,
        }),
        (error: unknown) => error instanceof ApplicationError && error.code === "STALE_CURSOR",
      );
    } finally {
      database.close();
    }
  });

  it("fails clearly when semantic search has no configured provider", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "ssdd-mcp-semantic-no-provider-"));
    workspaces.push(workspace);
    const initialized = initializeProject({
      workspace, key: "PAY", name: "Payments", productGoal: "Pagamentos", timezone: "UTC",
    });
    const database = openSqliteDatabase(initialized.databasePath);
    try {
      const principalId = (database.prepare("SELECT created_by_principal_id FROM projects WHERE project_id = ?")
        .get(initialized.project.id) as { created_by_principal_id: string }).created_by_principal_id;
      await assert.rejects(
        () => searchWorkItemsSemantically(database, undefined, {
          projectId: initialized.project.id, principalId, query: "payments and invoices",
        }),
        (error: unknown) => error instanceof ApplicationError && error.code === "EMBEDDINGS_NOT_CONFIGURED",
      );
    } finally {
      database.close();
    }
  });

  it("rejects an oversized exact search before calling the embedding provider", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "ssdd-mcp-semantic-search-bound-"));
    workspaces.push(workspace);
    const initialized = initializeProject({
      workspace, key: "PAY", name: "Payments", productGoal: "Pagamentos", timezone: "UTC",
    });
    const database = openSqliteDatabase(initialized.databasePath);
    try {
      const principalId = (database.prepare("SELECT created_by_principal_id FROM projects WHERE project_id = ?")
        .get(initialized.project.id) as { created_by_principal_id: string }).created_by_principal_id;
      ensureBootstrapAdministrator(database, principalId);
      const epic = createWorkItem(database, {
        projectId: initialized.project.id, principalId, requestId: randomUUID(), type: "epic", title: "Bulk search fixture",
      }).value;
      database.prepare(`
        WITH RECURSIVE digits(value) AS (
          SELECT 0 UNION ALL SELECT value + 1 FROM digits WHERE value < 99
        )
        INSERT INTO work_items (
          item_id, project_id, item_key, type, parent_id, title,
          created_by_principal_id, created_at, updated_at
        )
        SELECT
          'bulk-' || printf('%05d', high.value * 100 + low.value),
          ?,
          'PAY-' || printf('%05d', high.value * 100 + low.value),
          'task', ?, 'Bulk search fixture', ?, '2026-11-11T00:00:00.000Z', '2026-11-11T00:00:00.000Z'
        FROM digits AS high CROSS JOIN digits AS low
      `).run(initialized.project.id, epic.id, principalId);

      let providerCalls = 0;
      const provider: TextEmbeddingProvider = {
        modelKey: createHash("sha256").update("bounded-search-model").digest("hex"),
        modelName: "test-bounded-search-model",
        embed: async (inputs) => {
          providerCalls += 1;
          return inputs.map(() => [1, 0]);
        },
      };
      await assert.rejects(
        () => searchWorkItemsSemantically(database, provider, {
          projectId: initialized.project.id, principalId, query: "bulk search fixtures",
        }),
        (error: unknown) => error instanceof ApplicationError && error.code === "SEMANTIC_SEARCH_PROJECT_TOO_LARGE",
      );
      assert.equal(providerCalls, 0, "oversized projects must be rejected before query or indexing embeddings are requested");
    } finally {
      database.close();
    }
  });
});
