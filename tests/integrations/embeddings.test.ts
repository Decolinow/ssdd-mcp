import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import { once } from "node:events";
import { test } from "node:test";
import { createTextEmbeddingProvider, readTextEmbeddingProviderFromEnvironment } from "../../src/integrations/embeddings.js";
import { ApplicationError } from "../../src/application/errors.js";

test("OpenAI-compatible embeddings are validated, ordered and sent only to a secure configured endpoint", async () => {
  let authorization: string | undefined;
  let requestBody = "";
  const server = createServer((request, response) => {
    authorization = request.headers.authorization;
    request.on("data", (chunk: Buffer) => { requestBody += chunk.toString("utf8"); });
    request.on("end", () => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        data: [
          { index: 1, embedding: [0, 1] },
          { index: 0, embedding: [1, 0] },
        ],
      }));
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string");
  try {
    const provider = createTextEmbeddingProvider({
      endpoint: `http://127.0.0.1:${address.port}/v1/embeddings`,
      model: "test-embedding-model",
      apiKey: "test-provider-secret",
    });
    const vectors = await provider.embed(["first meaning", "second meaning"]);
    assert.deepEqual(vectors, [[1, 0], [0, 1]]);
    assert.equal(authorization, "Bearer test-provider-secret");
    assert.deepEqual(JSON.parse(requestBody) as { model: string; input: string[] }, {
      model: "test-embedding-model", input: ["first meaning", "second meaning"],
    });
    assert.throws(() => createTextEmbeddingProvider({ endpoint: "http://embedding.example/v1/embeddings", model: "model" }));
    assert.throws(() => createTextEmbeddingProvider({ endpoint: "https://example.com/v1/embeddings?token=secret", model: "model" }));
    assert.throws(() => readTextEmbeddingProviderFromEnvironment({ SSDD_EMBEDDING_MODEL: "partial" }));
  } finally {
    await closeServer(server);
  }
});

test("embedding provider failures are sanitized and report retryability", async () => {
  const server = createServer((_request, response) => writeError(response));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string");
  try {
    const provider = createTextEmbeddingProvider({
      endpoint: `http://127.0.0.1:${address.port}/v1/embeddings`, model: "test-model",
    });
    await assert.rejects(
      () => provider.embed(["private task content"]),
      (error: unknown) => error instanceof ApplicationError && error.code === "EMBEDDING_PROVIDER_ERROR" && error.retryable && !error.message.includes("provider-secret"),
    );
  } finally {
    await closeServer(server);
  }
});

test("embedding provider responses have an explicit 8 MiB bound", async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json", "content-length": String(9 * 1_024 * 1_024) });
    response.end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string");
  try {
    const provider = createTextEmbeddingProvider({
      endpoint: `http://127.0.0.1:${address.port}/v1/embeddings`, model: "test-model",
    });
    await assert.rejects(
      () => provider.embed(["small query"]),
      (error: unknown) => error instanceof ApplicationError && error.code === "EMBEDDING_PROVIDER_RESPONSE_TOO_LARGE",
    );
  } finally {
    await closeServer(server);
  }
});

function writeError(response: ServerResponse): void {
  response.writeHead(503, { "content-type": "application/json" });
  response.end(JSON.stringify({ error: "provider-secret-must-not-be-returned" }));
}

async function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error === undefined ? resolve() : reject(error));
  });
}
