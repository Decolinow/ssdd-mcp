import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * Operational policies for the Streamable HTTP server (SSDD-915): structured access logs, bounded-cardinality
 * metrics and a per-client rate limit. Everything is opt-in; nothing here reads request bodies, headers with
 * credentials or query strings, so logs and metrics never carry tokens or domain content.
 */
export interface AccessLogEntry {
  readonly timestamp: string;
  readonly level: "info" | "warn";
  readonly event: "http_request";
  readonly correlationId: string;
  readonly method: string;
  readonly route: HttpRoute;
  readonly status: number;
  readonly durationMs: number;
  readonly rateLimited: boolean;
}

export interface McpHttpObservabilityOptions {
  /** Receives one JSON-serializable entry per finished request. */
  readonly accessLog?: (entry: AccessLogEntry) => void;
  /** Serves Prometheus text on `GET /metrics` for loopback callers only. */
  readonly metrics?: boolean;
  /** Fixed one-minute window per remote address, applied to every route except the health probes. */
  readonly rateLimit?: { readonly requestsPerMinute: number };
}

export type HttpRoute = "mcp" | "health" | "webhook" | "metrics" | "other";

const durationBucketsMs = [10, 50, 100, 250, 500, 1_000, 5_000] as const;
const statusClasses = ["2xx", "3xx", "4xx", "5xx"] as const;
const routes: readonly HttpRoute[] = ["mcp", "health", "webhook", "metrics", "other"];

export interface HttpObservability {
  /** Returns true when the request was fully handled here (metrics export or rate limit rejection). */
  readonly intercept: (request: IncomingMessage, response: ServerResponse) => boolean;
  readonly render: () => string;
}

export function validateObservabilityOptions(options: McpHttpObservabilityOptions): void {
  const limit = options.rateLimit?.requestsPerMinute;
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000_000)) {
    throw new Error("Rate limit must be an integer between 1 and 1000000 requests per minute.");
  }
}

export function classifyRoute(pathname: string): HttpRoute {
  if (pathname === "/mcp") return "mcp";
  if (pathname === "/healthz" || pathname === "/readyz") return "health";
  if (pathname === "/metrics") return "metrics";
  if (pathname.startsWith("/webhooks/")) return "webhook";
  return "other";
}

export function createHttpObservability(options: McpHttpObservabilityOptions = {}): HttpObservability {
  validateObservabilityOptions(options);
  const counts = new Map<string, number>();
  const bucketCounts = new Map<HttpRoute, number[]>(routes.map((route) => [route, durationBucketsMs.map(() => 0)]));
  const durationSums = new Map<HttpRoute, number>(routes.map((route) => [route, 0]));
  const durationTotals = new Map<HttpRoute, number>(routes.map((route) => [route, 0]));
  const rateLimited = { total: 0 };
  const windows = new Map<string, { windowStart: number; used: number }>();

  const record = (route: HttpRoute, status: number, durationMs: number): void => {
    const statusClass = `${Math.floor(status / 100)}xx`;
    const key = `${route}|${(statusClasses as readonly string[]).includes(statusClass) ? statusClass : "other"}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
    const buckets = bucketCounts.get(route)!;
    durationBucketsMs.forEach((upper, index) => {
      if (durationMs <= upper) buckets[index]! += 1;
    });
    durationSums.set(route, durationSums.get(route)! + durationMs);
    durationTotals.set(route, durationTotals.get(route)! + 1);
  };

  const allow = (key: string, limit: number, now: number): boolean => {
    if (windows.size > 10_000) {
      for (const [stale, state] of windows) if (now - state.windowStart >= 60_000) windows.delete(stale);
    }
    const state = windows.get(key);
    if (state === undefined || now - state.windowStart >= 60_000) {
      windows.set(key, { windowStart: now, used: 1 });
      return true;
    }
    state.used += 1;
    return state.used <= limit;
  };

  const render = (): string => {
    const lines: string[] = [
      "# HELP ssdd_http_requests_total Finished HTTP requests by route and status class.",
      "# TYPE ssdd_http_requests_total counter",
    ];
    for (const route of routes) {
      for (const statusClass of [...statusClasses, "other"]) {
        const value = counts.get(`${route}|${statusClass}`);
        if (value !== undefined) lines.push(`ssdd_http_requests_total{route="${route}",status_class="${statusClass}"} ${value}`);
      }
    }
    lines.push("# HELP ssdd_http_rate_limited_total Requests rejected by the rate limit.", "# TYPE ssdd_http_rate_limited_total counter",
      `ssdd_http_rate_limited_total ${rateLimited.total}`,
      "# HELP ssdd_http_request_duration_ms Request duration in milliseconds.", "# TYPE ssdd_http_request_duration_ms histogram");
    for (const route of routes) {
      const total = durationTotals.get(route)!;
      if (total === 0) continue;
      const buckets = bucketCounts.get(route)!;
      durationBucketsMs.forEach((upper, index) => {
        lines.push(`ssdd_http_request_duration_ms_bucket{route="${route}",le="${upper}"} ${buckets[index]}`);
      });
      lines.push(`ssdd_http_request_duration_ms_bucket{route="${route}",le="+Inf"} ${total}`,
        `ssdd_http_request_duration_ms_sum{route="${route}"} ${Math.round(durationSums.get(route)!)}`,
        `ssdd_http_request_duration_ms_count{route="${route}"} ${total}`);
    }
    return `${lines.join("\n")}\n`;
  };

  const intercept = (request: IncomingMessage, response: ServerResponse): boolean => {
    const startedAt = performance.now();
    const correlationId = randomUUID();
    let route: HttpRoute = "other";
    try {
      route = classifyRoute(new URL(request.url ?? "/", "http://localhost").pathname);
    } catch {
      route = "other";
    }
    let limited = false;
    response.setHeader("X-Correlation-Id", correlationId);
    response.once("finish", () => {
      const durationMs = performance.now() - startedAt;
      record(route, response.statusCode, durationMs);
      options.accessLog?.({
        timestamp: new Date().toISOString(),
        level: response.statusCode >= 500 || limited ? "warn" : "info",
        event: "http_request",
        correlationId,
        method: request.method ?? "UNKNOWN",
        route,
        status: response.statusCode,
        durationMs: Math.round(durationMs * 100) / 100,
        rateLimited: limited,
      });
    });

    if (route === "metrics") {
      if (options.metrics !== true || request.method !== "GET" || !isLoopback(request.socket.remoteAddress)) {
        response.statusCode = options.metrics === true ? 403 : 404;
        response.setHeader("Content-Type", "application/json; charset=utf-8");
        response.end(JSON.stringify({ code: options.metrics === true ? "FORBIDDEN" : "NOT_FOUND" }));
        return true;
      }
      response.statusCode = 200;
      response.setHeader("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
      response.end(render());
      return true;
    }

    const limit = options.rateLimit?.requestsPerMinute;
    if (limit !== undefined && route !== "health" && !allow(request.socket.remoteAddress ?? "unknown", limit, Date.now())) {
      limited = true;
      rateLimited.total += 1;
      response.statusCode = 429;
      response.setHeader("Retry-After", "60");
      response.setHeader("Content-Type", "application/json; charset=utf-8");
      response.end(JSON.stringify({ code: "RATE_LIMITED", message: "Too many requests; retry later." }));
      return true;
    }
    return false;
  };

  return { intercept, render };
}

function isLoopback(address: string | undefined): boolean {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}
