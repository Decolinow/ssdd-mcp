import { z } from "zod";

/**
 * Tools de tarefa (`task_*`) usam `taskIdOrKey`; as demais tools de item usam `itemIdOrKey`.
 * Agentes erram o nome com frequência, então as tools de tarefa também aceitam `itemIdOrKey`.
 * Exatamente um dos dois deve ser informado. Ferramentas que já declaram `itemIdOrKey` não mudam.
 */
export function withItemParameterAlias(config: unknown): { readonly config: unknown; readonly aliased: boolean } {
  if (typeof config !== "object" || config === null) return { config, aliased: false };
  const schema = (config as { inputSchema?: unknown }).inputSchema;
  if (!(schema instanceof z.ZodObject)) return { config, aliased: false };
  const shape = schema.shape as Record<string, z.ZodType>;
  const taskKey = shape.taskIdOrKey;
  if (taskKey === undefined || shape.itemIdOrKey !== undefined) return { config, aliased: false };
  const widened = z.object({ ...shape, taskIdOrKey: taskKey.optional(), itemIdOrKey: taskKey.optional() })
    .refine((value) => (value.taskIdOrKey === undefined) !== (value.itemIdOrKey === undefined), {
      message: "Informe exatamente um entre taskIdOrKey e itemIdOrKey (são sinônimos).",
    });
  return { config: { ...config, inputSchema: widened }, aliased: true };
}

/** Copia `itemIdOrKey` para `taskIdOrKey` antes de o handler original ler os argumentos. */
export function normalizeItemParameterAlias(args: unknown): unknown {
  if (typeof args !== "object" || args === null) return args;
  const record = args as Record<string, unknown>;
  if (record.taskIdOrKey !== undefined || record.itemIdOrKey === undefined) return args;
  const { itemIdOrKey, ...rest } = record;
  return { ...rest, taskIdOrKey: itemIdOrKey };
}
