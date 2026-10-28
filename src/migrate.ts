import { isDate, TablesError, type Field, type FieldType } from "./model.js";
import { checkValue } from "./model.js";
import type { Json } from "./store.js";

export interface Failure {
  rowId: string;
  value: Json;
  reason: string;
}

/** What a schema change did, or would do. `applied` is false for a dry run and for an abort. */
export interface MigrationReport {
  field: string;
  from: FieldType;
  to: FieldType;
  total: number;
  empty: number;
  converted: number;
  failures: Failure[];
  applied: boolean;
}

export class MigrationError extends TablesError {
  constructor(readonly report: MigrationReport) {
    super(
      "MIGRATION_ABORTED",
      `${report.failures.length} of ${report.total} rows block the change to "${report.field}" and nothing changed. First: ${report.failures[0]?.reason}`,
    );
  }
}

const BOOLEAN_WORDS: Record<string, boolean> = { true: true, yes: true, "1": true, false: false, no: false, "0": false };

/** Turn a stored value into the value of the target field, or say why not. */
export function coerce(value: Json, from: FieldType, to: Field): { value: Json } | { error: string } {
  if (from === to.type) return { value };
  const fail = (error = `cannot convert a ${from} value to ${to.type}`) => ({ error });
  switch (to.type) {
    case "text":
    case "long_text":
      if (typeof value === "string") return { value };
      if (typeof value === "number" || typeof value === "boolean") return { value: String(value) };
      return Array.isArray(value) && from === "multi_select" ? { value: value.join(", ") } : fail();
    case "number":
      if (typeof value === "boolean") return { value: value ? 1 : 0 };
      if (typeof value !== "string") return fail();
      return value.trim() !== "" && Number.isFinite(Number(value)) ? { value: Number(value) } : fail(`"${value}" is not a number`);
    case "checkbox": {
      if (typeof value === "number" && (value === 0 || value === 1)) return { value: value === 1 };
      if (typeof value !== "string") return fail();
      const word = BOOLEAN_WORDS[value.trim().toLowerCase()];
      return word === undefined ? fail(`"${value}" is not true or false`) : { value: word };
    }
    case "date":
      return typeof value === "string" && isDate(value.trim()) ? { value: value.trim() } : fail(`"${String(value)}" is not an ISO date`);
    case "single_select":
      if (typeof value === "string") return { value: value.trim() };
      if (Array.isArray(value) && from === "multi_select" && value.length <= 1) return { value: value[0] ?? null };
      return fail(Array.isArray(value) ? "has more than one option" : undefined);
    case "multi_select":
      if (typeof value === "string") return { value: value.split(",").map((s) => s.trim()).filter(Boolean) };
      return fail();
    default:
      return fail();
  }
}

/** The options a select field needs to hold every stored value, in first-seen order. */
export function deriveOptions(values: Json[], to: FieldType): string[] {
  const seen = new Set<string>();
  for (const value of values) {
    const items = Array.isArray(value) ? value.map(String) : to === "multi_select" && typeof value === "string" ? value.split(",") : [String(value)];
    for (const item of items) if (item.trim() !== "") seen.add(item.trim());
  }
  return [...seen];
}

/** Convert every stored value of one field. Pure: the caller writes the result. */
export function planConversion(
  rows: { id: string; value: Json | undefined }[],
  from: Field,
  to: Field,
): { report: MigrationReport; next: Map<string, Json> } {
  const report: MigrationReport = { field: from.name, from: from.type, to: to.type, total: rows.length, empty: 0, converted: 0, failures: [], applied: false };
  const next = new Map<string, Json>();
  for (const { id, value } of rows) {
    if (value === null || value === undefined) {
      report.empty += 1;
      continue;
    }
    const result = coerce(value, from.type, to);
    const issue = "error" in result ? { message: result.error } : checkValue(to, result.value);
    if ("error" in result || issue) {
      report.failures.push({ rowId: id, value, reason: issue?.message ?? "" });
      next.set(id, null);
    } else {
      report.converted += 1;
      next.set(id, result.value);
    }
  }
  return { report, next };
}
