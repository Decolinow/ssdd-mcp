#!/usr/bin/env node

import { initializeProject, type InitializeProjectInput } from "./application/initialize-project.js";
import { grantExternalIdentity, revokeExternalIdentityRoles } from "./application/external-identities.js";
import { getOrCreateLocalPrincipal, projectRoles, type ProjectRole } from "./application/local-identity.js";
import { startMcpServer } from "./mcp/server.js";
import { startMcpHttpServer } from "./mcp/http-server.js";
import { packageVersion } from "./package-version.js";
import { readWebhookSecretsFromEnvironment } from "./mcp/webhook-receiver.js";
import { readGithubRepositoriesFromEnvironment } from "./application/github-webhooks.js";
import { readGithubIssueTokensFromEnvironment } from "./integrations/github-issues.js";
import { readAzureDevOpsConnectionsFromEnvironment } from "./integrations/azure-devops-work-items.js";
import { startDashboardServer } from "./dashboard/api.js";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { openSqliteDatabase } from "./storage-sqlite/database.js";
import { applyMigrations } from "./storage-sqlite/migrations.js";
import {
  backupWorkspace,
  diagnoseWorkspace,
  exportWorkspace,
  restoreWorkspace,
  writeExport,
} from "./operations/workspace-maintenance.js";

const helpText = `SSDD MCP — desenvolvimento guiado por especificações

Uso:
  ssdd-mcp init --key <KEY> --name <nome> --goal <objetivo> --timezone <IANA> [--workspace <diretório>]
  ssdd-mcp stdio [--workspace <diretório>]
  ssdd-mcp serve [--workspace <diretório>] [--port <porta>] [--oidc-issuer <URL> --resource-url <URL>]
    Webhooks usam SSDD_WEBHOOK_SECRET_<PROVIDER>__<PROJECT_KEY> e POST /webhooks/<provider>/<project-key>.
    GitHub também exige SSDD_GITHUB_REPOSITORY_<PROJECT_KEY>=<owner>/<repository>.
    A importação read-only de issues usa SSDD_GITHUB_ISSUES_TOKEN_<PROJECT_KEY>.
    A importação Azure Boards usa SSDD_AZURE_DEVOPS_ORGANIZATION_<PROJECT_KEY>,
    SSDD_AZURE_DEVOPS_PROJECT_<PROJECT_KEY> e SSDD_AZURE_DEVOPS_TOKEN_<PROJECT_KEY>.
  ssdd-mcp access grant --project <KEY> --issuer <URL> --subject <SUB> --display-name <nome> --type <human|agent|service> --roles <lista> --reason <motivo>
  ssdd-mcp access revoke --project <KEY> --issuer <URL> --subject <SUB> --roles <lista> --reason <motivo>
  ssdd-mcp dashboard [--workspace <diretório>] [--port <porta>]
  ssdd-mcp doctor [--workspace <diretório>]
  ssdd-mcp backup [--workspace <diretório>] [--output <arquivo.sqlite>]
  ssdd-mcp restore --backup <arquivo.sqlite> [--workspace <workspace limpo>]
  ssdd-mcp export [--workspace <diretório>] --format <json|markdown|gherkin> [--output <arquivo>]
  ssdd-mcp --help
  ssdd-mcp --version

Exemplo:
  ssdd-mcp init --key PAY --name Pagamentos --goal "Pagamentos confiáveis" --timezone America/Sao_Paulo
`;

export async function runCli(
  args: readonly string[],
  stdout: Pick<NodeJS.WriteStream, "write"> = process.stdout,
  stderr: Pick<NodeJS.WriteStream, "write"> = process.stderr,
): Promise<number> {
  const [command, ...commandArgs] = args;

  if (command === undefined || command === "--help" || command === "help") {
    stdout.write(helpText);
    return 0;
  }
  if (command === "--version" || command === "-v") {
    stdout.write(`${packageVersion}\n`);
    return 0;
  }
  if (command !== "init") {
    if (command === "access") {
      try {
        const result = executeAccessCommand(commandArgs);
        stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        return 0;
      } catch (error) {
        const message = error instanceof Error ? error.message : "Erro inesperado.";
        stderr.write(`Erro: ${message}\n`);
        return 1;
      }
    }
    if (command === "doctor" || command === "backup" || command === "restore" || command === "export") {
      try {
        if (command === "doctor") {
          const options = parseMaintenanceOptions(commandArgs, ["--workspace"]);
          const report = diagnoseWorkspace(options.get("--workspace") ?? process.cwd());
          stdout.write(`${JSON.stringify(report, null, 2)}\n`);
          return report.status === "error" ? 1 : 0;
        }
        if (command === "backup") {
          const options = parseMaintenanceOptions(commandArgs, ["--workspace", "--output"]);
          const result = await backupWorkspace(options.get("--workspace") ?? process.cwd(), options.get("--output"));
          stdout.write(`${JSON.stringify(result, null, 2)}\n`);
          return 0;
        }
        if (command === "restore") {
          const options = parseMaintenanceOptions(commandArgs, ["--workspace", "--backup"]);
          const backup = options.get("--backup");
          if (backup === undefined) throw new Error("Required option '--backup' is missing.");
          const result = await restoreWorkspace(options.get("--workspace") ?? process.cwd(), backup);
          stdout.write(`${JSON.stringify(result, null, 2)}\n`);
          return 0;
        }
        const options = parseMaintenanceOptions(commandArgs, ["--workspace", "--format", "--output"]);
        const format = options.get("--format");
        if (format !== "json" && format !== "markdown" && format !== "gherkin") {
          throw new Error("Option '--format' must be 'json', 'markdown' or 'gherkin'.");
        }
        const workspace = options.get("--workspace") ?? process.cwd();
        const output = options.get("--output");
        if (output === undefined) {
          stdout.write(exportWorkspace(workspace, format).content);
        } else {
          const result = await writeExport(workspace, format, output);
          stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        }
        return 0;
      } catch (error) {
        const message = error instanceof Error ? error.message : "Erro inesperado.";
        stderr.write(`Erro: ${message}\n`);
        return 1;
      }
    }
    if (command === "dashboard") {
      try {
        const options = parseDashboardOptions(commandArgs);
        startDashboardServer(options.workspace, options.port, (message) => stderr.write(`${message}\n`));
        return 0;
      } catch (error) {
        const message = error instanceof Error ? error.message : "Erro inesperado.";
        stderr.write(`Erro: ${message}\n`);
        return 1;
      }
    }
    if (command === "serve") {
      try {
        const options = parseServeOptions(commandArgs);
        startMcpHttpServer(options.workspace, options.port, (message) => stderr.write(`${message}\n`), options);
        return 0;
      } catch (error) {
        const message = error instanceof Error ? error.message : "Erro inesperado.";
        stderr.write(`Erro: ${message}\n`);
        return 1;
      }
    }
    if (command === "stdio") {
      try {
        const workspace = parseWorkspaceOptions(commandArgs);
        startMcpServer(workspace);
        return 0;
      } catch (error) {
        const message = error instanceof Error ? error.message : "Erro inesperado.";
        stderr.write(`Erro: ${message}\n`);
        return 1;
      }
    }

    stderr.write(`Comando desconhecido: ${command}\n\n${helpText}`);
    return 2;
  }

  try {
    const options = parseInitOptions(commandArgs);
    const result = initializeProject(options);
    stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Erro inesperado.";
    stderr.write(`Erro: ${message}\n`);
    return 1;
  }
}

function parseWorkspaceOptions(args: readonly string[]): string {
  let workspace: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    const value = args[index + 1];
    if (option !== "--workspace") {
      throw new Error(`Unsupported option '${option ?? ""}'.`);
    }
    if (workspace !== undefined) {
      throw new Error("Option '--workspace' was provided more than once.");
    }
    if (value === undefined || value.startsWith("--") || value.trim().length === 0) {
      throw new Error("Option '--workspace' requires a directory path.");
    }
    workspace = value;
    index += 1;
  }
  return workspace ?? process.cwd();
}

function parseDashboardOptions(args: readonly string[]): { readonly workspace: string; readonly port: number } {
  return parseHttpOptions(args, 4318);
}

interface ServeOptions {
  readonly workspace: string;
  readonly port: number;
  readonly issuer?: string;
  readonly resourceUrl?: string;
  readonly allowedOrigins: readonly string[];
  readonly webhookSecrets: ReturnType<typeof readWebhookSecretsFromEnvironment>;
  readonly githubRepositories: ReturnType<typeof readGithubRepositoriesFromEnvironment>;
  readonly githubIssueTokens: ReturnType<typeof readGithubIssueTokensFromEnvironment>;
  readonly azureDevOpsConnections: ReturnType<typeof readAzureDevOpsConnectionsFromEnvironment>;
}

function parseHttpOptions(args: readonly string[], defaultPort: number): { readonly workspace: string; readonly port: number } {
  let workspace = process.cwd();
  let port = defaultPort;
  let workspaceSeen = false;
  let portSeen = false;
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--") || value.trim().length === 0) {
      throw new Error(`Option '${option ?? ""}' requires a value.`);
    }
    if (option === "--workspace") {
      if (workspaceSeen) throw new Error("Option '--workspace' was provided more than once.");
      workspace = value;
      workspaceSeen = true;
    } else if (option === "--port") {
      if (portSeen) throw new Error("Option '--port' was provided more than once.");
      const parsedPort = Number(value);
      if (!Number.isSafeInteger(parsedPort) || parsedPort < 1 || parsedPort > 65_535) {
        throw new Error("Option '--port' must be an integer between 1 and 65535.");
      }
      port = parsedPort;
      portSeen = true;
    } else {
      throw new Error(`Unsupported option '${option ?? ""}'.`);
    }
    index += 1;
  }
  return { workspace, port };
}

function parseServeOptions(args: readonly string[]): ServeOptions {
  let workspace = process.cwd();
  let port = 4319;
  let issuer: string | undefined;
  let resourceUrl: string | undefined;
  let workspaceSeen = false;
  let portSeen = false;
  let issuerSeen = false;
  let resourceSeen = false;
  const allowedOrigins: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--") || value.trim().length === 0) {
      throw new Error(`Option '${option ?? ""}' requires a value.`);
    }
    if (option === "--workspace") {
      if (workspaceSeen) throw new Error("Option '--workspace' was provided more than once.");
      workspace = value;
      workspaceSeen = true;
    } else if (option === "--port") {
      if (portSeen) throw new Error("Option '--port' was provided more than once.");
      const parsedPort = Number(value);
      if (!Number.isSafeInteger(parsedPort) || parsedPort < 1 || parsedPort > 65_535) {
        throw new Error("Option '--port' must be an integer between 1 and 65535.");
      }
      port = parsedPort;
      portSeen = true;
    } else if (option === "--oidc-issuer") {
      if (issuerSeen) throw new Error("Option '--oidc-issuer' was provided more than once.");
      issuer = value.trim();
      issuerSeen = true;
    } else if (option === "--resource-url") {
      if (resourceSeen) throw new Error("Option '--resource-url' was provided more than once.");
      resourceUrl = value.trim();
      resourceSeen = true;
    } else if (option === "--allowed-origin") {
      allowedOrigins.push(value.trim());
    } else {
      throw new Error(`Unsupported option '${option ?? ""}'.`);
    }
    index += 1;
  }
  if ((issuer === undefined) !== (resourceUrl === undefined)) {
    throw new Error("Options '--oidc-issuer' and '--resource-url' must be provided together.");
  }
  return {
    workspace,
    port,
    allowedOrigins,
    ...(issuer === undefined ? {} : { issuer }),
    ...(resourceUrl === undefined ? {} : { resourceUrl }),
    webhookSecrets: readWebhookSecretsFromEnvironment(),
    githubRepositories: readGithubRepositoriesFromEnvironment(),
    githubIssueTokens: readGithubIssueTokensFromEnvironment(),
    azureDevOpsConnections: readAzureDevOpsConnectionsFromEnvironment(),
  };
}

function executeAccessCommand(args: readonly string[]): unknown {
  const [action, ...options] = args;
  if (action !== "grant" && action !== "revoke") {
    throw new Error("Use 'ssdd-mcp access grant' or 'ssdd-mcp access revoke'.");
  }
  const parsed = parseAccessOptions(options, action);
  const databasePath = join(resolve(parsed.workspace), ".ssdd", "ssdd.sqlite");
  const database = openSqliteDatabase(databasePath);
  try {
    applyMigrations(database);
    const project = database.prepare("SELECT project_id FROM projects WHERE project_key = ?").get(parsed.projectKey) as
      | { project_id: string }
      | undefined;
    if (project === undefined) throw new Error(`Project '${parsed.projectKey}' was not found in this workspace.`);
    const principal = getOrCreateLocalPrincipal(database);
    const common = {
      projectId: project.project_id,
      principalId: principal.id,
      requestId: parsed.requestId,
      issuer: parsed.issuer,
      subject: parsed.subject,
      roles: parsed.roles,
      reason: parsed.reason,
    };
    if (action === "grant") {
      if (parsed.displayName === undefined || parsed.principalType === undefined) {
        throw new Error("Grant requires '--display-name' and '--type'.");
      }
      return grantExternalIdentity(database, {
        ...common,
        displayName: parsed.displayName,
        principalType: parsed.principalType,
      });
    }
    return revokeExternalIdentityRoles(database, common);
  } finally {
    database.close();
  }
}

interface AccessOptions {
  readonly workspace: string;
  readonly projectKey: string;
  readonly issuer: string;
  readonly subject: string;
  readonly displayName?: string;
  readonly principalType?: "human" | "agent" | "service";
  readonly roles: readonly ProjectRole[];
  readonly reason: string;
  readonly requestId: string;
}

function parseAccessOptions(args: readonly string[], action: "grant" | "revoke"): AccessOptions {
  const parsed = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    const value = args[index + 1];
    if (option === undefined || !option.startsWith("--")) throw new Error(`Expected an option, received '${option ?? ""}'.`);
    if (value === undefined || value.startsWith("--") || value.trim().length === 0) throw new Error(`Option '${option}' requires a value.`);
    if (parsed.has(option)) throw new Error(`Option '${option}' was provided more than once.`);
    parsed.set(option, value.trim());
    index += 1;
  }
  const supported = new Set(["--workspace", "--project", "--issuer", "--subject", "--roles", "--reason", "--request-id"]);
  if (action === "grant") {
    supported.add("--display-name");
    supported.add("--type");
  }
  for (const option of parsed.keys()) if (!supported.has(option)) throw new Error(`Unsupported option '${option}'.`);
  const required = (name: string): string => {
    const value = parsed.get(name);
    if (value === undefined) throw new Error(`Required option '${name}' is missing.`);
    return value;
  };
  const roles = required("--roles").split(",").map((role) => role.trim());
  if (roles.some((role) => !projectRoles.includes(role as ProjectRole))) {
    throw new Error(`Roles must be selected from: ${projectRoles.join(", ")}.`);
  }
  const principalType = parsed.get("--type");
  if (principalType !== undefined && !["human", "agent", "service"].includes(principalType)) {
    throw new Error("Principal type must be human, agent, or service.");
  }
  if (action === "grant" && parsed.get("--display-name") === undefined) {
    throw new Error("Grant requires '--display-name'.");
  }
  if (action === "grant" && principalType === undefined) throw new Error("Grant requires '--type'.");
  const result: AccessOptions = {
    workspace: parsed.get("--workspace") ?? process.cwd(),
    projectKey: required("--project").toUpperCase(),
    issuer: required("--issuer"),
    subject: required("--subject"),
    roles: roles as ProjectRole[],
    reason: required("--reason"),
    requestId: parsed.get("--request-id") ?? randomUUID(),
  };
  const displayName = parsed.get("--display-name");
  if (displayName !== undefined) Object.assign(result, { displayName });
  if (principalType !== undefined) Object.assign(result, { principalType: principalType as AccessOptions["principalType"] });
  return result;
}

function parseInitOptions(args: readonly string[]): InitializeProjectInput {
  const parsed = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    const value = args[index + 1];
    if (option === undefined || !option.startsWith("--")) {
      throw new Error(`Expected an option, received '${option ?? ""}'.`);
    }
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`Option '${option}' requires a value.`);
    }
    if (parsed.has(option)) {
      throw new Error(`Option '${option}' was provided more than once.`);
    }
    parsed.set(option, value);
    index += 1;
  }

  const supported = new Set(["--workspace", "--key", "--name", "--goal", "--timezone"]);
  for (const option of parsed.keys()) {
    if (!supported.has(option)) {
      throw new Error(`Unsupported option '${option}'.`);
    }
  }

  const required = (option: string): string => {
    const value = parsed.get(option)?.trim();
    if (value === undefined || value.length === 0) {
      throw new Error(`Required option '${option}' is missing.`);
    }
    return value;
  };

  return {
    workspace: parsed.get("--workspace") ?? process.cwd(),
    key: required("--key"),
    name: required("--name"),
    productGoal: required("--goal"),
    timezone: required("--timezone"),
  };
}

const entrypoint = process.argv[1];
if (
  entrypoint !== undefined &&
  import.meta.url === pathToFileURL(resolve(entrypoint)).href
) {
  void runCli(process.argv.slice(2)).then((exitCode) => {
    process.exitCode = exitCode;
  }).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "Erro inesperado.";
    process.stderr.write(`Erro: ${message}\n`);
    process.exitCode = 1;
  });
}

function parseMaintenanceOptions(args: readonly string[], supported: readonly string[]): Map<string, string> {
  const parsed = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    const value = args[index + 1];
    if (option === undefined || !option.startsWith("--")) {
      throw new Error(`Expected an option, received '${option ?? ""}'.`);
    }
    if (value === undefined || value.startsWith("--") || value.trim().length === 0) {
      throw new Error(`Option '${option}' requires a value.`);
    }
    if (parsed.has(option)) throw new Error(`Option '${option}' was provided more than once.`);
    if (!supported.includes(option)) throw new Error(`Unsupported option '${option}'.`);
    parsed.set(option, value.trim());
    index += 1;
  }
  return parsed;
}
