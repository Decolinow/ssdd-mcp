import assert from "node:assert/strict";
import { test } from "node:test";
import { ApplicationError } from "../../src/application/errors.js";
import { fetchGithubIssues, readGithubIssueTokensFromEnvironment } from "../../src/integrations/github-issues.js";

const githubToken = "read-only-test-github-token-123456";

test("GitHub issue reader paginates, excludes pull requests, and sends only read requests", async () => {
  const requested: Array<{ url: URL; init: RequestInit | undefined }> = [];
  const next = "https://api.github.com/repos/acme/payments/issues?state=all&per_page=100&sort=updated&direction=desc&page=2";
  const pages = [
    new Response(JSON.stringify([
      { ...githubIssue(22), pull_request: { url: "https://api.github.com/repos/acme/payments/pulls/22" } },
      githubIssue(23),
    ]), {
      status: 200,
      headers: {
        "content-type": "application/json; charset=utf-8",
        link: `<${next}>; rel="next", <https://api.github.com/repos/acme/payments/issues?page=4>; rel="last"`,
      },
    }),
    new Response(JSON.stringify([githubIssue(24)]), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  ];
  const fetcher: typeof fetch = async (input, init) => {
    requested.push({ url: new URL(input.toString()), init });
    const response = pages.shift();
    assert.ok(response);
    return response;
  };

  const issues = await fetchGithubIssues({ repository: "acme/payments", token: githubToken, limit: 2 }, fetcher);

  assert.deepEqual(issues.map(({ number }) => number), [23, 24]);
  assert.equal(requested.length, 2);
  assert.equal(requested[0]?.url.origin, "https://api.github.com");
  assert.equal(requested[0]?.url.searchParams.get("state"), "all");
  assert.equal(requested[0]?.url.searchParams.get("per_page"), "100");
  assert.equal(requested[0]?.init?.method, "GET");
  assert.equal(requested[0]?.init?.redirect, "error");
  assert.equal(new Headers(requested[0]?.init?.headers).get("authorization"), `Bearer ${githubToken}`);
  assert.equal(requested[1]?.url.href, next);
});

test("GitHub issue reader rejects unsafe pagination and hides provider response bodies", async () => {
  const pageWithExternalNext = new Response("[]", {
    status: 200,
    headers: {
      "content-type": "application/json",
      link: '<https://attacker.example/collect?token=secret>; rel="next"',
    },
  });
  await assert.rejects(
    fetchGithubIssues({ repository: "acme/payments", token: githubToken }, async () => pageWithExternalNext),
    (error: unknown) => error instanceof ApplicationError && error.code === "GITHUB_INVALID_RESPONSE",
  );

  await assert.rejects(
    fetchGithubIssues({ repository: "acme/payments", token: githubToken }, async () => new Response("private token details", {
      status: 401,
      headers: { "content-type": "application/json" },
    })),
    (error: unknown) => error instanceof ApplicationError && error.code === "GITHUB_AUTH_FAILED" && !error.message.includes("private token details"),
  );
});

test("GitHub issue tokens use project-specific variables and reject short or malformed values", () => {
  assert.deepEqual(readGithubIssueTokensFromEnvironment({
    SSDD_GITHUB_ISSUES_TOKEN_PAY: githubToken,
    OTHER_TOKEN: "ignored",
  }), { PAY: githubToken });
  assert.throws(
    () => readGithubIssueTokensFromEnvironment({ SSDD_GITHUB_ISSUES_TOKEN_PAY: "short" }),
    /20-4096 bytes/u,
  );
  assert.throws(
    () => readGithubIssueTokensFromEnvironment({ SSDD_GITHUB_ISSUES_TOKEN_PAYMENTS2026: githubToken }),
    /must end with/u,
  );
});

function githubIssue(number: number) {
  return {
    id: 90_000 + number,
    number,
    title: `Issue ${number}`,
    body: `Body for ${number}`,
    state: "open",
    html_url: `https://github.com/acme/payments/issues/${number}`,
    labels: [{ name: "feature" }],
    created_at: "2026-11-01T12:00:00Z",
    updated_at: "2026-11-02T12:00:00Z",
  };
}
