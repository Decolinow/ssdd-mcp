import { createHash } from "node:crypto";
import { ApplicationError } from "../application/errors.js";

const maximumEmbeddingResponseBytes = 8 * 1_024 * 1_024;

export interface TextEmbeddingProvider {
  readonly modelKey: string;
  readonly modelName: string;
  embed(inputs: readonly string[]): Promise<readonly (readonly number[])[]>;
}

interface EmbeddingProviderOptions {
  readonly endpoint: string;
  readonly model: string;
  readonly apiKey?: string;
}

export function readTextEmbeddingProviderFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): TextEmbeddingProvider | undefined {
  const endpoint = environment.SSDD_EMBEDDING_ENDPOINT?.trim();
  const model = environment.SSDD_EMBEDDING_MODEL?.trim();
  const apiKey = environment.SSDD_EMBEDDING_API_KEY?.trim();
  if (endpoint === undefined && model === undefined && apiKey === undefined) return undefined;
  if (endpoint === undefined || model === undefined) {
    throw new Error("SSDD_EMBEDDING_ENDPOINT and SSDD_EMBEDDING_MODEL must be configured together.");
  }
  return createTextEmbeddingProvider({
    endpoint,
    model,
    ...(apiKey === undefined || apiKey.length === 0 ? {} : { apiKey }),
  });
}

export function createTextEmbeddingProvider(options: EmbeddingProviderOptions): TextEmbeddingProvider {
  const endpoint = validateEndpoint(options.endpoint);
  const modelName = options.model.trim();
  if (modelName.length < 1 || modelName.length > 128 || /\p{Cc}/u.test(modelName)) {
    throw new Error("The embedding model name must contain 1-128 printable characters.");
  }
  const apiKey = options.apiKey?.trim();
  const modelKey = createHash("sha256").update(`${endpoint.href}\u0000${modelName}`).digest("hex");

  return {
    modelKey,
    modelName,
    embed: async (inputs) => {
      if (inputs.length < 1 || inputs.length > 32) {
        throw new ApplicationError("VALIDATION_FAILED", "Embedding batches must contain 1-32 texts.");
      }
      const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json" };
      if (apiKey !== undefined && apiKey.length > 0) headers.authorization = `Bearer ${apiKey}`;
      let response: Response;
      try {
        response = await fetch(endpoint, {
          method: "POST",
          headers,
          body: JSON.stringify({ model: modelName, input: inputs }),
          signal: AbortSignal.timeout(20_000),
        });
      } catch (error) {
        throw new ApplicationError("EMBEDDING_PROVIDER_UNAVAILABLE", "The configured embedding provider could not be reached.", {
          retryable: true,
          details: { cause: error instanceof Error ? error.name : "unknown" },
        });
      }
      if (!response.ok) {
        throw new ApplicationError("EMBEDDING_PROVIDER_ERROR", `The configured embedding provider returned HTTP ${response.status}.`, {
          retryable: response.status === 429 || response.status >= 500,
        });
      }
      const payload = await readBoundedJson(response);
      return parseEmbeddingResponse(payload, inputs.length);
    },
  };
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && Number(contentLength) > maximumEmbeddingResponseBytes) {
    throw new ApplicationError("EMBEDDING_PROVIDER_RESPONSE_TOO_LARGE", "The embedding provider response exceeds the 8 MiB limit.");
  }
  if (response.body === null) return null;

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maximumEmbeddingResponseBytes) {
        await reader.cancel();
        throw new ApplicationError("EMBEDDING_PROVIDER_RESPONSE_TOO_LARGE", "The embedding provider response exceeds the 8 MiB limit.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(body)) as unknown;
  } catch {
    return null;
  }
}

function validateEndpoint(value: string): URL {
  let endpoint: URL;
  try {
    endpoint = new URL(value.trim());
  } catch {
    throw new Error("SSDD_EMBEDDING_ENDPOINT must be an absolute URL.");
  }
  const localHost = ["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname.toLowerCase());
  if (
    (endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && localHost)) ||
    endpoint.username.length > 0 || endpoint.password.length > 0 ||
    endpoint.search.length > 0 || endpoint.hash.length > 0
  ) {
    throw new Error("The embedding endpoint must use HTTPS, or HTTP on loopback, without credentials/query/fragment.");
  }
  if (!endpoint.pathname.endsWith("/embeddings")) {
    throw new Error("The embedding endpoint path must end in /embeddings.");
  }
  return endpoint;
}

function parseEmbeddingResponse(value: unknown, expectedCount: number): readonly (readonly number[])[] {
  if (value === null || typeof value !== "object" || !Array.isArray((value as { data?: unknown }).data)) {
    throw new ApplicationError("EMBEDDING_PROVIDER_INVALID_RESPONSE", "The embedding provider returned an invalid response.");
  }
  const data = (value as { data: unknown[] }).data;
  if (data.length !== expectedCount) {
    throw new ApplicationError("EMBEDDING_PROVIDER_INVALID_RESPONSE", "The embedding provider returned a different number of vectors than requested.");
  }
  const vectors = data.map((entry) => {
    if (entry === null || typeof entry !== "object" || !Array.isArray((entry as { embedding?: unknown }).embedding)) {
      throw new ApplicationError("EMBEDDING_PROVIDER_INVALID_RESPONSE", "The embedding provider returned a malformed vector.");
    }
    const vector = (entry as { embedding: unknown[] }).embedding;
    if (vector.length < 1 || vector.length > 8_192 || vector.some((component) => typeof component !== "number" || !Number.isFinite(component))) {
      throw new ApplicationError("EMBEDDING_PROVIDER_INVALID_RESPONSE", "Embedding vectors must contain 1-8192 finite numbers.");
    }
    return vector as number[];
  });
  const dimension = vectors[0]?.length;
  if (dimension === undefined || vectors.some((vector) => vector.length !== dimension)) {
    throw new ApplicationError("EMBEDDING_PROVIDER_INVALID_RESPONSE", "Embedding vectors in one response must have the same dimension.");
  }
  const indexed = data.map((entry, index) => ({
    index: entry !== null && typeof entry === "object" && Number.isSafeInteger((entry as { index?: unknown }).index)
      ? (entry as { index: number }).index
      : index,
    vector: vectors[index]!,
  })).sort((left, right) => left.index - right.index);
  if (indexed.some((entry, index) => entry.index !== index)) {
    throw new ApplicationError("EMBEDDING_PROVIDER_INVALID_RESPONSE", "The embedding provider returned duplicate or missing vector indexes.");
  }
  return indexed.map((entry) => entry.vector);
}
