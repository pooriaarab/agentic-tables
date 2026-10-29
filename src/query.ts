import { isDate, isEmpty, type Field, type FieldType, type Issue, type Table } from "./model.js";
import type { Json } from "agentic-identity";

export type Op =
  | "eq" | "neq" | "contains" | "starts_with" | "gt" | "gte" | "lt" | "lte"
  | "in" | "has" | "has_any" | "has_all" | "is_empty" | "not_empty";

export interface Condition {
  /** A field name or id. */
  field: string;
  op: Op;
  value?: Json;
}
export type Filter = Condition | { and: Filter[] } | { or: Filter[] };

export interface Sort {
  /** A field name or id, or "createdAt" or "updatedAt". */
  field: string;
  direction?: "asc" | "desc";
}

const EMPTY: Op[] = ["is_empty", "not_empty"];
const ORDERED: Op[] = ["eq", "neq", "gt", "gte", "lt", "lte", ...EMPTY];
/** The operators each field type supports. */
export const OPERATORS: Record<FieldType, Op[]> = {
  text: ["eq", "neq", "contains", "starts_with", ...EMPTY],
  long_text: ["eq", "neq", "contains", "starts_with", ...EMPTY],
  number: ORDERED,
  date: ORDERED,
  checkbox: ["eq", "neq"],
  single_select: ["eq", "neq", "in", ...EMPTY],
  multi_select: ["has", "has_any", "has_all", ...EMPTY],
  link: ["has", ...EMPTY],
  file: EMPTY,
};

const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === "string");

function valueOk(field: Field, op: Op, value: unknown): boolean {
  if (EMPTY.includes(op)) return value === undefined;
  if (op === "in" || op === "has_any" || op === "has_all") return isStrings(value);
  if (field.type === "number") return typeof value === "number" && Number.isFinite(value);
  if (field.type === "date") return isDate(value);
  if (field.type === "checkbox") return typeof value === "boolean";
  return typeof value === "string";
}

const findField = (table: Table, ref: string): Field | undefined => table.fields.find((f) => f.id === ref) ?? table.fields.find((f) => f.name === ref);

/** Check a filter against the schema. Returns it with field ids, so a rename cannot break it. */
export function resolveFilter(table: Table, filter: Filter, issues: Issue[]): Filter {
  if (typeof filter !== "object" || filter === null || Array.isArray(filter)) {
    issues.push({ field: "filter", code: "type", message: 'must be an object: {field, op, value}, {and: [...]} or {or: [...]}' });
    return filter;
  }
  if ("and" in filter || "or" in filter) {
    const key = "and" in filter ? "and" : "or";
    const list = "and" in filter ? filter.and : (filter as { or: Filter[] }).or;
    if (!Array.isArray(list) || list.length === 0) issues.push({ field: key, code: "operator", message: `"${key}" needs a non-empty list` });
    return { [key]: (Array.isArray(list) ? list : []).map((f) => resolveFilter(table, f, issues)) } as Filter;
  }
  const field = findField(table, filter.field);
  if (!field) {
    issues.push({ field: String(filter.field), code: "unknown_field", message: "no such field" });
  } else if (!OPERATORS[field.type].includes(filter.op)) {
    issues.push({ field: field.name, code: "operator", message: `${field.type} fields support ${OPERATORS[field.type].join(", ")}, not ${filter.op}` });
  } else if (!valueOk(field, filter.op, filter.value)) {
    issues.push({ field: field.name, code: "type", message: `"${filter.op}" needs a value that fits a ${field.type} field` });
  }
  return { ...filter, field: field?.id ?? filter.field };
}

/** A sort key, or null for an empty value. System sorts use the row timestamps. */
export type SortSpec = { system: "createdAt" | "updatedAt" } | { field: Field };

export function resolveSort(table: Table, sort: Sort, issues: Issue[]): SortSpec | undefined {
  if (sort.field === "createdAt" || sort.field === "updatedAt") return { system: sort.field };
  const field = findField(table, sort.field);
  if (!field) issues.push({ field: sort.field, code: "unknown_field", message: "no such field" });
  else if (field.type === "multi_select" || field.type === "link" || field.type === "file") issues.push({ field: field.name, code: "operator", message: `${field.type} fields cannot sort` });
  else return { field };
  return undefined;
}

const time = (v: Json): number => Date.parse(v as string);

function test(field: Field, c: Condition, v: Json | undefined): boolean {
  const empty = isEmpty(v);
  if (c.op === "is_empty") return field.type === "checkbox" ? v !== true : empty;
  if (c.op === "not_empty") return !empty;
  if (field.type === "checkbox") return ((v ?? false) === c.value) === (c.op === "eq");
  if (c.op === "neq") return empty || !test(field, { ...c, op: "eq" }, v);
  if (empty) return false;
  const list = c.value as string[];
  switch (c.op) {
    case "eq": return field.type === "date" ? time(v as Json) === time(c.value as Json) : v === c.value;
    case "contains": return (v as string).toLowerCase().includes((c.value as string).toLowerCase());
    case "starts_with": return (v as string).toLowerCase().startsWith((c.value as string).toLowerCase());
    case "in": return list.includes(v as string);
    case "has": return (v as string[]).includes(c.value as string);
    case "has_any": return list.some((x) => (v as string[]).includes(x));
    case "has_all": return list.every((x) => (v as string[]).includes(x));
    default: {
      const [a, b] = field.type === "date" ? [time(v as Json), time(c.value as Json)] : [v as number, c.value as number];
      return c.op === "gt" ? a > b : c.op === "gte" ? a >= b : c.op === "lt" ? a < b : a <= b;
    }
  }
}

/** Evaluate a resolved filter against the stored values (keyed by field id). */
export function matches(table: Table, filter: Filter, values: Record<string, Json>): boolean {
  if ("and" in filter) return filter.and.every((f) => matches(table, f, values));
  if ("or" in filter) return filter.or.some((f) => matches(table, f, values));
  const field = table.fields.find((f) => f.id === filter.field);
  if (!field) throw new Error(`field ${filter.field} is gone`);
  return test(field, filter, values[field.id]);
}

/** The sort key of a row: a number or string, or null when the value is empty. */
export function sortKey(spec: SortSpec, row: { values: Record<string, Json>; createdAt: string; updatedAt: string }): string | number | null {
  if ("system" in spec) return row[spec.system];
  const v = row.values[spec.field.id];
  if (isEmpty(v)) return spec.field.type === "checkbox" ? 0 : null;
  switch (spec.field.type) {
    case "single_select": return spec.field.options?.indexOf(v as string) ?? 0;
    case "date": return time(v as Json);
    case "checkbox": return v === true ? 1 : 0;
    default: return v as string | number;
  }
}

export interface Keyed {
  k: string | number | null;
  /** Row creation time. Unique per table, so it breaks ties in creation order. */
  at: string;
  id: string;
}

const cmp = (a: string | number, b: string | number): number => (a < b ? -1 : a > b ? 1 : 0);

/** Order rows by key. Empty keys go last in both directions. Ties keep creation order, then id. */
export function compareKeys(a: Keyed, b: Keyed, direction: "asc" | "desc"): number {
  const ties = cmp(a.at, b.at) || cmp(a.id, b.id);
  if (a.k === null || b.k === null) return a.k === b.k ? ties : a.k === null ? 1 : -1;
  const order = cmp(a.k, b.k);
  return (direction === "desc" ? -order : order) || ties;
}

/** Opaque cursor for the in-memory plan. Works in a Worker: no Buffer. */
export const encodeCursor = (value: unknown): string =>
  btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(value)))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export const decodeCursor = (text: string): unknown =>
  JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(text.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0))));
