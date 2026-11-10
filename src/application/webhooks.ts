import { randomUUID } from "node:crypto";
import type { SqliteDatabase } from "../storage-sqlite/database.js";
import { ApplicationError } from "./errors.js";

export interface AcceptWebhookDeliveryInput {
  readonly provider: string;
  readonly projectKey: string;
  readonly deliveryId: string;
  readonly eventType: string;
  readonly payloadSha256: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface WebhookReceipt {
  readonly receiptId: string;
  readonly provider: string;
  readonly deliveryId: string;
  readonly eventType: string;
  readonly receivedAt: string;
  readonly status: "accepted";
}

export interface AcceptWebhookDeliveryResult {
  readonly receipt: WebhookReceipt;
  readonly replayed: boolean;
}

export interface AcceptedWebhookContext {
  readonly projectId: string;
  readonly projectKey: string;
  readonly principalId: string;
  readonly receipt: WebhookReceipt;
  readonly payload: Readonly<Record<string, unknown>>;
}

export type WebhookDeliveryProcessor = (
  database: SqliteDatabase,
  context: AcceptedWebhookContext,
) => void;

interface ExistingReceiptRow {
  readonly payload_sha256: string;
  readonly event_type: string;
  readonly receipt_json: string;
}

interface ProjectRow {
  readonly project_id: string;
}

export function acceptWebhookDelivery(
  database: SqliteDatabase,
  input: AcceptWebhookDeliveryInput,
  processDelivery?: WebhookDeliveryProcessor,
): AcceptWebhookDeliveryResult {
  validateInput(input);
  const execute = database.transaction(() => {
    const existing = database.prepare(
      `SELECT payload_sha256, event_type, receipt_json FROM webhook_receipts
       WHERE provider = ? AND delivery_id = ?`,
    ).get(input.provider, input.deliveryId) as ExistingReceiptRow | undefined;

    if (existing !== undefined) {
      if (existing.payload_sha256 !== input.payloadSha256 || existing.event_type !== input.eventType) {
        throw new ApplicationError(
          "WEBHOOK_DELIVERY_CONFLICT",
          "This provider delivery ID was already accepted with a different payload.",
        );
      }
      return {
        receipt: JSON.parse(existing.receipt_json) as WebhookReceipt,
        replayed: true,
      };
    }

    const project = database.prepare(
      "SELECT project_id FROM projects WHERE project_key = ?",
    ).get(input.projectKey) as ProjectRow | undefined;
    if (project === undefined) {
      throw new ApplicationError("NOT_FOUND", "Webhook project was not found.");
    }

    const principalId = getOrCreateWebhookPrincipal(database, input.provider);
    const receipt: WebhookReceipt = {
      receiptId: randomUUID(),
      provider: input.provider,
      deliveryId: input.deliveryId,
      eventType: input.eventType,
      receivedAt: new Date().toISOString(),
      status: "accepted",
    };
    const receiptJson = JSON.stringify(receipt);
    database.prepare(
      `INSERT INTO webhook_receipts
        (receipt_id, provider, delivery_id, project_id, principal_id, event_type,
         payload_sha256, receipt_json, received_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      receipt.receiptId,
      input.provider,
      input.deliveryId,
      project.project_id,
      principalId,
      input.eventType,
      input.payloadSha256,
      receiptJson,
      receipt.receivedAt,
    );

    database.prepare(
      `INSERT INTO audit_events
        (event_id, project_id, principal_id, event_type, entity_type, entity_id,
         correlation_id, occurred_at, payload_json)
       VALUES (?, ?, ?, 'webhook.received', 'webhook_receipt', ?, ?, ?, ?)`,
    ).run(
      randomUUID(),
      project.project_id,
      principalId,
      receipt.receiptId,
      receipt.receiptId,
      receipt.receivedAt,
      JSON.stringify({
        provider: input.provider,
        deliveryId: input.deliveryId,
        eventType: input.eventType,
        payloadSha256: input.payloadSha256,
      }),
    );

    processDelivery?.(database, {
      projectId: project.project_id,
      projectKey: input.projectKey,
      principalId,
      receipt,
      payload: input.payload,
    });

    return { receipt, replayed: false };
  });

  return execute.immediate();
}

function getOrCreateWebhookPrincipal(database: SqliteDatabase, provider: string): string {
  const identityKey = `webhook:${provider}`;
  const existing = database.prepare(
    "SELECT principal_id FROM principals WHERE identity_key = ?",
  ).get(identityKey) as { principal_id: string } | undefined;
  if (existing !== undefined) return existing.principal_id;

  const principalId = randomUUID();
  database.prepare(
    `INSERT INTO principals (principal_id, principal_type, identity_key, display_name, created_at)
     VALUES (?, 'service', ?, ?, ?)`,
  ).run(principalId, identityKey, `Webhook ${provider}`, new Date().toISOString());
  return principalId;
}

function validateInput(input: AcceptWebhookDeliveryInput): void {
  if (!/^(?=.{1,64}$)[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(input.provider)) {
    throw new ApplicationError("VALIDATION_FAILED", "Webhook provider is invalid.");
  }
  if (!/^[A-Z][A-Z0-9]{0,9}$/u.test(input.projectKey)) {
    throw new ApplicationError("VALIDATION_FAILED", "Webhook project key is invalid.");
  }
  if (!/^[A-Za-z0-9._:-]{1,128}$/u.test(input.deliveryId)) {
    throw new ApplicationError("VALIDATION_FAILED", "Webhook delivery ID is invalid.");
  }
  if (input.eventType.trim().length === 0 || input.eventType.length > 120) {
    throw new ApplicationError("VALIDATION_FAILED", "Webhook event type is invalid.");
  }
  if (!/^[a-f0-9]{64}$/iu.test(input.payloadSha256)) {
    throw new ApplicationError("VALIDATION_FAILED", "Webhook payload digest is invalid.");
  }
}
