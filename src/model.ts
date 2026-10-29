import { PRINCIPAL_KINDS, type Json, type PrincipalKind } from "agentic-identity";

export { PRINCIPAL_KINDS, type PrincipalKind };

/** The one emptiness rule: null, missing, an empty string, or an empty list. Queries and "required" both use it. */
export const isEmpty = (value: unknown): boolean => value === null || value === undefined || value === "" || (Array.isArray(value) && value.length === 0);

/** The rule for "required": empty, or a string of only whitespace. Queries keep `isEmpty`, which treats "  " as a value. */
export const isBlank = (value: unknown): boolean => isEmpty(value) || (typeof value === "string" && value.trim() === "");

export const FIELD_TYPES = ["text", "long_text", "number", "checkbox", "date", "single_select", "multi_select", "link", "file"] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

export interface Field {
  /** Stable. Values are stored by id, so a rename rewrites no row. */
  id: string;
  name: string;
  type: FieldType;
  required: boolean;
  /** Select fields only. */
  options?: string[];
  /** Link fields only. The table in the same base that holds the linked rows. */
  linkTable?: string;
}

export interface FieldInput {
  name: string;
  type: FieldType;
  required?: boolean;
  options?: string[];
  linkTable?: string;
}

export interface Table {
  id: string;
  baseId: string;
  name: string;
  fields: Field[];
  createdAt: string;
  updatedAt: string;
}

/** Who wrote a row. The kind stays on every create and update, so agent edits are labeled. */
export interface Actor {
  id: string;
  kind: PrincipalKind;
}

export interface FileRef {
  key: string;
  name: string;
  size?: number;
  contentType?: string;
}

export type Values = Record<string, Json>;

export interface Row {
  id: string;
  tableId: string;
  /** Keyed by field name. */
  values: Values;
  createdAt: string;
  updatedAt: string;
  createdBy: Actor;
  updatedBy: Actor;
}

export interface Issue {
  field: string;
  code: "type" | "required" | "option" | "duplicate" | "unknown_field" | "link_missing" | "duplicate_field" | "operator";
  message: string;
}

export class TablesError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class ValidationError extends TablesError {
  constructor(readonly issues: Issue[]) {
    super("VALIDATION_FAILED", issues.map((i) => `${i.field}: ${i.message}`).join("; "));
  }
}

export class NotFoundError extends TablesError {
  constructor(what: string) {
    super("NOT_FOUND", `${what} not found`);
  }
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2}))?$/;

export function isDate(value: unknown): value is string {
  return typeof value === "string" && DATE_PATTERN.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value.slice(0, 10)).toISOString().startsWith(value.slice(0, 10));
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isStringArray = (value: unknown): value is string[] => Array.isArray(value) && value.every((v) => typeof v === "string");

/** Check one value against one field. Returns an issue, or null when the value is valid or empty. */
export function checkValue(field: Field, value: unknown): Omit<Issue, "field"> | null {
  if (value === null || value === undefined) return null;
  const bad = (message: string): Omit<Issue, "field"> => ({ code: "type", message });
  switch (field.type) {
    case "text":
    case "long_text":
      return typeof value === "string" ? null : bad("expects a string");
    case "number":
      return typeof value === "number" && Number.isFinite(value) ? null : bad("expects a finite number");
    case "checkbox":
      return typeof value === "boolean" ? null : bad("expects true or false");
    case "date":
      return isDate(value) ? null : bad("expects a date like 2026-10-28 or an ISO date and time");
    case "single_select":
      if (typeof value !== "string") return bad("expects one option as a string");
      return field.options?.includes(value) ? null : { code: "option", message: `"${value}" is not an option (${field.options?.join(", ")})` };
    case "multi_select": {
      if (!isStringArray(value)) return bad("expects an array of options");
      const missing = value.find((v) => !field.options?.includes(v));
      if (missing !== undefined) return { code: "option", message: `"${missing}" is not an option (${field.options?.join(", ")})` };
      return new Set(value).size === value.length ? null : { code: "duplicate", message: "lists an option twice" };
    }
    case "link":
      return isStringArray(value) && new Set(value).size === value.length ? null : bad("expects an array of unique row ids");
    case "file":
      return Array.isArray(value) && value.every((v) => isObject(v) && typeof v.key === "string" && v.key !== "" && typeof v.name === "string")
        ? null
        : bad("expects an array of { key, name } file refs");
  }
}
