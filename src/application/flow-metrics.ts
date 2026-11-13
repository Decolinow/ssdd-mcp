import type { SqliteDatabase } from "../storage-sqlite/database.js";
import { ApplicationError } from "./errors.js";
import { assertProjectAuthorization } from "./local-identity.js";

/**
 * Flow analytics (SSDD-930): lead/cycle/wait time, WIP age, dependency wait and critical path for tasks. Everything is
 * derived from immutable state transitions, session-independent timestamps and active `depends_on` links, at an explicit
 * `asOf` cut. Items still open are reported as a censored sample (age so far), never mixed into completed percentiles.
 * Results are aggregate: there is intentionally no per-person breakdown or ranking.
 */
export const minimumFlowSample = 5;
export type FlowState = "draft" | "ready" | "in_progress" | "in_review" | "in_validation";

export interface Distribution { readonly sample: number; readonly medianHours: number; readonly p85Hours: number }

export interface FlowMetrics {
  readonly projectId: string;
  readonly asOf: string;
  readonly period: { readonly from: string; readonly to: string };
  readonly minimumSample: number;
  readonly completed: {
    readonly tasks: number;
    /** Hours from creation to Done. */
    readonly leadTime: Distribution | null;
    /** Hours from first `in_progress` to Done. */
    readonly cycleTime: Distribution | null;
    /** Queue states: time in Ready before work started plus time in review/validation (waiting for someone else). */
    readonly waitTime: Distribution | null;
    /** Time in `in_progress` (touch state, wall clock including pauses). */
    readonly workTime: Distribution | null;
    /** Time between Ready and start that overlapped an unfinished prerequisite (only the part before the last prerequisite finished). */
    readonly dependencyWait: Distribution | null;
  };
  readonly openWork: {
    readonly byState: readonly { readonly state: FlowState; readonly count: number; readonly medianAgeHours: number | null; readonly oldestAgeHours: number | null }[];
    readonly censored: true;
    readonly oldest: readonly { readonly key: string; readonly state: FlowState; readonly ageHours: number }[];
  };
  readonly criticalPath: {
    readonly status: "computed" | "not_a_dag" | "missing_estimates" | "no_open_dependencies";
    readonly totalHours: number | null;
    readonly path: readonly { readonly key: string; readonly estimateHours: number }[];
    readonly detail: string | null;
  };
  readonly limitations: readonly string[];
}

interface TransitionRow { item_id: string; item_key: string; to_state: string; transitioned_at: string }

export function getFlowMetrics(database: SqliteDatabase, input: {
  readonly projectId: string; readonly principalId: string; readonly from?: string; readonly to?: string; readonly now?: Date;
}): FlowMetrics {
  assertProjectAuthorization(database, input.projectId, input.principalId);
  const now = input.now ?? new Date();
  const to = input.to ?? now.toISOString();
  const from = input.from ?? new Date(Date.parse(to) - 30 * 86_400_000).toISOString();
  if (Number.isNaN(Date.parse(from)) || Number.isNaN(Date.parse(to)) || Date.parse(from) >= Date.parse(to)) {
    throw new ApplicationError("VALIDATION_FAILED", "from and to must be ISO timestamps with from before to.");
  }
  const asOfMs = Math.min(now.getTime(), Date.parse(to));
  const tasks = database.prepare(
    `SELECT item_id, item_key, state, created_at FROM work_items WHERE project_id = ? AND type = 'task' AND state <> 'cancelled'`,
  ).all(input.projectId) as Array<{ item_id: string; item_key: string; state: string; created_at: string }>;
  const transitions = database.prepare(
    `SELECT t.item_id, wi.item_key, t.to_state, t.transitioned_at FROM work_item_state_transitions t
     INNER JOIN work_items wi ON wi.project_id = t.project_id AND wi.item_id = t.item_id
     WHERE t.project_id = ? AND wi.type = 'task' AND t.transitioned_at <= ? ORDER BY t.item_id, t.item_version`,
  ).all(input.projectId, new Date(asOfMs).toISOString()) as TransitionRow[];
  const byItem = new Map<string, TransitionRow[]>();
  for (const row of transitions) (byItem.get(row.item_id) ?? byItem.set(row.item_id, []).get(row.item_id)!).push(row);
  const doneAt = new Map<string, number>();
  for (const [itemId, rows] of byItem) {
    const done = [...rows].reverse().find((row) => row.to_state === "done");
    if (done !== undefined && tasks.some((task) => task.item_id === itemId && task.state === "done")) doneAt.set(itemId, Date.parse(done.transitioned_at));
  }
  const prerequisites = new Map<string, string[]>();
  const links = database.prepare(
    `SELECT source_id, target_id FROM trace_links WHERE project_id = ? AND link_type = 'depends_on' AND removed_at IS NULL`,
  ).all(input.projectId) as Array<{ source_id: string; target_id: string }>;
  for (const link of links) (prerequisites.get(link.source_id) ?? prerequisites.set(link.source_id, []).get(link.source_id)!).push(link.target_id);

  const lead: number[] = [], cycle: number[] = [], wait: number[] = [], work: number[] = [], dependency: number[] = [];
  let completedTasks = 0;
  for (const task of tasks) {
    const finished = doneAt.get(task.item_id);
    if (finished === undefined || finished < Date.parse(from) || finished >= Date.parse(to)) continue;
    completedTasks += 1;
    const rows = byItem.get(task.item_id) ?? [];
    const hours = (a: number, b: number) => Math.max(0, (b - a) / 3_600_000);
    lead.push(hours(Date.parse(task.created_at), finished));
    const started = rows.find((row) => row.to_state === "in_progress");
    if (started === undefined) continue;
    const startedAt = Date.parse(started.transitioned_at);
    cycle.push(hours(startedAt, finished));
    let waiting = 0, working = 0;
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index]!;
      const end = index + 1 < rows.length ? Date.parse(rows[index + 1]!.transitioned_at) : finished;
      if (end <= Date.parse(row.transitioned_at)) continue;
      const span = hours(Date.parse(row.transitioned_at), end);
      if (row.to_state === "in_progress") working += span;
      else if (row.to_state === "ready" || row.to_state === "in_review" || row.to_state === "in_validation") waiting += span;
    }
    wait.push(waiting);
    work.push(working);
    const readyAt = rows.filter((row) => row.to_state === "ready" && Date.parse(row.transitioned_at) <= startedAt).map((row) => Date.parse(row.transitioned_at)).at(-1);
    const lastPrerequisiteDone = Math.max(0, ...(prerequisites.get(task.item_id) ?? []).map((id) => doneAt.get(id) ?? 0));
    if (readyAt !== undefined && lastPrerequisiteDone > readyAt) dependency.push(hours(readyAt, Math.min(startedAt, lastPrerequisiteDone)));
  }

  const open = new Map<FlowState, { key: string; age: number }[]>();
  for (const task of tasks) {
    if (task.state === "done") continue;
    const rows = byItem.get(task.item_id) ?? [];
    const since = rows.at(-1)?.transitioned_at ?? task.created_at;
    const age = Math.max(0, (asOfMs - Date.parse(since)) / 3_600_000);
    const list = open.get(task.state as FlowState) ?? [];
    list.push({ key: task.item_key, age });
    open.set(task.state as FlowState, list);
  }
  const states: FlowState[] = ["draft", "ready", "in_progress", "in_review", "in_validation"];
  const byState = states.map((state) => {
    const ages = (open.get(state) ?? []).map((entry) => entry.age).sort((a, b) => a - b);
    return { state, count: ages.length, medianAgeHours: ages.length === 0 ? null : round(percentile(ages, 0.5)), oldestAgeHours: ages.length === 0 ? null : round(ages.at(-1)!) };
  });
  const oldest = states.filter((state) => state !== "draft").flatMap((state) => (open.get(state) ?? []).map((entry) => ({ key: entry.key, state, ageHours: round(entry.age) })))
    .sort((a, b) => b.ageHours - a.ageHours || a.key.localeCompare(b.key)).slice(0, 5);

  return {
    projectId: input.projectId, asOf: new Date(asOfMs).toISOString(), period: { from, to }, minimumSample: minimumFlowSample,
    completed: {
      tasks: completedTasks, leadTime: distribution(lead), cycleTime: distribution(cycle), waitTime: distribution(wait),
      workTime: distribution(work), dependencyWait: distribution(dependency),
    },
    openWork: { byState, censored: true, oldest },
    criticalPath: criticalPath(database, input.projectId, tasks, prerequisites),
    limitations: [
      "Distribuições exigem amostra mínima; abaixo dela o campo é null.",
      "Itens abertos são amostra censurada (idade até asOf) e nunca entram nos percentis dos concluídos.",
      "Espera por dependência considera só o trecho entre Ready e o fim da última pré-requisito; não há evento explícito de bloqueio.",
      "Caminho crítico exige DAG de depends_on entre tarefas abertas e estimativa em horas em todos os nós; pontos e horas não são misturados.",
      "Métricas são agregadas; não existe ranking individual.",
    ],
  };
}

function criticalPath(database: SqliteDatabase, projectId: string, tasks: Array<{ item_id: string; item_key: string; state: string }>, prerequisites: Map<string, string[]>): FlowMetrics["criticalPath"] {
  const openTasks = new Map(tasks.filter((task) => task.state !== "done").map((task) => [task.item_id, task]));
  const edges = new Map<string, string[]>();
  for (const [source, targets] of prerequisites) {
    if (!openTasks.has(source)) continue;
    const open = targets.filter((target) => openTasks.has(target));
    if (open.length > 0) edges.set(source, open);
  }
  if (edges.size === 0) return { status: "no_open_dependencies", totalHours: null, path: [], detail: "Nenhuma dependência aberta entre tarefas." };
  const nodes = new Set<string>([...edges.keys(), ...[...edges.values()].flat()]);
  const estimates = new Map((database.prepare(
    `SELECT item_id, value FROM work_item_estimates WHERE project_id = ? AND unit = 'hours'`,
  ).all(projectId) as Array<{ item_id: string; value: number }>).map((row) => [row.item_id, row.value]));
  const missing = [...nodes].filter((id) => !estimates.has(id)).map((id) => openTasks.get(id)!.item_key).sort();
  if (missing.length > 0) return { status: "missing_estimates", totalHours: null, path: [], detail: `Sem estimativa em horas: ${missing.slice(0, 10).join(", ")}${missing.length > 10 ? ` e mais ${missing.length - 10}` : ""}.` };
  const memo = new Map<string, { total: number; next: string | null }>();
  const visiting = new Set<string>();
  const longest = (id: string): { total: number; next: string | null } | "cycle" => {
    const known = memo.get(id);
    if (known !== undefined) return known;
    if (visiting.has(id)) return "cycle";
    visiting.add(id);
    let best = { total: estimates.get(id)!, next: null as string | null };
    for (const target of edges.get(id) ?? []) {
      const sub = longest(target);
      if (sub === "cycle") return "cycle";
      if (estimates.get(id)! + sub.total > best.total) best = { total: estimates.get(id)! + sub.total, next: target };
    }
    visiting.delete(id);
    memo.set(id, best);
    return best;
  };
  let head: string | null = null, headTotal = -1;
  for (const id of [...nodes].sort()) {
    const result = longest(id);
    if (result === "cycle") return { status: "not_a_dag", totalHours: null, path: [], detail: "Há ciclo em depends_on entre tarefas abertas." };
    if (result.total > headTotal) { head = id; headTotal = result.total; }
  }
  const path: { key: string; estimateHours: number }[] = [];
  for (let id: string | null = head; id !== null; id = memo.get(id)!.next) path.push({ key: openTasks.get(id)!.item_key, estimateHours: estimates.get(id)! });
  return { status: "computed", totalHours: headTotal, path, detail: "Caminho do item que depende de mais trabalho aberto até o último pré-requisito (do dependente para o pré-requisito)." };
}

function distribution(values: number[]): Distribution | null {
  if (values.length < minimumFlowSample) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return { sample: sorted.length, medianHours: round(percentile(sorted, 0.5)), p85Hours: round(percentile(sorted, 0.85)) };
}

function percentile(sorted: number[], fraction: number): number {
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)]!;
}

function round(value: number): number { return Math.round(value * 100) / 100; }
