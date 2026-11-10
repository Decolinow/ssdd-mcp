#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  writeFileSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { applyEdits, modify, parse as parseJsonc } from "jsonc-parser";
import { parse as parseToml } from "smol-toml";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGE_JSON = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8"));
const MANIFEST_RELATIVE = ".ssdd/agent-runtime/ssdd-agent-stack.json";
const RUNTIME_RELATIVE = ".ssdd/agent-runtime";
const CODEX_MARKER_START = "# >>> SSDD MCP MANAGED mcp_servers.ssdd_mcp";
const CODEX_MARKER_END = "# <<< SSDD MCP MANAGED mcp_servers.ssdd_mcp";
const IGNORE_ENTRY = "/.ssdd/agent-runtime/";
const JSONC_FORMAT = { insertSpaces: true, tabSize: 2, eol: "\n" };

class InstallError extends Error {
  constructor(message) {
    super(message);
    this.name = "InstallError";
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function isWithin(root, path) {
  const rel = relative(resolve(root), resolve(path));
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function absoluteTargetPath(root, relativePath) {
  if (isAbsolute(relativePath)) throw new InstallError(`Caminho interno absoluto recusado: ${relativePath}`);
  const path = resolve(root, relativePath);
  if (!isWithin(root, path)) throw new InstallError(`Caminho fora do repositório recusado: ${relativePath}`);
  return path;
}

function assertNoSymlink(root, relativePath) {
  const target = absoluteTargetPath(root, relativePath);
  const parts = relative(root, target).split(sep).filter(Boolean);
  let current = root;
  for (const part of parts) {
    current = join(current, part);
    let stat;
    try {
      stat = lstatSync(current);
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") break;
      throw error;
    }
    if (stat.isSymbolicLink()) throw new InstallError(`Caminho gerenciado contém link simbólico: ${relativePath}`);
  }
  return target;
}

function readRegularFile(root, relativePath) {
  const path = assertNoSymlink(root, relativePath);
  if (!existsSync(path)) return undefined;
  if (!lstatSync(path).isFile()) throw new InstallError(`Esperava um arquivo regular em ${relativePath}`);
  return readFileSync(path);
}

function findGitRoot(target) {
  const input = resolve(target);
  if (!existsSync(input) || !lstatSync(input).isDirectory()) throw new InstallError(`O alvo não é um diretório existente: ${input}`);
  const result = spawnSync("git", ["-C", input, "rev-parse", "--show-toplevel"], { encoding: "utf8", timeout: 10_000 });
  if (result.error || result.status !== 0) throw new InstallError(`O alvo precisa estar dentro de um repositório Git: ${result.stderr?.trim() || result.error?.message || "git falhou"}`);
  return realpathSync(result.stdout.trim());
}

function parseJson(text, file, allowJsonc) {
  const errors = [];
  const value = parseJsonc(text, errors, {
    allowTrailingComma: allowJsonc,
    disallowComments: !allowJsonc,
    allowEmptyContent: false,
  });
  if (errors.length > 0) throw new InstallError(`${file} contém JSON${allowJsonc ? "C" : ""} inválido (código ${errors[0].error})`);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new InstallError(`${file} precisa conter um objeto JSON na raiz`);
  return value;
}

function hasPath(object, keys) {
  let current = object;
  for (const key of keys) {
    if (!current || typeof current !== "object" || !Object.hasOwn(current, key)) return false;
    current = current[key];
  }
  return true;
}

function getPath(object, keys) {
  let current = object;
  for (const key of keys) {
    if (!current || typeof current !== "object") return undefined;
    current = current[key];
  }
  return current;
}

function ensureObjectParents(object, keys, file) {
  let current = object;
  for (const key of keys.slice(0, -1)) {
    if (!Object.hasOwn(current, key)) continue;
    if (!current[key] || typeof current[key] !== "object" || Array.isArray(current[key])) {
      throw new InstallError(`${file} tem um valor incompatível em ${keys.slice(0, keys.indexOf(key) + 1).join(".")}`);
    }
    current = current[key];
  }
}

function editJson(text, keys, value, allowJsonc) {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const options = { ...JSONC_FORMAT, eol };
  let updated = text;
  let parsed = parseJson(updated, "configuração", allowJsonc);
  for (let length = 1; length < keys.length; length += 1) {
    const parentPath = keys.slice(0, length);
    const parent = getPath(parsed, parentPath);
    if (parent === undefined) {
      updated = applyEdits(updated, modify(updated, parentPath, {}, options));
      parsed = parseJson(updated, "configuração", allowJsonc);
    } else if (!parent || typeof parent !== "object" || Array.isArray(parent)) {
      throw new InstallError(`Valor incompatível em ${parentPath.join(".")}`);
    }
  }
  updated = applyEdits(updated, modify(updated, keys, value, options));
  parseJson(updated, "configuração", allowJsonc);
  return updated.endsWith("\n") || updated.endsWith("\r\n") ? updated : `${updated}${eol}`;
}

function parseSkillFrontmatter(id, text) {
  const frontmatter = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!frontmatter) throw new InstallError(`A skill ${id} não tem frontmatter YAML válido`);
  const name = frontmatter[1].match(/^name:\s*([a-z0-9-]+)\s*$/m)?.[1];
  const description = frontmatter[1].match(/^description:\s*(.*?)\s*$/m)?.[1];
  if (name !== id || !description) throw new InstallError(`Frontmatter da skill ${id} precisa ter name correspondente e description não vazia`);
  return { id, description };
}

function loadSkills() {
  const root = join(PACKAGE_ROOT, "skills");
  if (!existsSync(root)) throw new InstallError("O pacote não inclui o diretório canônico de skills");
  const skills = [];
  const ids = new Set();
  for (const entry of readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    const id = entry.name;
    if (!/^[a-z0-9-]+$/.test(id) || ids.has(id)) throw new InstallError(`Identificador de skill inválido ou duplicado: ${id}`);
    const text = readFileSync(join(root, id, "SKILL.md"), "utf8");
    skills.push({ ...parseSkillFrontmatter(id, text), text });
    ids.add(id);
  }
  if (skills.length === 0) throw new InstallError("Nenhuma skill canônica foi encontrada");
  return skills;
}

function yamlQuoted(value) {
  return JSON.stringify(value);
}

function agentInstructions(skill, skillDirectory) {
  return `Antes de executar trabalho desta função, leia e siga a skill do projeto em ${skillDirectory}/${skill.id}/SKILL.md.\n\nUse as ferramentas SSDD disponíveis para conferir o contexto, os critérios, as dependências e os gates antes de agir. Preserve os controles humanos descritos na skill. Não invente aprovação, teste, evidência ou estado de workflow.`;
}

function renderClaudeAgent(skill) {
  return [
    "---",
    `name: ${skill.id}`,
    `description: ${yamlQuoted(skill.description)}`,
    "skills:",
    `  - ${skill.id}`,
    "---",
    "",
    agentInstructions(skill, ".claude/skills"),
    "",
  ].join("\n");
}

function renderCodexAgent(skill) {
  const fields = {
    name: skill.id,
    description: skill.description,
    developer_instructions: agentInstructions(skill, ".agents/skills"),
  };
  return `${Object.entries(fields).map(([key, value]) => `${key} = ${JSON.stringify(value)}`).join("\n")}\n`;
}

function renderOpenCodeAgent(skill) {
  return [
    "---",
    `description: ${yamlQuoted(skill.description)}`,
    "mode: subagent",
    "---",
    "",
    agentInstructions(skill, ".opencode/skills"),
    "",
  ].join("\n");
}

function collectGeneratedFiles(skills) {
  const files = new Map();
  for (const skill of skills) {
    const text = skill.text.endsWith("\n") ? skill.text : `${skill.text}\n`;
    files.set(`.agents/skills/${skill.id}/SKILL.md`, text);
    files.set(`.claude/skills/${skill.id}/SKILL.md`, text);
    files.set(`.opencode/skills/${skill.id}/SKILL.md`, text);
    files.set(`.claude/agents/${skill.id}.md`, renderClaudeAgent(skill));
    files.set(`.codex/agents/${skill.id}.toml`, renderCodexAgent(skill));
    files.set(`.opencode/agents/${skill.id}.md`, renderOpenCodeAgent(skill));
  }
  return files;
}

function loadManifest(root) {
  const runtimePath = assertNoSymlink(root, RUNTIME_RELATIVE);
  const manifestPath = assertNoSymlink(root, MANIFEST_RELATIVE);
  if (!existsSync(runtimePath)) return { runtimeExists: false, previous: undefined };
  if (!lstatSync(runtimePath).isDirectory()) throw new InstallError(`${RUNTIME_RELATIVE} existe e não é um diretório`);
  if (!existsSync(manifestPath)) throw new InstallError(`${RUNTIME_RELATIVE} já existe sem manifesto do instalador; não será sobrescrito`);
  if (!lstatSync(manifestPath).isFile()) throw new InstallError(`Manifesto gerenciado inválido em ${MANIFEST_RELATIVE}`);
  let previous;
  try {
    previous = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    throw new InstallError(`Manifesto JSON inválido em ${MANIFEST_RELATIVE}`);
  }
  if (previous?.formatVersion !== 1 || !previous.managedFiles || !previous.managedConfigs) {
    throw new InstallError(`Formato de manifesto não reconhecido em ${MANIFEST_RELATIVE}`);
  }
  return { runtimeExists: true, previous };
}

function compareManagedFile(root, relativePath, content, previous, changes, actions) {
  const current = readRegularFile(root, relativePath);
  const currentHash = current === undefined ? undefined : sha256(current);
  const desired = Buffer.from(content, "utf8");
  const desiredHash = sha256(desired);
  if (current === undefined) {
    actions.push({ path: relativePath, action: "create" });
    changes.set(relativePath, desired);
  } else if (previous?.managedFiles?.[relativePath] !== currentHash) {
    throw new InstallError(`Arquivo já existe ou foi editado fora do instalador: ${relativePath}`);
  } else if (currentHash === desiredHash) {
    actions.push({ path: relativePath, action: "unchanged" });
  } else {
    actions.push({ path: relativePath, action: "update" });
    changes.set(relativePath, desired);
  }
  return desiredHash;
}

function loadJsonConfig(root, path, allowJsonc) {
  const bytes = readRegularFile(root, path);
  const text = bytes === undefined ? "{}\n" : bytes.toString("utf8");
  return { bytes, text, value: parseJson(text, path, allowJsonc) };
}

function compareConfigEntry(config, path, keys, previousRecord) {
  const currentExists = hasPath(config.value, keys);
  if (currentExists) {
    const current = getPath(config.value, keys);
    if (!previousRecord || stableJson(current) !== stableJson(previousRecord.value)) {
      throw new InstallError(`${path} já define ${keys.join(".")} sem gestão comprovada pelo instalador`);
    }
  } else if (previousRecord) {
    throw new InstallError(`${path} perdeu a entrada gerenciada ${keys.join(".")}; revise o arquivo antes de continuar`);
  }
  ensureObjectParents(config.value, keys, path);
}

function parseTomlDocument(text, path) {
  try {
    const parsed = parseToml(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("raiz incompatível");
    return parsed;
  } catch (error) {
    throw new InstallError(`${path} contém TOML inválido: ${error.message}`);
  }
}

function normalizeEol(text) {
  return text.replace(/\r\n/g, "\n");
}

function extractCodexBlock(text) {
  const lines = normalizeEol(text).split("\n");
  const starts = [];
  const ends = [];
  lines.forEach((line, index) => {
    if (line === CODEX_MARKER_START) starts.push(index);
    if (line === CODEX_MARKER_END) ends.push(index);
  });
  if (starts.length === 0 && ends.length === 0) return undefined;
  if (starts.length !== 1 || ends.length !== 1 || starts[0] >= ends[0]) throw new InstallError("Marcadores gerenciados do Codex estão duplicados ou incompletos");
  const block = lines.slice(starts[0], ends[0] + 1).join("\n");
  const remaining = [...lines.slice(0, starts[0]), ...lines.slice(ends[0] + 1)].join("\n");
  return { block, remaining, digest: sha256(block) };
}

function renderCodexMcpBlock() {
  return [
    CODEX_MARKER_START,
    "[mcp_servers.ssdd_mcp]",
    'command = "node"',
    'args = [".ssdd/agent-runtime/node_modules/ssdd-mcp/dist/src/cli.js", "stdio", "--workspace", "."]',
    'cwd = "."',
    CODEX_MARKER_END,
  ].join("\n");
}

function checkGitIgnore(root) {
  const result = spawnSync("git", ["-C", root, "check-ignore", "--quiet", "--no-index", "--", ".ssdd/agent-runtime/node_modules/ssdd-mcp/dist/src/cli.js"], { encoding: "utf8", timeout: 10_000 });
  if (result.error) throw new InstallError(`Não foi possível verificar o .gitignore: ${result.error.message}`);
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  throw new InstallError(`git check-ignore falhou: ${result.stderr?.trim() || `código ${result.status}`}`);
}

function appendIgnoreEntry(text) {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const prefix = text.length === 0 ? "" : text.endsWith("\n") ? "" : eol;
  return `${text}${prefix}# SSDD MCP local agent runtime${eol}${IGNORE_ENTRY}${eol}`;
}

function sourceFingerprint() {
  const candidates = ["package.json", "README.md", "LICENSE", "docs", "skills", "scripts/install-agent-stack.mjs", "src", "dist/src"];
  const digest = createHash("sha256");
  function add(relativePath) {
    const path = join(PACKAGE_ROOT, relativePath);
    if (!existsSync(path)) return;
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new InstallError(`Link simbólico recusado no pacote local: ${relativePath}`);
    if (stat.isDirectory()) {
      for (const entry of readdirSync(path).sort()) add(join(relativePath, entry));
      return;
    }
    digest.update(relativePath.replaceAll("\\", "/"));
    digest.update("\0");
    digest.update(readFileSync(path));
    digest.update("\0");
  }
  for (const path of candidates) add(path);
  return digest.digest("hex");
}

function packageBuildIsStale() {
  const sourceRoot = join(PACKAGE_ROOT, "src");
  const outputRoot = join(PACKAGE_ROOT, "dist", "src");
  if (!existsSync(join(outputRoot, "cli.js"))) return true;
  if (statSync(join(PACKAGE_ROOT, "package.json")).mtimeMs > statSync(join(outputRoot, "package-version.js")).mtimeMs) return true;
  function checkDirectory(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const sourcePath = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (checkDirectory(sourcePath)) return true;
      } else if (entry.name.endsWith(".ts")) {
        const outputPath = join(outputRoot, relative(sourceRoot, sourcePath).replace(/\.ts$/, ".js"));
        if (!existsSync(outputPath) || statSync(sourcePath).mtimeMs > statSync(outputPath).mtimeMs) return true;
      }
    }
    return false;
  }
  if (checkDirectory(sourceRoot)) return true;
  const assetRoot = join(sourceRoot, "dashboard", "public");
  function checkAssets(directory) {
    if (!existsSync(directory)) return false;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const sourcePath = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (checkAssets(sourcePath)) return true;
      } else {
        const outputPath = join(outputRoot, relative(sourceRoot, sourcePath));
        if (!existsSync(outputPath) || statSync(sourcePath).mtimeMs > statSync(outputPath).mtimeMs) return true;
      }
    }
    return false;
  }
  return checkAssets(assetRoot);
}

function buildPlan(targetInput) {
  const root = findGitRoot(targetInput);
  const skills = loadSkills();
  const generatedFiles = collectGeneratedFiles(skills);
  const { runtimeExists, previous } = loadManifest(root);
  const actions = [];
  const conflicts = [];
  const changes = new Map();
  const managedFiles = {};
  const managedConfigs = {};
  const packageFingerprint = sourceFingerprint();

  for (const [path, content] of generatedFiles) {
    try {
      managedFiles[path] = compareManagedFile(root, path, content, previous, changes, actions);
    } catch (error) {
      conflicts.push(error.message);
      actions.push({ path, action: "conflict" });
    }
  }

  const claudeMcp = {
    type: "stdio",
    command: "node",
    args: [
      "${CLAUDE_PROJECT_DIR:-.}/.ssdd/agent-runtime/node_modules/ssdd-mcp/dist/src/cli.js",
      "stdio",
      "--workspace",
      "${CLAUDE_PROJECT_DIR:-.}",
    ],
  };
  const openCodeMcp = {
    type: "local",
    command: ["node", ".ssdd/agent-runtime/node_modules/ssdd-mcp/dist/src/cli.js", "stdio", "--workspace", "."],
    cwd: ".",
  };
  const jsonConfigs = [
    { path: ".mcp.json", keys: ["mcpServers", "ssdd_mcp"], value: claudeMcp, allowJsonc: false, id: "claudeMcp" },
  ];
  let openCodePath = previous?.managedConfigs?.openCodeMcp?.file;
  if (!openCodePath) {
    const hasJson = existsSync(assertNoSymlink(root, "opencode.json"));
    const hasJsonc = existsSync(assertNoSymlink(root, "opencode.jsonc"));
    if (hasJson && hasJsonc) conflicts.push("Existem opencode.json e opencode.jsonc; remova a ambiguidade antes da instalação");
    else openCodePath = hasJsonc ? "opencode.jsonc" : "opencode.json";
  }
  if (openCodePath) jsonConfigs.push({ path: openCodePath, keys: ["mcp", "servers", "ssdd_mcp"], value: openCodeMcp, allowJsonc: openCodePath.endsWith(".jsonc"), id: "openCodeMcp" });

  for (const configSpec of jsonConfigs) {
    try {
      const config = loadJsonConfig(root, configSpec.path, configSpec.allowJsonc);
      compareConfigEntry(config, configSpec.path, configSpec.keys, previous?.managedConfigs?.[configSpec.id]);
      const updated = editJson(config.text, configSpec.keys, configSpec.value, configSpec.allowJsonc);
      const changed = config.bytes === undefined || !config.bytes.equals(Buffer.from(updated, "utf8"));
      actions.push({ path: configSpec.path, action: changed ? (config.bytes === undefined ? "create" : "update") : "unchanged" });
      if (changed) changes.set(configSpec.path, Buffer.from(updated, "utf8"));
      managedConfigs[configSpec.id] = { file: configSpec.path, keys: configSpec.keys, value: configSpec.value };
    } catch (error) {
      conflicts.push(error.message);
      actions.push({ path: configSpec.path, action: "conflict" });
    }
  }

  const codexPath = ".codex/config.toml";
  try {
    const bytes = readRegularFile(root, codexPath);
    const text = bytes?.toString("utf8") ?? "";
    const oldBlock = extractCodexBlock(text);
    const oldRecord = previous?.managedConfigs?.codexMcp;
    let base = text;
    if (oldBlock) {
      if (!oldRecord || oldBlock.digest !== oldRecord.digest) throw new InstallError(`${codexPath} teve seu bloco SSDD editado; restaure-o antes de atualizar`);
      base = oldBlock.remaining;
    } else if (oldRecord) {
      throw new InstallError(`${codexPath} perdeu o bloco gerenciado do instalador`);
    }
    const parsedBase = parseTomlDocument(base, codexPath);
    if (hasPath(parsedBase, ["mcp_servers", "ssdd_mcp"])) throw new InstallError(`${codexPath} já define mcp_servers.ssdd_mcp fora do bloco gerenciado`);
    const eol = text.includes("\r\n") ? "\r\n" : "\n";
    const block = renderCodexMcpBlock().replaceAll("\n", eol);
    const prefix = base.length === 0 ? "" : base.endsWith("\n") ? eol : `${eol}${eol}`;
    const updated = oldBlock
      ? normalizeEol(text).replace(oldBlock.block, renderCodexMcpBlock()).replaceAll("\n", eol)
      : `${base}${prefix}${block}${eol}`;
    parseTomlDocument(updated, codexPath);
    const changed = bytes === undefined || !bytes.equals(Buffer.from(updated, "utf8"));
    actions.push({ path: codexPath, action: changed ? (bytes === undefined ? "create" : "update") : "unchanged" });
    if (changed) changes.set(codexPath, Buffer.from(updated, "utf8"));
    managedConfigs.codexMcp = { file: codexPath, digest: sha256(normalizeEol(renderCodexMcpBlock())) };
  } catch (error) {
    conflicts.push(error.message);
    actions.push({ path: codexPath, action: "conflict" });
  }

  try {
    const ignorePath = ".gitignore";
    const bytes = readRegularFile(root, ignorePath);
    const text = bytes?.toString("utf8") ?? "";
    const ignoredByGit = checkGitIgnore(root);
    const hasEntry = text.split(/\r?\n/).some((line) => line.trim() === IGNORE_ENTRY);
    const wasAddedByInstaller = previous?.managedConfigs?.ignore?.added === true;
    const addEntry = !ignoredByGit;
    const needsRepair = wasAddedByInstaller && !hasEntry;
    const updated = addEntry || needsRepair ? appendIgnoreEntry(text) : text;
    const changed = (bytes === undefined && updated.length > 0) || (bytes !== undefined && updated !== text);
    actions.push({ path: ignorePath, action: changed ? (bytes === undefined ? "create" : "update") : "unchanged" });
    if (changed) changes.set(ignorePath, Buffer.from(updated, "utf8"));
    managedConfigs.ignore = { file: ignorePath, added: wasAddedByInstaller || addEntry || needsRepair };
  } catch (error) {
    conflicts.push(error.message);
    actions.push({ path: ".gitignore", action: "conflict" });
  }

  const runtimeNodeModules = `${RUNTIME_RELATIVE}/node_modules`;
  try {
    const nodeModulesPath = assertNoSymlink(root, runtimeNodeModules);
    if (existsSync(nodeModulesPath) && !lstatSync(nodeModulesPath).isDirectory()) throw new InstallError(`${runtimeNodeModules} não é um diretório`);
    const runtimeReady = runtimeExists && existsSync(nodeModulesPath) && previous?.packageFingerprint === packageFingerprint;
    actions.push({ path: runtimeNodeModules, action: runtimeReady ? "unchanged" : runtimeExists ? "update" : "install" });
  } catch (error) {
    conflicts.push(error.message);
    actions.push({ path: runtimeNodeModules, action: "conflict" });
  }

  const manifest = {
    formatVersion: 1,
    package: PACKAGE_JSON.name,
    packageVersion: PACKAGE_JSON.version,
    packageFingerprint,
    managedFiles,
    managedConfigs,
  };
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  let manifestChanged = !runtimeExists;
  if (!runtimeExists) actions.push({ path: MANIFEST_RELATIVE, action: "create" });
  else {
    try {
      const existing = readRegularFile(root, MANIFEST_RELATIVE);
      const changed = existing === undefined || existing.toString("utf8") !== manifestText;
      manifestChanged = changed;
      actions.push({ path: MANIFEST_RELATIVE, action: changed ? "update" : "unchanged" });
    } catch (error) {
      conflicts.push(error.message);
      actions.push({ path: MANIFEST_RELATIVE, action: "conflict" });
    }
  }
  if (manifestChanged) changes.set(MANIFEST_RELATIVE, Buffer.from(manifestText, "utf8"));

  return { root, skills, generatedFiles, actions, conflicts, changes, manifest, packageFingerprint };
}

function printPlan(mode, plan) {
  const uniqueActions = new Map();
  for (const action of plan.actions) uniqueActions.set(`${action.path}\0${action.action}`, action);
  const output = {
    mode,
    target: plan.root,
    package: `${PACKAGE_JSON.name}@${PACKAGE_JSON.version}`,
    actions: [...uniqueActions.values()],
    conflicts: plan.conflicts,
  };
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

function parseArguments(args) {
  let mode = "dry-run";
  let modeChosen = false;
  let target;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") return { help: true };
    if (["--dry-run", "--apply", "--check"].includes(arg)) {
      if (modeChosen) throw new InstallError("Escolha somente um entre --dry-run, --apply e --check");
      mode = arg.slice(2);
      modeChosen = true;
    } else if (arg === "--target") {
      if (target !== undefined || !args[index + 1]) throw new InstallError("--target precisa receber um único diretório");
      target = args[index + 1];
      index += 1;
    } else {
      throw new InstallError(`Argumento desconhecido: ${arg}`);
    }
  }
  if (!target) throw new InstallError("Informe o repositório com --target <diretório>");
  return { mode, target };
}

function printHelp() {
  process.stdout.write("Uso: npm run agents:install -- --target <repositório> [--dry-run|--apply|--check]\n\n");
  process.stdout.write("--dry-run  Mostra o plano sem executar npm install ou gravar arquivos (padrão).\n");
  process.stdout.write("--apply    Instala o runtime e aplica integrações nos arquivos do projeto.\n");
  process.stdout.write("--check    Verifica instalação e conflitos sem alterar arquivos.\n");
}

function runNpm(args, cwd, timeout = 120_000) {
  const npmExecPath = process.env.npm_execpath;
  if (!npmExecPath || !existsSync(npmExecPath)) {
    throw new InstallError("Execute --apply por `npm run agents:install -- ... --apply` para usar o npm configurado neste projeto");
  }
  const result = spawnSync(process.execPath, [npmExecPath, ...args], {
    cwd,
    encoding: "utf8",
    timeout,
    maxBuffer: 10 * 1024 * 1024,
    env: process.env,
  });
  if (result.error || result.status !== 0) {
    const detail = result.error?.message || result.stderr?.trim() || result.stdout?.trim() || `código ${result.status}`;
    throw new InstallError(`Comando npm falhou: npm ${args.join(" ")}\n${detail}`);
  }
  return result.stdout;
}

function preparePackage() {
  if (packageBuildIsStale()) runNpm(["run", "build"], PACKAGE_ROOT, 120_000);
  const packDirectory = mkdtempSync(join(tmpdir(), "ssdd-agent-pack-"));
  try {
    const output = runNpm(["pack", "--json", "--pack-destination", packDirectory], PACKAGE_ROOT, 120_000);
    const metadata = JSON.parse(output)[0];
    if (!metadata?.filename) throw new InstallError("npm pack não retornou o nome do tarball");
    return { packDirectory, tarball: join(packDirectory, metadata.filename) };
  } catch (error) {
    rmSync(packDirectory, { recursive: true, force: true });
    throw error;
  }
}

function ensureDirectories(root, relativeDirectory, createdDirectories) {
  const destination = absoluteTargetPath(root, relativeDirectory);
  const parts = relative(root, destination).split(sep).filter(Boolean);
  let current = root;
  for (const part of parts) {
    current = join(current, part);
    if (existsSync(current)) {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new InstallError(`Diretório de destino incompatível: ${relative(root, current)}`);
    } else {
      mkdirSync(current);
      createdDirectories.push(current);
    }
  }
  return destination;
}

function installStagedPackage(root, tarball) {
  const createdDirectories = [];
  const ssddPath = ensureDirectories(root, ".ssdd", createdDirectories);
  const stagePath = mkdtempSync(join(ssddPath, ".agent-runtime-stage-"));
  if (!isWithin(ssddPath, stagePath)) throw new InstallError("Diretório de staging saiu de .ssdd");
  try {
    runNpm([
      "install",
      "--prefix", stagePath,
      "--no-save",
      "--package-lock=false",
      "--omit=dev",
      "--no-audit",
      "--no-fund",
      tarball,
    ], root, 180_000);
    const stagedModules = join(stagePath, "node_modules");
    const stagedPackage = join(stagedModules, "ssdd-mcp", "package.json");
    if (!existsSync(stagedPackage)) throw new InstallError("O tarball local foi instalado sem ssdd-mcp/package.json");
    const packageManifest = JSON.parse(readFileSync(stagedPackage, "utf8"));
    if (packageManifest.version !== PACKAGE_JSON.version) throw new InstallError("A versão instalada não corresponde ao manifesto local");
    return { stagePath, stagedModules, packageManifest, createdDirectories };
  } catch (error) {
    rmSync(stagePath, { recursive: true, force: true });
    for (const directory of createdDirectories.reverse()) {
      if (existsSync(directory) && readdirSync(directory).length === 0) rmdirSync(directory);
    }
    throw error;
  }
}

function restoreFileSnapshot(path, snapshot) {
  if (snapshot === undefined) {
    if (existsSync(path)) rmSync(path);
  } else {
    writeFileSync(path, snapshot);
  }
}

function applyChanges(plan, staged) {
  const root = plan.root;
  const id = randomUUID();
  const runtimePath = absoluteTargetPath(root, RUNTIME_RELATIVE);
  const runtimeModulesPath = absoluteTargetPath(root, `${RUNTIME_RELATIVE}/node_modules`);
  const runtimeExistedBefore = existsSync(runtimePath);
  const backupPath = absoluteTargetPath(root, `.ssdd/.agent-runtime-backup-${id}`);
  const backupModulesPath = join(backupPath, "node_modules");
  const snapshots = new Map();
  const createdDirectories = [...staged.createdDirectories];
  let movedExistingModules = false;
  let installedNewModules = false;
  try {
    if (!existsSync(runtimePath)) {
      ensureDirectories(root, RUNTIME_RELATIVE, createdDirectories);
    }
    if (existsSync(runtimeModulesPath)) {
      ensureDirectories(root, relative(root, backupPath), createdDirectories);
      renameSync(runtimeModulesPath, backupModulesPath);
      movedExistingModules = true;
    }
    renameSync(staged.stagedModules, runtimeModulesPath);
    installedNewModules = true;

    for (const [relativePath, content] of plan.changes) {
      const destination = assertNoSymlink(root, relativePath);
      const parentRelative = dirname(relativePath) === "." ? "." : dirname(relativePath);
      if (parentRelative !== ".") ensureDirectories(root, parentRelative, createdDirectories);
      const current = existsSync(destination) ? readFileSync(destination) : undefined;
      snapshots.set(destination, current);
      writeFileSync(destination, content);
    }
    if (movedExistingModules) {
      try { rmSync(backupPath, { recursive: true, force: true }); } catch { /* A stale backup is safer than undoing a successful install. */ }
    }
    try { rmSync(staged.stagePath, { recursive: true, force: true }); } catch { /* Keep the applied runtime if temporary cleanup fails. */ }
  } catch (error) {
    for (const [path, snapshot] of [...snapshots.entries()].reverse()) {
      try { restoreFileSnapshot(path, snapshot); } catch { /* Preserve the original installation error. */ }
    }
    if (installedNewModules && existsSync(runtimeModulesPath)) {
      try { rmSync(runtimeModulesPath, { recursive: true, force: true }); } catch { /* Preserve the original installation error. */ }
    }
    if (movedExistingModules && existsSync(backupModulesPath)) {
      try { renameSync(backupModulesPath, runtimeModulesPath); } catch { /* Preserve the original installation error. */ }
    }
    if (!runtimeExistedBefore && existsSync(runtimePath) && readdirSync(runtimePath).length === 0) {
      try { rmdirSync(runtimePath); } catch { /* Preserve the original installation error. */ }
    }
    if (existsSync(staged.stagePath)) rmSync(staged.stagePath, { recursive: true, force: true });
    if (existsSync(backupPath) && readdirSync(backupPath).length === 0) rmdirSync(backupPath);
    for (const directory of createdDirectories.reverse()) {
      if (!isWithin(root, directory) || !existsSync(directory)) continue;
      try { if (readdirSync(directory).length === 0) rmdirSync(directory); } catch { /* Preserve the original installation error. */ }
    }
    throw error;
  }
}

function printSuccess(plan) {
  const output = {
    mode: "apply",
    target: plan.root,
    package: `${PACKAGE_JSON.name}@${PACKAGE_JSON.version}`,
    changedFiles: plan.changes.size,
    skills: plan.skills.length,
    agents: plan.skills.length,
    clients: ["Claude Code", "Codex", "OpenCode"],
  };
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

async function main() {
  let options;
  try {
    options = parseArguments(process.argv.slice(2));
    if (options.help) {
      printHelp();
      return;
    }
    let plan = buildPlan(options.target);
    if (options.mode === "check" || options.mode === "dry-run") {
      printPlan(options.mode, plan);
      if (plan.conflicts.length > 0) process.exitCode = 1;
      else if (options.mode === "check" && plan.actions.some((action) => !["unchanged"].includes(action.action))) process.exitCode = 1;
      return;
    }
    if (plan.conflicts.length > 0) {
      printPlan(options.mode, plan);
      process.exitCode = 1;
      return;
    }
    if (plan.actions.every((action) => action.action === "unchanged")) {
      printSuccess(plan);
      return;
    }

    const packageArtifacts = preparePackage();
    let staged;
    try {
      // Building changes dist/src; recompute hashes and conflicts against the exact package to install.
      plan = buildPlan(options.target);
      if (plan.conflicts.length > 0) {
        printPlan(options.mode, plan);
        process.exitCode = 1;
        return;
      }
      staged = installStagedPackage(plan.root, packageArtifacts.tarball);
      applyChanges(plan, staged);
      printSuccess(plan);
    } finally {
      rmSync(packageArtifacts.packDirectory, { recursive: true, force: true });
      if (staged && existsSync(staged.stagePath)) rmSync(staged.stagePath, { recursive: true, force: true });
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

const currentScript = process.argv[1] ? resolve(process.argv[1]) : "";
if (currentScript === fileURLToPath(import.meta.url)) await main();
