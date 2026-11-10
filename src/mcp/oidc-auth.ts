import {
  OAuthError,
  OAuthErrorCode,
  buildOAuthProtectedResourceMetadata,
  getOAuthProtectedResourceMetadataUrl,
  requireBearerAuth,
  type AuthInfo,
  type AuthMetadataOptions,
  type OAuthTokenVerifier,
} from "@modelcontextprotocol/server";
import { createRemoteJWKSet, jwtVerify } from "jose";

export const requiredMcpScope = "ssdd:mcp";

export interface OidcHttpAuthOptions {
  readonly issuer: string;
  readonly resourceUrl: string;
  readonly requiredScope?: string;
}

export interface OidcHttpAuth {
  readonly issuer: string;
  readonly resourceUrl: URL;
  readonly metadataUrl: string;
  readonly metadataOptions: AuthMetadataOptions;
  readonly authenticate: (request: Request) => Promise<AuthInfo | Response>;
}

interface OidcDiscoveryDocument {
  readonly issuer: string;
  readonly jwks_uri: string;
  readonly authorization_endpoint: string;
  readonly token_endpoint: string;
  readonly response_types_supported: readonly string[];
  readonly subject_types_supported: readonly string[];
  readonly id_token_signing_alg_values_supported: readonly string[];
  readonly scopes_supported?: readonly string[];
  readonly [claim: string]: unknown;
}

const acceptedSigningAlgorithms = [
  "RS256", "RS384", "RS512",
  "PS256", "PS384", "PS512",
  "ES256", "ES384", "ES512",
  "EdDSA",
] as const;

export function validateOidcHttpAuthOptions(options: OidcHttpAuthOptions): OidcHttpAuthOptions {
  const issuer = validateSecureUrl(options.issuer, "OIDC issuer");
  const resourceUrl = validateSecureUrl(options.resourceUrl, "MCP resource URL");
  const parsedResource = new URL(resourceUrl);
  if (parsedResource.pathname !== "/mcp" || parsedResource.search.length > 0 || parsedResource.hash.length > 0) {
    throw new Error("MCP resource URL must identify the /mcp endpoint without query or fragment.");
  }
  const requiredScope = options.requiredScope?.trim() || requiredMcpScope;
  if (!/^[A-Za-z0-9:_-]{1,128}$/u.test(requiredScope)) {
    throw new Error("The required OAuth scope is invalid.");
  }
  return { issuer, resourceUrl, requiredScope };
}

export async function createOidcHttpAuth(options: OidcHttpAuthOptions): Promise<OidcHttpAuth> {
  const validated = validateOidcHttpAuthOptions(options);
  const issuerUrl = new URL(validated.issuer);
  const resourceUrl = new URL(validated.resourceUrl);
  const discoveryUrl = getDiscoveryUrl(issuerUrl);
  const discovery = await loadDiscoveryDocument(discoveryUrl, validated.issuer);
  const jwksUrl = new URL(discovery.jwks_uri);
  assertSecureUrl(jwksUrl, "OIDC JWKS URL");
  const remoteJwks = createRemoteJWKSet(jwksUrl, { timeoutDuration: 5_000 });

  const verifier: OAuthTokenVerifier = {
    verifyAccessToken: async (token) => {
      try {
        const { payload } = await jwtVerify(token, remoteJwks, {
          algorithms: [...acceptedSigningAlgorithms],
          issuer: validated.issuer,
          audience: validated.resourceUrl,
          requiredClaims: ["exp", "sub"],
          clockTolerance: 5,
        });
        if (typeof payload.sub !== "string" || payload.sub.trim().length === 0) {
          throw new OAuthError(OAuthErrorCode.InvalidToken, "Access token has no subject.");
        }
        if (typeof payload.exp !== "number" || !Number.isFinite(payload.exp)) {
          throw new OAuthError(OAuthErrorCode.InvalidToken, "Access token has no expiration.");
        }

        return {
          token,
          clientId: stringClaim(payload.azp) ?? stringClaim(payload.client_id) ?? payload.sub,
          scopes: readScopes(payload.scope, payload.scp),
          expiresAt: payload.exp,
          resource: resourceUrl,
          extra: { issuer: validated.issuer, subject: payload.sub },
        };
      } catch (error) {
        if (error instanceof OAuthError) throw error;
        throw new OAuthError(OAuthErrorCode.InvalidToken, "Access token is invalid.");
      }
    },
  };

  const metadataUrl = getOAuthProtectedResourceMetadataUrl(resourceUrl);
  const metadataOptions: AuthMetadataOptions = {
    oauthMetadata: discovery as unknown as AuthMetadataOptions["oauthMetadata"],
    resourceServerUrl: resourceUrl,
    scopesSupported: [validated.requiredScope ?? requiredMcpScope],
    resourceName: "SSDD MCP",
  };
  buildOAuthProtectedResourceMetadata(metadataOptions);

  return {
    issuer: validated.issuer,
    resourceUrl,
    metadataUrl,
    metadataOptions,
    authenticate: requireBearerAuth({
      verifier,
      requiredScopes: [validated.requiredScope ?? requiredMcpScope],
      expectedResource: resourceUrl,
      resourceMetadataUrl: metadataUrl,
    }),
  };
}

function getDiscoveryUrl(issuerUrl: URL): URL {
  const issuerPath = issuerUrl.pathname.replace(/\/+$/u, "");
  return new URL(`${issuerPath}/.well-known/openid-configuration`, issuerUrl.origin);
}

async function loadDiscoveryDocument(url: URL, expectedIssuer: string): Promise<OidcDiscoveryDocument> {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    throw new Error("Could not reach the configured OIDC discovery endpoint.");
  }
  if (!response.ok) throw new Error(`OIDC discovery returned HTTP ${response.status}.`);

  let document: unknown;
  try {
    document = await response.json();
  } catch {
    throw new Error("OIDC discovery did not return valid JSON.");
  }
  if (typeof document !== "object" || document === null || Array.isArray(document)) {
    throw new Error("OIDC discovery document must be a JSON object.");
  }
  const value = document as Record<string, unknown>;
  if (
    value.issuer !== expectedIssuer ||
    typeof value.jwks_uri !== "string" ||
    typeof value.authorization_endpoint !== "string" ||
    typeof value.token_endpoint !== "string" ||
    !Array.isArray(value.response_types_supported) ||
    !Array.isArray(value.subject_types_supported) ||
    !Array.isArray(value.id_token_signing_alg_values_supported)
  ) {
    throw new Error("OIDC discovery metadata is incomplete or its issuer does not match configuration.");
  }
  for (const [name, candidate] of [
    ["OIDC JWKS URL", value.jwks_uri],
    ["OIDC authorization endpoint", value.authorization_endpoint],
    ["OIDC token endpoint", value.token_endpoint],
  ] as const) {
    assertSecureUrl(new URL(candidate), name);
  }
  return value as unknown as OidcDiscoveryDocument;
}

function validateSecureUrl(value: string, name: string): string {
  const candidate = value.trim();
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error(`${name} must be an absolute URL.`);
  }
  assertSecureUrl(parsed, name);
  if (parsed.username.length > 0 || parsed.password.length > 0 || parsed.search.length > 0 || parsed.hash.length > 0) {
    throw new Error(`${name} must not contain credentials, query, or fragment.`);
  }
  return candidate;
}

function assertSecureUrl(url: URL, name: string): void {
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error(`${name} must use HTTPS except for loopback development.`);
  }
}

function readScopes(scope: unknown, scp: unknown): string[] {
  const values: string[] = [];
  if (typeof scope === "string") values.push(...scope.split(/\s+/u));
  if (typeof scp === "string") values.push(...scp.split(/\s+/u));
  else if (Array.isArray(scp)) values.push(...scp.filter((value): value is string => typeof value === "string"));
  return [...new Set(values.filter((value) => value.length > 0))];
}

function stringClaim(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}
