import { coerce, parseDecimal } from "./migrate.js";
import { checkValue, isDate, TablesError, ValidationError, type FieldInput, type Issue, type Row, type Table, type Values } from "./model.js";

/** Read CSV (RFC 4180): quoted cells may hold commas, quotes, and newlines. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  const input = text.replace(/^﻿/, "");
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (quoted) {
      if (c !== '"') cell += c;
      else if (input[i + 1] === '"') (cell += '"'), i++;
      else quoted = false;
    } else if (c === '"' && cell === "") quoted = true;
    else if (c === ",") (row.push(cell), (cell = ""));
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && input[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      (row = []), (cell = "");
    } else cell += c;
  }
  if (quoted) throw new TablesError("CSV_INVALID", "a quote never closes");
  if (cell !== "" || row.length > 0) rows.push([...row, cell]);
  return rows.filter((r) => !(r.length === 1 && r[0] === ""));
}

const escape = (cell: string): string => (/[",\n\r]/.test(cell) ? `"${cell.replaceAll('"', '""')}"` : cell);

function show(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.map((v) => (typeof v === "string" ? v : JSON.stringify(v))).join(", ");
  return String(value);
}

const FORMULA_START = /^[=+\-@\t\r]/;

/** A spreadsheet runs a cell that starts with = + - @ tab or CR as a formula. A leading apostrophe makes it text. */
const guard = (cell: string): string => (FORMULA_START.test(cell) ? `'${cell}` : cell);
const unguard = (cell: string): string => (cell.startsWith("'") && FORMULA_START.test(cell.slice(1)) ? cell.slice(1) : cell);

/**
 * Write rows as CSV. The header holds the field names. Every cell except a number or a checkbox, and
 * every header, gets the formula guard. Import reads a guarded header back, and keeps a guarded cell as written.
 */
export function toCsv(table: Table, rows: Row[]): string {
  const lines = [table.fields.map((f) => escape(guard(f.name))).join(",")];
  for (const row of rows) {
    lines.push(table.fields.map((f) => escape(f.type === "number" || f.type === "checkbox" ? show(row.values[f.name]) : guard(show(row.values[f.name])))).join(","));
  }
  return `${lines.join("\n")}\n`;
}

/** Turn CSV records into row values. Empty cells are left out. Any bad cell fails the whole import with its line. */
export function csvToValues(table: Table, header: string[], records: string[][]): Values[] {
  const issues: Issue[] = [];
  const names = header.map(unguard);
  const fields = names.map((name) => table.fields.find((f) => f.name === name));
  names.forEach((name, i) => {
    if (!fields[i]) issues.push({ field: name, code: "unknown_field", message: "no such field in the table" });
    else if (names.indexOf(name) !== i) issues.push({ field: name, code: "duplicate_field", message: "the header lists this field twice" });
  });
  if (issues.length > 0) throw new ValidationError(issues);
  const out: Values[] = [];
  records.forEach((record, index) => {
    const line = index + 2;
    if (record.length !== header.length) {
      issues.push({ field: `line ${line}`, code: "type", message: `has ${record.length} cells, the header has ${header.length}` });
      return;
    }
    const values: Values = {};
    record.forEach((cell, i) => {
      const field = fields[i]!;
      if (cell === "") return;
      const result = field.type === "link" || field.type === "file" ? { error: `CSV import does not support ${field.type} fields` } : coerce(cell, "text", field);
      const issue = "error" in result ? { code: "type" as const, message: result.error } : checkValue(field, result.value);
      if (issue || "error" in result) issues.push({ field: `line ${line}: ${field.name}`, code: issue?.code ?? "type", message: issue?.message ?? "" });
      else values[field.name] = result.value;
    });
    out.push(values);
  });
  if (issues.length > 0) throw new ValidationError(issues);
  return out;
}

/** Guess a field type for each column. A column that does not fit one type is text. Numbers must be plain decimals: "00123" and "0x1F" stay text. */
export function inferFields(header: string[], records: string[][]): FieldInput[] {
  return header.map((name, i) => {
    const cells = records.map((r) => r[i] ?? "").filter((c) => c.trim() !== "");
    const all = (test: (c: string) => boolean) => cells.length > 0 && cells.every(test);
    if (all((c) => parseDecimal(c) !== null)) return { name, type: "number" };
    if (all((c) => /^(true|false)$/i.test(c.trim()))) return { name, type: "checkbox" };
    if (all((c) => isDate(c.trim()))) return { name, type: "date" };
    if (cells.some((c) => c.length > 200 || c.includes("\n"))) return { name, type: "long_text" };
    const options = [...new Set(cells.map((c) => c.trim()))];
    if (records.length >= 5 && options.length >= 2 && options.length <= 6 && cells.length >= options.length * 2) return { name, type: "single_select", options };
    return { name, type: "text" };
  });
}
