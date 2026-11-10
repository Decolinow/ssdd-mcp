import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { ApplicationError } from "../application/errors.js";
import {
  createGithubWebhookProcessor,
  type GithubRepositoryMappings,
} from "../application/github-webhooks.js";
import { acceptWebhookDelivery } from "../application/webhooks.js";
import type { SqliteDatabase } from "../storage-sqlite/database.js";

export const maximumWebhookRequestBytes = 1_048_576;

export type WebhookSecrets = Readonly<Record<string, Readonly<Record<string, string>>>>;

interface WebhookHeaders {
  readonly deliveryId: string;
  readonly eventType: string;
  readonly signature: string;
}

export function readWebhookSecretsFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): Record<string, Record<string, string>> {
  const secrets: Record<string, Record<string, string>> = {};
  for (const [name, value] of Object.entries(environment)) {
    if (!name.startsWith("SSDD_WEBHOOK_SECRET_")) continue;
    const match = /^SSDD_WEBHOOK_SECRET_([A-Z0-9_]+)__([A-Z][A-Z0-9]{0,9})$/u.exec(name);
    if (match === null) {
      throw new Error(`Environment variable '${name}' must end with '__<PROJECT_KEY>'.`);
    }
    if (value === undefined) throw new Error(`Environment variable '${name}' has no value.`);
    const provider = match[1]!.toLowerCase().replaceAll("_", "-");
    const projectKey = match[2]!;
    if (!Object.hasOwn(secrets, provider)) secrets[provider] = {};
    if (Object.hasOwn(secrets[provider]!, projectKey)) {
      throw new Error(`Webhook provider '${provider}' and project '${projectKey}' are configured more than once.`);
    }
    secrets[provider]![projectKey] = value;
  }
  validateWebhookSecrets(secrets);
  return secrets;
}

export function validateWebhookSecrets(secrets: WebhookSecrets): void {
  for (const [provider, projectSecrets] of Object.entries(secrets)) {
    if (!/^(?=.{1,64}$)[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(provider)) {
      throw new Error("Webhook provider names must use lowercase letters, digits, or hyphens.");
    }
    for (const [projectKey, secret] of Object.entries(projectSecrets)) {
      if (!/^[A-Z][A-Z0-9]{0,9}$/u.test(projectKey)) {
        throw new Error(`Webhook project key for '${provider}' is invalid.`);
      }
      if (typeof secret !== "string" || Buffer.byteLength(secret, "utf8") < 32 || Buffer.byteLength(secret, "utf8") > 4_096) {
        throw new Error(`Webhook secret for '${provider}/${projectKey}' must contain between 32 and 4096 UTF-8 bytes.`);
      }
    }
  }
}

export async function receiveWebhookRequest(
  request: IncomingMessage,
  response: ServerResponse,
  database: SqliteDatabase,
  secrets: WebhookSecrets,
  githubRepositories: GithubRepositoryMappings,
  provider: string,
  projectKey: string,
): Promise<void> {
  const contentLength = singleHeader(request, "content-length");
  if (contentLength !== undefined && !/^\d+$/u.test(contentLength)) {
    await rejectRequest(request, response, 400, "INVALID_CONTENT_LENGTH", "Webhook Content-Length is invalid.");
    return;
  }
  const body = await readLimitedBody(request);
  if (body === undefined) {
    sendJson(response, 413, { code: "REQUEST_TOO_LARGE", message: "Webhook body exceeds the 1 MiB limit." });
    return;
  }

  const providerSecrets = Object.hasOwn(secrets, provider) ? secrets[provider] : undefined;
  const normalizedProjectKey = projectKey.toUpperCase();
  const secret = providerSecrets !== undefined && Object.hasOwn(providerSecrets, normalizedProjectKey)
    ? providerSecrets[normalizedProjectKey]
    : undefined;
  if (secret === undefined) {
    await rejectRequest(request, response, 404, "NOT_FOUND", "Webhook provider is not configured.");
    return;
  }

  const headers = readWebhookHeaders(request, provider);
  if (headers === undefined) {
    await rejectRequest(request, response, 400, "INVALID_WEBHOOK_HEADERS", "Webhook delivery headers are missing or invalid.");
    return;
  }
  const contentType = singleHeader(request, "content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    await rejectRequest(request, response, 415, "UNSUPPORTED_MEDIA_TYPE", "Webhook body must use application/json.");
    return;
  }
  if (!signatureMatches(secret, body, headers.signature)) {
    sendJson(response, 401, { code: "INVALID_SIGNATURE", message: "Webhook signature is invalid." });
    return;
  }

  let parsedPayload: unknown;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(body);
    parsedPayload = JSON.parse(text) as unknown;
  } catch {
    sendJson(response, 400, { code: "INVALID_PAYLOAD", message: "Webhook body must contain valid UTF-8 JSON." });
    return;
  }
  if (typeof parsedPayload !== "object" || parsedPayload === null || Array.isArray(parsedPayload)) {
    sendJson(response, 400, { code: "INVALID_PAYLOAD", message: "Webhook JSON payload must be an object." });
    return;
  }

  try {
    const payload = parsedPayload as Readonly<Record<string, unknown>>;
    const result = acceptWebhookDelivery(database, {
      provider,
      projectKey: normalizedProjectKey,
      deliveryId: headers.deliveryId,
      eventType: headers.eventType,
      payloadSha256: createHash("sha256").update(body).digest("hex"),
      payload,
    }, provider === "github" ? createGithubWebhookProcessor(githubRepositories) : undefined);
    if (result.replayed) response.setHeader("X-SSDD-Webhook-Replay", "true");
    sendJson(response, 202, result.receipt);
  } catch (error) {
    if (error instanceof ApplicationError) {
      const status = error.code === "NOT_FOUND" || error.code === "WEBHOOK_REPOSITORY_NOT_CONFIGURED" || error.code === "WEBHOOK_REPOSITORY_MISMATCH" ? 404
        : error.code === "WEBHOOK_DELIVERY_CONFLICT" ? 409
          : error.code === "VALIDATION_FAILED" ? 400
            : 500;
      sendJson(response, status, {
        code: error.code,
        message: status === 500 ? "Webhook delivery could not be recorded." : error.message,
      });
      return;
    }
    const correlationId = randomUUID();
    const errorType = error instanceof Error ? error.name : "UnknownError";
    process.stderr.write(`Webhook receiver failure ${correlationId} (${errorType}).\n`);
    sendJson(response, 500, { code: "INTERNAL_ERROR", message: "Webhook delivery could not be recorded." });
  }
}

function readWebhookHeaders(request: IncomingMessage, provider: string): WebhookHeaders | undefined {
  const names = provider === "github"
    ? { deliveryId: "x-github-delivery", eventType: "x-github-event", signature: "x-hub-signature-256" }
    : { deliveryId: "x-ssdd-delivery-id", eventType: "x-ssdd-event", signature: "x-ssdd-signature" };
  const deliveryId = singleHeader(request, names.deliveryId);
  const eventType = singleHeader(request, names.eventType);
  const signature = singleHeader(request, names.signature);
  if (
    deliveryId === undefined || !/^[A-Za-z0-9._:-]{1,128}$/u.test(deliveryId) ||
    eventType === undefined || eventType.trim().length === 0 || eventType.length > 120 ||
    signature === undefined || !/^sha256=[a-f0-9]{64}$/iu.test(signature)
  ) {
    return undefined;
  }
  return { deliveryId, eventType, signature };
}

function singleHeader(request: IncomingMessage, name: string): string | undefined {
  const matches: string[] = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() === name) {
      const value = request.rawHeaders[index + 1];
      if (value !== undefined) matches.push(value.trim());
    }
  }
  return matches.length === 1 ? matches[0] : undefined;
}

async function readLimitedBody(request: IncomingMessage): Promise<Buffer | undefined> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  let tooLarge = false;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    bytes += buffer.length;
    if (bytes > maximumWebhookRequestBytes) {
      tooLarge = true;
      continue;
    }
    chunks.push(buffer);
  }
  return tooLarge ? undefined : Buffer.concat(chunks, bytes);
}

function signatureMatches(secret: string, body: Buffer, signature: string): boolean {
  const supplied = Buffer.from(signature.slice("sha256=".length), "hex");
  const expected = createHmac("sha256", secret).update(body).digest();
  return supplied.length === expected.length && timingSafeEqual(expected, supplied);
}

async function rejectRequest(
  request: IncomingMessage,
  response: ServerResponse,
  status: number,
  code: string,
  message: string,
): Promise<void> {
  if (!request.complete && (request.headers["transfer-encoding"] !== undefined || Number(request.headers["content-length"] ?? 0) > 0)) {
    await new Promise<void>((resolveBody) => {
      const finish = (): void => resolveBody();
      request.once("end", finish);
      request.once("aborted", finish);
      request.once("close", finish);
      request.resume();
    });
    response.setHeader("Connection", "close");
  }
  sendJson(response, status, { code, message });
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  if (response.headersSent) return;
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(JSON.stringify(body));
}
