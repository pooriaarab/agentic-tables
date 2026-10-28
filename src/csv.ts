import { coerce } from "./migrate.js";
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

/** Write rows as CSV. The header holds the field names. */
export function toCsv(table: Table, rows: Row[]): string {
  const lines = [table.fields.map((f) => escape(f.name)).join(",")];
  for (const row of rows) lines.push(table.fields.map((f) => escape(show(row.values[f.name]))).join(","));
  return `${lines.join("\n")}\n`;
}

/** Turn CSV records into row values. Empty cells are left out. Any bad cell fails the whole import with its line. */
export function csvToValues(table: Table, header: string[], records: string[][]): Values[] {
  const issues: Issue[] = [];
  const fields = header.map((name) => table.fields.find((f) => f.name === name));
  header.forEach((name, i) => {
    if (!fields[i]) issues.push({ field: name, code: "unknown_field", message: "no such field in the table" });
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

/** Guess a field type for each column. A column that does not fit one type is text. */
export function inferFields(header: string[], records: string[][]): FieldInput[] {
  return header.map((name, i) => {
    const cells = records.map((r) => r[i] ?? "").filter((c) => c.trim() !== "");
    const all = (test: (c: string) => boolean) => cells.length > 0 && cells.every(test);
    if (all((c) => Number.isFinite(Number(c)))) return { name, type: "number" };
    if (all((c) => /^(true|false)$/i.test(c.trim()))) return { name, type: "checkbox" };
    if (all((c) => isDate(c.trim()))) return { name, type: "date" };
    if (cells.some((c) => c.length > 200 || c.includes("\n"))) return { name, type: "long_text" };
    const options = [...new Set(cells.map((c) => c.trim()))];
    if (records.length >= 5 && options.length >= 2 && options.length <= 6 && cells.length >= options.length * 2) return { name, type: "single_select", options };
    return { name, type: "text" };
  });
}
