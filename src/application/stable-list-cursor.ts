import { createHash } from "node:crypto";
import { ApplicationError } from "./errors.js";

export interface StableListCursor {
  readonly version: 1;
  readonly projectId: string;
  readonly principalId: string;
  readonly filterHash: string;
  readonly watermark: number;
  readonly afterKey: string;
  readonly afterId: string;
}

export interface StableListCursorExpectation {
  readonly projectId: string;
  readonly principalId: string;
  readonly filterHash: string;
  readonly watermark: number;
}

export function hashListFilters(filters: unknown): string {
  return createHash("sha256").update(JSON.stringify(filters)).digest("hex");
}

export function encodeStableListCursor(cursor: StableListCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodeStableListCursor(value: string, expected: StableListCursorExpectation): StableListCursor {
  if (value.length > 4_096 || !/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new ApplicationError("VALIDATION_FAILED", "The list cursor is invalid.");
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid cursor shape");
    const cursor = parsed as Record<string, unknown>;
    if (
      cursor.version !== 1 || typeof cursor.projectId !== "string" || typeof cursor.principalId !== "string" ||
      typeof cursor.filterHash !== "string" || !/^[a-f0-9]{64}$/u.test(cursor.filterHash) ||
      typeof cursor.watermark !== "number" || !Number.isSafeInteger(cursor.watermark) || cursor.watermark < 0 ||
      typeof cursor.afterKey !== "string" || cursor.afterKey.length === 0 ||
      typeof cursor.afterId !== "string" || cursor.afterId.length === 0
    ) throw new Error("Invalid cursor fields");
    const valid = cursor as unknown as StableListCursor;
    if (
      valid.projectId !== expected.projectId || valid.principalId !== expected.principalId ||
      valid.filterHash !== expected.filterHash
    ) {
      throw new ApplicationError("VALIDATION_FAILED", "The cursor belongs to another project, principal or filter set.");
    }
    if (valid.watermark !== expected.watermark) {
      throw new ApplicationError("STALE_CURSOR", "The project changed after this page was read. Restart the list without a cursor.");
    }
    return valid;
  } catch (error) {
    if (error instanceof ApplicationError) throw error;
    throw new ApplicationError("VALIDATION_FAILED", "The list cursor is invalid.");
  }
}
