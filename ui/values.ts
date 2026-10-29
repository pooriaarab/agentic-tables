import type { Field, Filter } from "agentic-tables/client";

/** What an edit control holds while a person types: text, a flag, or a list of options. */
export type Draft = string | boolean | string[];

export const EDITABLE = new Set(["text", "long_text", "number", "checkbox", "date", "single_select", "multi_select"]);

export const draftOf = (field: Field, value: unknown): Draft => {
  if (field.type === "checkbox") return value === true;
  if (field.type === "multi_select") return Array.isArray(value) ? (value as string[]) : [];
  return value === null || value === undefined ? "" : String(value);
};

/** The JSON value for a draft. An empty draft is `null`, which clears the cell. */
export const valueOf = (field: Field, draft: Draft): string | number | boolean | string[] | null => {
  if (field.type === "checkbox") return draft === true;
  if (field.type === "multi_select") return (draft as string[]).length ? (draft as string[]) : null;
  const text = String(draft);
  if (text.trim() === "") return null;
  return field.type === "number" ? Number(text) : text;
};

/** The text of a value for reading. Links and files are shown, not edited. */
export function show(field: Field, value: unknown): string {
  if (value === null || value === undefined || value === "") return "";
  if (field.type === "checkbox") return value === true ? "Yes" : "No";
  if (Array.isArray(value)) {
    if (field.type === "file") return value.map((f) => (f as { name: string }).name).join(", ");
    if (field.type === "link") return `${value.length} linked`;
    return value.join(", ");
  }
  return String(value);
}

export interface Condition {
  field: string;
  op: string;
  value: string;
}

const EMPTY_OPS = ["is_empty", "not_empty"];
const TEXT_OPS = ["contains", "eq", "neq", ...EMPTY_OPS];
const ORDER_OPS = ["eq", "neq", "gt", "lt", ...EMPTY_OPS];
/** The operators the UI offers for each field type. The API accepts more. */
export const OPS: Record<string, string[]> = {
  text: TEXT_OPS,
  long_text: TEXT_OPS,
  number: ORDER_OPS,
  date: ORDER_OPS,
  checkbox: ["eq"],
  single_select: ["eq", "neq", ...EMPTY_OPS],
  multi_select: ["has", ...EMPTY_OPS],
  link: EMPTY_OPS,
  file: EMPTY_OPS,
};
export const OP_LABEL: Record<string, string> = {
  contains: "contains", eq: "is", neq: "is not", gt: "is more than", lt: "is less than", has: "has", is_empty: "is empty", not_empty: "is not empty",
};

/** The filter for a condition, or `undefined` when the value is not ready. */
export function filterOf(field: Field | undefined, c: Condition): Filter | undefined {
  if (!field) return undefined;
  if (EMPTY_OPS.includes(c.op)) return { field: field.id, op: c.op as never };
  if (c.value.trim() === "") return undefined;
  const value = field.type === "number" ? Number(c.value) : field.type === "checkbox" ? c.value === "true" : c.value;
  return { field: field.id, op: c.op as never, value };
}
