import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { SkillsClient } from "@modelcontextprotocol/client/ext/skills";
import { parse as parseJsonc } from "jsonc-parser";
import { parse as parseToml } from "smol-toml";
import { it } from "node:test";

const repositoryRoot = resolve(process.cwd());
const installerPath = join(repositoryRoot, "scripts", "install-agent-stack.mjs");

it("dry-run and check do not create files in the target repository", () => {
  const target = createGitRepository();
  try {
    const dryRun = runInstaller(target);
    assert.equal(dryRun.status, 0, `${dryRun.stdout}\n${dryRun.stderr}`);
    const plan = JSON.parse(dryRun.stdout) as InstallPlan;
    assert.equal(plan.mode, "dry-run");
    assert.equal(plan.target, target);
    assert.equal(plan.conflicts.length, 0);
    assert.equal(plan.actions.filter((action) => action.path.startsWith(".agents/skills/") && action.action === "create").length, 5);
    assert.equal(plan.actions.filter((action) => action.path.startsWith(".opencode/skills/") && action.action === "create").length, 5);
    assert.ok(plan.actions.some((action) => action.path === ".ssdd/agent-runtime/node_modules" && action.action === "install"));
    assert.equal(existsSync(join(target, ".ssdd")), false);
    assert.equal(existsSync(join(target, ".mcp.json")), false);

    const check = runInstaller(target, ["--check"]);
    assert.equal(check.status, 1);
    assert.equal(JSON.parse(check.stdout).mode, "check");
    assert.equal(existsSync(join(target, ".ssdd")), false);
    assert.equal(existsSync(join(target, ".claude")), false);
  } finally {
    removeFixture(target);
  }
});

it("reports an unmanaged client name collision without changing its configuration", () => {
  const target = createGitRepository();
  try {
    const mcpPath = join(target, ".mcp.json");
    const original = '{\n  "mcpServers": {\n    "ssdd_mcp": { "command": "my-custom-server" }\n  }\n}\n';
    writeFileSync(mcpPath, original, "utf8");

    const result = runInstaller(target);
    assert.equal(result.status, 1);
    const plan = JSON.parse(result.stdout) as InstallPlan;
    assert.match(plan.conflicts.join("\n"), /mcpServers\.ssdd_mcp/);
    assert.equal(readFileSync(mcpPath, "utf8"), original);
    assert.equal(existsSync(join(target, ".claude")), false);
    assert.equal(existsSync(join(target, ".ssdd")), false);
  } finally {
    removeFixture(target);
  }
});

it("installs the local MCP runtime and native Claude, Codex, and OpenCode files", { timeout: 300_000 }, async (context) => {
  const target = createGitRepository();
  const client = new Client({ name: "ssdd-installer-smoke", version: "1.0.0" });
  context.after(async () => {
    await client.close();
    removeFixture(target);
  });

  writeFileSync(join(target, ".gitignore"), "# Preserve this project ignore note.\n", "utf8");
  const mcpJson = '{\n  "mcpServers": {\n    "existing": { "command": "node", "args": ["existing-server.mjs"] }\n  }\n}\n';
  writeFileSync(join(target, ".mcp.json"), mcpJson, "utf8");
  const codexToml = 'model = "gpt-5"\n\n[mcp_servers.other]\ncommand = "node"\nargs = ["other-server.mjs"]\n';
  mkdirSync(join(target, ".codex"), { recursive: true });
  writeFileSync(join(target, ".codex", "config.toml"), codexToml, "utf8");
  const openCodeJsonc = [
    "{",
    "  // Keep this user-owned comment and server.",
    '  "model": "provider/model",',
    '  "mcp": { "servers": { "other": { "type": "local", "command": ["node", "other.mjs"], }, }, },',
    "}",
    "",
  ].join("\n");
  writeFileSync(join(target, "opencode.jsonc"), openCodeJsonc, "utf8");

  const applied = runInstaller(target, ["--apply"], 300_000);
  assert.equal(applied.status, 0, `${applied.stdout}\n${applied.stderr}`);
  const summary = JSON.parse(applied.stdout) as { mode: string; skills: number; agents: number; clients: string[] };
  assert.equal(summary.mode, "apply");
  assert.equal(summary.skills, 5);
  assert.equal(summary.agents, 5);
  assert.deepEqual(summary.clients, ["Claude Code", "Codex", "OpenCode"]);

  const claudeConfig = JSON.parse(readFileSync(join(target, ".mcp.json"), "utf8")) as {
    mcpServers: Record<string, { command: string; args: string[] }>;
  };
  assert.ok(claudeConfig.mcpServers.existing);
  assert.equal(claudeConfig.mcpServers.ssdd_mcp?.command, "node");
  assert.match(claudeConfig.mcpServers.ssdd_mcp?.args[0] ?? "", /CLAUDE_PROJECT_DIR/);

  const codexConfig = parseToml(readFileSync(join(target, ".codex", "config.toml"), "utf8")) as {
    model: string;
    mcp_servers: Record<string, { command: string; args: string[]; cwd: string }>;
  };
  assert.equal(codexConfig.model, "gpt-5");
  assert.ok(codexConfig.mcp_servers.other);
  assert.equal(codexConfig.mcp_servers.ssdd_mcp?.cwd, ".");

  const openCodeText = readFileSync(join(target, "opencode.jsonc"), "utf8");
  assert.match(openCodeText, /Keep this user-owned comment and server/);
  const openCodeConfig = parseJsonc(openCodeText) as {
    model: string;
    mcp: { servers: Record<string, { type: string; command: string[]; cwd?: string }> };
  };
  assert.equal(openCodeConfig.model, "provider/model");
  assert.ok(openCodeConfig.mcp.servers.other);
  assert.equal(openCodeConfig.mcp.servers.ssdd_mcp?.type, "local");

  const skillIds = ["ssdd-developer", "ssdd-product-owner", "ssdd-quality-assurance", "ssdd-release-manager", "ssdd-technical-lead"];
  for (const id of skillIds) {
    const installedSkill = readFileSync(join(target, ".agents", "skills", id, "SKILL.md"), "utf8");
    assert.equal(installedSkill, readFileSync(join(repositoryRoot, "skills", id, "SKILL.md"), "utf8"));
    assert.match(readFileSync(join(target, ".claude", "agents", `${id}.md`), "utf8"), new RegExp(`name: ${id}`));
    const codexAgent = parseToml(readFileSync(join(target, ".codex", "agents", `${id}.toml`), "utf8")) as {
      name: string;
      description: string;
      developer_instructions: string;
    };
    assert.equal(codexAgent.name, id);
    assert.ok(codexAgent.description);
    assert.match(codexAgent.developer_instructions, new RegExp(`.agents/skills/${id}/SKILL.md`));
    const openCodeAgent = readFileSync(join(target, ".opencode", "agents", `${id}.md`), "utf8");
    assert.match(openCodeAgent, /mode: subagent/);
    assert.match(openCodeAgent, new RegExp(`.opencode/skills/${id}/SKILL.md`));
    assert.equal(readFileSync(join(target, ".opencode", "skills", id, "SKILL.md"), "utf8"), installedSkill);
  }
  assert.equal(readdirSync(join(target, ".agents", "skills")).length, 5);
  assert.equal(readdirSync(join(target, ".opencode", "skills")).length, 5);
  const gitignore = readFileSync(join(target, ".gitignore"), "utf8");
  assert.ok(gitignore.includes("# Preserve this project ignore note."));
  assert.ok(gitignore.includes("/.ssdd/agent-runtime/"));
  assert.ok(existsSync(join(target, ".ssdd", "agent-runtime", "node_modules", "ssdd-mcp", "dist", "src", "cli.js")));
  assert.ok(existsSync(join(target, ".ssdd", "agent-runtime", "node_modules", "ssdd-mcp", "scripts", "install-agent-stack.mjs")));
  assert.ok(existsSync(join(target, ".ssdd", "agent-runtime", "node_modules", "ssdd-mcp", "docs", "agent-installer.md")));

  const cliPath = join(target, ".ssdd", "agent-runtime", "node_modules", "ssdd-mcp", "dist", "src", "cli.js");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cliPath, "stdio", "--workspace", target],
  });
  const initialized = spawnSync(process.execPath, [
    cliPath,
    "init",
    "--workspace", target,
    "--key", "TEST",
    "--name", "Installer Smoke Test",
    "--goal", "Validate an installed local MCP runtime",
    "--timezone", "America/Sao_Paulo",
  ], { cwd: target, encoding: "utf8", timeout: 30_000 });
  assert.equal(initialized.status, 0, `${initialized.stdout}\n${initialized.stderr}`);
  await client.connect(transport);
  const tools = await client.listTools();
  assert.ok(tools.tools.some((tool) => tool.name === "project_list"));
  const skillsClient = new SkillsClient(client);
  assert.equal(skillsClient.supported, true);
  const skillListing = await skillsClient.list();
  assert.deepEqual(skillListing.skills.map((skill) => skill.frontmatter.name).sort(), skillIds.slice().sort());
  const projects = await client.callTool({ name: "project_list", arguments: {} });
  assert.notEqual(projects.isError, true);
  assert.ok(projects.structuredContent);
  assert.equal((projects.structuredContent as { projects: Array<{ key: string }> }).projects[0]?.key, "TEST");

  const check = runInstaller(target, ["--check"]);
  assert.equal(check.status, 0, `${check.stdout}\n${check.stderr}`);
  const checkedPlan = JSON.parse(check.stdout) as InstallPlan;
  assert.equal(checkedPlan.actions.every((action) => action.action === "unchanged"), true);
  const repeatedApply = runInstaller(target, ["--apply"], 30_000);
  assert.equal(repeatedApply.status, 0, `${repeatedApply.stdout}\n${repeatedApply.stderr}`);
  assert.equal(JSON.parse(repeatedApply.stdout).changedFiles, 0);

  const managedSkillPath = join(target, ".agents", "skills", "ssdd-developer", "SKILL.md");
  const locallyEditedSkill = `${readFileSync(managedSkillPath, "utf8")}\nLocal edit\n`;
  writeFileSync(managedSkillPath, locallyEditedSkill, "utf8");
  const editedPlan = runInstaller(target);
  assert.equal(editedPlan.status, 1);
  assert.match(JSON.parse(editedPlan.stdout).conflicts.join("\n"), /Arquivo já existe ou foi editado/);
  assert.equal(readFileSync(managedSkillPath, "utf8"), locallyEditedSkill);
});

it("leaves the target unchanged when package preparation cannot start", () => {
  const target = createGitRepository();
  const fakeNpm = join(target, "fail-npm.mjs");
  try {
    writeFileSync(fakeNpm, 'process.stderr.write("forced npm failure\\n"); process.exitCode = 1;\n', "utf8");
    const result = runInstaller(target, ["--apply"], 15_000, { npm_execpath: fakeNpm });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Comando npm falhou/);
    const remainingSsdd = existsSync(join(target, ".ssdd")) ? readdirSync(join(target, ".ssdd")) : [];
    assert.equal(existsSync(join(target, ".ssdd")), false, `Unexpected rollback residue: ${remainingSsdd.join(", ")}`);
    assert.equal(existsSync(join(target, ".mcp.json")), false);
    assert.equal(existsSync(join(target, ".agents")), false);
  } finally {
    removeFixture(target);
  }
});

it("restores the staged runtime when a target write fails after the package swap", () => {
  const target = createGitRepository();
  const fakeNpm = join(target, "fake-npm.mjs");
  const fakeNpmSource = [
    'import { mkdirSync, writeFileSync } from "node:fs";',
    'import { join } from "node:path";',
    'const [command, ...args] = process.argv.slice(2);',
    'if (command === "run") process.exit(0);',
    'if (command === "pack") {',
    '  const destination = args[args.indexOf("--pack-destination") + 1];',
    '  const filename = "ssdd-mcp-0.2.0.tgz";',
    '  writeFileSync(join(destination, filename), "fixture package");',
    '  process.stdout.write(JSON.stringify([{ filename }]));',
    '  process.exit(0);',
    '}',
    'if (command === "install") {',
    '  const prefix = args[args.indexOf("--prefix") + 1];',
    '  const installedPackage = join(prefix, "node_modules", "ssdd-mcp");',
    '  mkdirSync(installedPackage, { recursive: true });',
    '  writeFileSync(join(installedPackage, "package.json"), JSON.stringify({ version: "0.2.0" }));',
    '  mkdirSync(join(process.env.SSDD_INSTALLER_ROLLBACK_TARGET, ".agents", "skills", "ssdd-developer", "SKILL.md"), { recursive: true });',
    '  process.exit(0);',
    '}',
    'process.exit(1);',
    "",
  ].join("\n");
  try {
    writeFileSync(fakeNpm, fakeNpmSource, "utf8");
    const result = runInstaller(target, ["--apply"], 30_000, {
      npm_execpath: fakeNpm,
      SSDD_INSTALLER_ROLLBACK_TARGET: target,
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /EISDIR|illegal operation|access denied/i);
    const remainingSsdd = existsSync(join(target, ".ssdd")) ? readdirSync(join(target, ".ssdd")) : [];
    const remainingRuntime = existsSync(join(target, ".ssdd", "agent-runtime"))
      ? readdirSync(join(target, ".ssdd", "agent-runtime"))
      : [];
    assert.equal(existsSync(join(target, ".ssdd")), false,
      `Unexpected rollback residue: ${remainingSsdd.join(", ")}; runtime: ${remainingRuntime.join(", ")}`);
    assert.equal(existsSync(join(target, ".mcp.json")), false);
    assert.ok(existsSync(join(target, ".agents", "skills", "ssdd-developer", "SKILL.md")));
  } finally {
    removeFixture(target);
  }
});

interface InstallAction {
  readonly path: string;
  readonly action: string;
}

interface InstallPlan {
  readonly mode: string;
  readonly target: string;
  readonly actions: InstallAction[];
  readonly conflicts: string[];
}

function createGitRepository(): string {
  const target = mkdtempSync(join(tmpdir(), "ssdd-agent-installer-"));
  const initialized = spawnSync("git", ["init", "--quiet", target], { encoding: "utf8", timeout: 10_000 });
  assert.equal(initialized.status, 0, `${initialized.stdout}\n${initialized.stderr}`);
  return target;
}

function runInstaller(
  target: string,
  args: string[] = [],
  timeout = 30_000,
  env: NodeJS.ProcessEnv = {},
) {
  return spawnSync(process.execPath, [installerPath, "--target", target, ...args], {
    cwd: repositoryRoot,
    encoding: "utf8",
    timeout,
    maxBuffer: 10 * 1024 * 1024,
    env: { ...process.env, ...env },
  });
}

function removeFixture(target: string): void {
  assert.equal(resolve(target).startsWith(resolve(tmpdir())), true, "Refusing to remove a fixture outside the temporary directory");
  rmSync(target, { recursive: true, force: true });
}
