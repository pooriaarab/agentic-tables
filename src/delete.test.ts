// Failure cases for delete and required, written before the code.
//
//  1. Delete a table that does not exist: not found.
//  2. Delete a table that another table links to: refused, nothing is removed.
//  3. Delete a table: its rows and views go, other tables keep their rows.
//  4. Delete a base: every table, row, and view in it goes. Another base stays.
//  5. Delete a base that does not exist: not found.
//  6. Make a field required while rows have no value (missing, "", []): the
//     change aborts, lists those rows, and the field stays optional.
//  7. A dry run lists the same rows and writes nothing.
//  8. After the empty rows get values, the change applies and later writes
//     without the value fail.
//  9. Make a field optional: it applies, and later writes may leave it out.
// 10. Change required on a field that does not exist: not found.
import { beforeEach, describe, expect, test } from "vitest";
import { createMemoryStore, createTables, MigrationError, NotFoundError, ValidationError, type Actor, type Tables } from "./index.js";

const human: Actor = { id: "u1", kind: "human" };
let t: Tables;
let baseId: string;

beforeEach(async () => {
  t = createTables(createMemoryStore());
  baseId = (await t.createBase("Crm", human)).id;
});

describe("delete table and base", () => {
  test("a missing table or base is not found", async () => {
    await expect(t.deleteTable("tbl_none")).rejects.toBeInstanceOf(NotFoundError);
    await expect(t.deleteBase("base_none")).rejects.toBeInstanceOf(NotFoundError);
  });

  test("a table that other tables link to is refused and nothing is removed", async () => {
    const companies = await t.createTable(baseId, "Companies", [{ name: "Name", type: "text" }]);
    const people = await t.createTable(baseId, "People", [{ name: "Company", type: "link", linkTable: companies.id }]);
    await t.insertRow(companies.id, { Name: "Acme" }, human);
    const error = await t.deleteTable(companies.id).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).issues[0]?.field).toBe("People.Company");
    expect((await t.listRows(companies.id)).items).toHaveLength(1);
    await t.deleteField(people.id, "Company");
    expect(await t.deleteTable(companies.id)).toEqual({ rows: 1, views: 0 });
  });

  test("deleting a table removes its rows and views and keeps the others", async () => {
    const a = await t.createTable(baseId, "A", [{ name: "Name", type: "text" }]);
    const b = await t.createTable(baseId, "B", [{ name: "Name", type: "text" }]);
    await t.insertRows(a.id, [{ Name: "1" }, { Name: "2" }], human);
    const rowB = await t.insertRow(b.id, { Name: "keep" }, human);
    await t.createView(a.id, { name: "V", kind: "grid" });
    expect(await t.deleteTable(a.id)).toEqual({ rows: 2, views: 1 });
    await expect(t.getTable(a.id)).rejects.toBeInstanceOf(NotFoundError);
    expect((await t.getRow(rowB.id)).values.Name).toBe("keep");
    expect((await t.listTables(baseId)).map((x) => x.name)).toEqual(["B"]);
  });

  test("deleting a base removes everything in it and leaves another base", async () => {
    const other = await t.createBase("Other", human);
    const a = await t.createTable(baseId, "A", [{ name: "Name", type: "text" }]);
    const o = await t.createTable(other.id, "O", [{ name: "Name", type: "text" }]);
    await t.insertRows(a.id, [{ Name: "1" }], human);
    const keep = await t.insertRow(o.id, { Name: "keep" }, human);
    expect(await t.deleteBase(baseId)).toEqual({ tables: 1, rows: 1, views: 0 });
    expect((await t.listBases()).map((b) => b.id)).toEqual([other.id]);
    expect((await t.getRow(keep.id)).values.Name).toBe("keep");
  });
});

describe("change required", () => {
  async function table() {
    const tbl = await t.createTable(baseId, "T", [{ name: "Name", type: "text" }, { name: "Tags", type: "multi_select", options: ["a"] }]);
    const missing = await t.insertRow(tbl.id, { Tags: ["a"] }, human);
    const blank = await t.insertRow(tbl.id, { Name: "", Tags: ["a"] }, human);
    const ok = await t.insertRow(tbl.id, { Name: "x" }, human);
    return { tbl, missing, blank, ok };
  }

  test("aborts and lists the rows with no value", async () => {
    const { tbl, missing, blank } = await table();
    const error = await t.setRequired(tbl.id, "Name", true).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MigrationError);
    expect((error as MigrationError).report).toMatchObject({ total: 3, converted: 1, applied: false });
    expect((error as MigrationError).report.failures.map((f) => f.rowId).sort()).toEqual([missing.id, blank.id].sort());
    expect((await t.getTable(tbl.id)).fields[0]?.required).toBe(false);
    await expect(t.setRequired(tbl.id, "Tags", true)).rejects.toBeInstanceOf(MigrationError);
  });

  test("a dry run reports the same rows and writes nothing", async () => {
    const { tbl } = await table();
    const report = await t.setRequired(tbl.id, "Name", true, { dryRun: true });
    expect(report).toMatchObject({ applied: false, failures: [{ reason: "has no value" }, { reason: "has no value" }] });
    expect((await t.getTable(tbl.id)).fields[0]?.required).toBe(false);
  });

  test("applies once every row has a value, then enforces it", async () => {
    const { tbl, missing, blank } = await table();
    await t.updateRow(missing.id, { Name: "m" }, human);
    await t.updateRow(blank.id, { Name: "b" }, human);
    expect(await t.setRequired(tbl.id, "Name", true)).toMatchObject({ applied: true, failures: [] });
    await expect(t.insertRow(tbl.id, { Tags: ["a"] }, human)).rejects.toBeInstanceOf(ValidationError);
  });

  test("makes a field optional, and refuses an unknown field", async () => {
    const tbl = await t.createTable(baseId, "T", [{ name: "Name", type: "text", required: true }]);
    expect(await t.setRequired(tbl.id, "Name", false)).toMatchObject({ applied: true });
    await t.insertRow(tbl.id, {}, human);
    await expect(t.setRequired(tbl.id, "Nope", true)).rejects.toBeInstanceOf(NotFoundError);
  });
});
