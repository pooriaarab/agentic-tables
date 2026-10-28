// Failure cases for queries and views, written before the code.
//
//  1. A filter on a field that does not exist.
//  2. An operator that the field type does not support (contains on a number).
//  3. A value of the wrong type for the operator (gt "abc" on a number).
//  4. An empty "and" or "or" list.
//  5. A limit of 0, or an invalid cursor.
//  6. A sort on a field that cannot sort (multi select, link, file).
//  7. Empty values: they sort last in both directions, never match gt or lt,
//     and always match is_empty.
//  8. Paging with many equal sort values: every row appears exactly once.
//  9. A table bigger than the scan cap: fail, never return a partial answer.
// 10. A board grouped by a field that is not a single select.
// 11. A saved view whose field was deleted: fail loudly when it runs.
import { beforeEach, describe, expect, test } from "vitest";
import { createMemoryStore, createTables, TablesError, ValidationError, type Actor, type Tables } from "./index.js";

const human: Actor = { id: "u1", kind: "human" };
let t: Tables;
let tableId: string;

async function seed(maxScan?: number) {
  t = createTables(createMemoryStore(), { maxScan });
  const base = await t.createBase("Crm");
  const table = await t.createTable(base.id, "People", [
    { name: "Name", type: "text" },
    { name: "Age", type: "number" },
    { name: "Born", type: "date" },
    { name: "Stage", type: "single_select", options: ["lead", "won", "lost"] },
    { name: "Tags", type: "multi_select", options: ["a", "b", "c"] },
    { name: "Active", type: "checkbox" },
  ]);
  tableId = table.id;
  const rows = [
    { Name: "Ada", Age: 36, Born: "1815-12-10", Stage: "won", Tags: ["a", "b"], Active: true },
    { Name: "Bob", Age: 20, Born: "2005-01-01T10:00:00Z", Stage: "lead", Tags: ["b"] },
    { Name: "Cy", Stage: "lead", Tags: [] },
    { Name: "Di", Age: 20, Stage: "lost", Tags: ["c"], Active: false },
  ];
  for (const r of rows) await t.insertRow(tableId, r, human);
}
const names = async (q: Parameters<Tables["queryRows"]>[1]) => (await t.queryRows(tableId, q)).items.map((r) => r.values.Name);
const rejects = async (p: Promise<unknown>, code: string) => {
  const e = await p.then(() => undefined, (x: unknown) => x);
  expect(e).toBeInstanceOf(ValidationError);
  expect((e as ValidationError).issues[0]?.code).toBe(code);
};

beforeEach(() => seed());

describe("query validation", () => {
  test("rejects unknown fields, wrong operators, wrong values, empty groups", async () => {
    await rejects(t.queryRows(tableId, { filter: { field: "Nope", op: "eq", value: 1 } }), "unknown_field");
    await rejects(t.queryRows(tableId, { filter: { field: "Age", op: "contains", value: "1" } }), "operator");
    await rejects(t.queryRows(tableId, { filter: { field: "Age", op: "gt", value: "abc" } }), "type");
    await rejects(t.queryRows(tableId, { filter: { and: [] } }), "operator");
    await rejects(t.queryRows(tableId, { filter: { or: [] } }), "operator");
    await rejects(t.queryRows(tableId, { sort: { field: "Tags" } }), "operator");
    await rejects(t.queryRows(tableId, { sort: { field: "Nope" } }), "unknown_field");
  });
  test("rejects a bad limit and a bad cursor", async () => {
    await expect(t.queryRows(tableId, { limit: 0 })).rejects.toBeInstanceOf(TablesError);
    await expect(t.queryRows(tableId, { cursor: "zzz" })).rejects.toThrow();
    await expect(t.queryRows(tableId, { sort: { field: "Age" }, cursor: "zzz" })).rejects.toThrow();
  });
});

describe("filters", () => {
  test("and, or, and per-type operators", async () => {
    expect(await names({ filter: { field: "Age", op: "gte", value: 20 } })).toEqual(["Ada", "Bob", "Di"]);
    expect(await names({ filter: { and: [{ field: "Stage", op: "eq", value: "lead" }, { field: "Age", op: "is_empty" }] } })).toEqual(["Cy"]);
    expect(await names({ filter: { or: [{ field: "Name", op: "starts_with", value: "ad" }, { field: "Stage", op: "in", value: ["lost"] }] } })).toEqual(["Ada", "Di"]);
    expect(await names({ filter: { field: "Tags", op: "has_all", value: ["a", "b"] } })).toEqual(["Ada"]);
    expect(await names({ filter: { field: "Tags", op: "has_any", value: ["c", "a"] } })).toEqual(["Ada", "Di"]);
    expect(await names({ filter: { field: "Tags", op: "is_empty" } })).toEqual(["Cy"]);
    expect(await names({ filter: { field: "Active", op: "eq", value: false } })).toEqual(["Bob", "Cy", "Di"]);
    expect(await names({ filter: { field: "Born", op: "lt", value: "2000-01-01" } })).toEqual(["Ada"]);
    expect(await names({ filter: { field: "Name", op: "contains", value: "I" } })).toEqual(["Di"]);
  });
  test("empty values never match gt or lt and neq matches them", async () => {
    expect(await names({ filter: { field: "Age", op: "lt", value: 100 } })).toEqual(["Ada", "Bob", "Di"]);
    expect(await names({ filter: { field: "Age", op: "neq", value: 20 } })).toEqual(["Ada", "Cy"]);
  });
});

describe("sort and paging", () => {
  test("empty values sort last in both directions", async () => {
    expect(await names({ sort: { field: "Age" } })).toEqual(["Bob", "Di", "Ada", "Cy"]);
    expect(await names({ sort: { field: "Age", direction: "desc" } })).toEqual(["Ada", "Bob", "Di", "Cy"]);
  });
  test("sorts a select by option order and sorts by updatedAt in the store", async () => {
    expect(await names({ sort: { field: "Stage" } })).toEqual(["Bob", "Cy", "Ada", "Di"]);
    const page = await t.queryRows(tableId, { sort: { field: "updatedAt", direction: "desc" } });
    expect([page.plan, page.items[0]?.values.Name]).toEqual(["store", "Di"]);
  });
  test("paging with equal sort values returns every row once", async () => {
    for (const mode of [undefined, { field: "Stage" }, { field: "Age", direction: "desc" as const }]) {
      const seen: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await t.queryRows(tableId, { sort: mode, limit: 1, cursor, filter: mode ? { field: "Name", op: "not_empty" } : undefined });
        seen.push(...page.items.map((r) => String(r.values.Name)));
        cursor = page.nextCursor;
      } while (cursor);
      expect([...seen].sort()).toEqual(["Ada", "Bob", "Cy", "Di"]);
    }
  });
  test("a table over the scan cap fails instead of returning part", async () => {
    await seed(3);
    await rejects(t.queryRows(tableId, { filter: { field: "Age", op: "gt", value: 0 } }).catch((e) => { throw new ValidationError([{ field: "x", code: "operator", message: e.code }]); }), "operator");
    await expect(t.queryRows(tableId, {})).resolves.toBeTruthy();
  });
});

describe("views", () => {
  test("a grid view runs its saved filter and sort", async () => {
    const view = await t.createView(tableId, { name: "Leads", kind: "grid", filter: { field: "Stage", op: "eq", value: "lead" }, sort: { field: "Name", direction: "desc" } });
    const run = await t.runView(view.id);
    expect(run.kind === "grid" && run.items.map((r) => r.values.Name)).toEqual(["Cy", "Bob"]);
  });
  test("a board groups rows by a single select, with a group for no value", async () => {
    await t.insertRow(tableId, { Name: "Eve" }, human);
    const view = await t.createView(tableId, { name: "Board", kind: "board", groupBy: "Stage" });
    const run = await t.runView(view.id);
    if (run.kind !== "board") throw new Error("expected a board");
    expect(run.groups.map((g) => [g.value, g.count])).toEqual([["lead", 2], ["won", 1], ["lost", 1], [null, 1]]);
  });
  test("a board needs a single select field", async () => {
    await rejects(t.createView(tableId, { name: "B", kind: "board", groupBy: "Tags" }), "type");
    await rejects(t.createView(tableId, { name: "B", kind: "board" }), "type");
  });
  test("a view fails loudly when its field is gone", async () => {
    const view = await t.createView(tableId, { name: "Old", kind: "grid", filter: { field: "Age", op: "gt", value: 1 } });
    await t.deleteField(tableId, "Age");
    await rejects(t.runView(view.id), "unknown_field");
  });
});
