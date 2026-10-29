// Failure cases, written before the fix. Two Tables on one backend. While one change runs, a second
// writer adds a row, a table, or a view. A query guards only the docs it returned, so without a bump on the
// parent doc the first change commits and misses the new doc.
//
//  1. Erase reads a principal's data. A row is added meanwhile. No row may survive the erase.
//  2. addField (required) reads the rows. A row is added meanwhile. The change must fail: a row has no value.
//  3. deleteTable reads the tables of the base. A table that links to it is added meanwhile. The delete must refuse.
//  4. Erase reads a table. A view is added meanwhile. No view may survive the erase.
//  6. A batch insert (insertRows) racing an erase leaves no row.
//  5. changeFieldType reads the rows. A row is added meanwhile. The new row must be converted or refused, not left in the old type.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryStore, type Query, type Store } from "agentic-identity";
import { afterAll, describe, expect, test } from "vitest";
import { createTables, ValidationError, type Actor } from "./index.js";
import { createFileStore } from "./store-file.js";

// The memory adapter gives every write a new version, so a rewrite alone is seen. The file store compares
// the text of the docs, so only a changed `rev` is seen. Both adapters run every case.
const dir = mkdtempSync(join(tmpdir(), "tables-concurrency-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const ADAPTERS: Record<string, (shared: string) => Store> = {
  memory: (shared) => createMemoryStore({ shared }),
  file: (shared) => createFileStore(join(dir, `${shared}.json`)),
};

const ada: Actor = { id: "ada", kind: "human" };

/** Run `during` once, just after the first query of `collection` inside a transaction. */
function interrupting(store: Store, collection: string, during: () => Promise<unknown>): Store {
  let fired = false;
  return {
    ...store,
    region: store.region,
    transaction: (fn) =>
      store.transaction((tx) =>
        fn({
          ...tx,
          query: (async (name: string, query?: Query) => {
            const page = await tx.query(name, query);
            if (name === collection && !fired) {
              fired = true;
              await during();
            }
            return page;
          }) as typeof tx.query,
        }),
      ),
  } as Store;
}

async function setup(open: (shared: string) => Store) {
  const shared = crypto.randomUUID();
  const other = createTables(open(shared));
  const base = await other.createBase("b", ada);
  const table = await other.createTable(base.id, "T", [{ name: "Name", type: "text" }]);
  const rowsOf = async (store: Store) => (await store.query("rows")).items.length;
  return { shared, other, base, table, rowsOf, open };
}

describe.each(Object.entries(ADAPTERS))("a doc added during a change, %s store", (_name, open) => {
  test("a row added during erase does not survive", async () => {
    const { shared, other, table, rowsOf } = await setup(open);
    await other.insertRow(table.id, { Name: "first" }, ada);
    const mine = open(shared);
    const t = createTables(interrupting(mine, "rows", () => other.insertRow(table.id, { Name: "late" }, ada)));
    const summary = await t.eraseOwnerData(ada);
    expect(summary.rows).toBe(2);
    expect(await rowsOf(mine)).toBe(0);
  });

  test("rows added in a batch during erase do not survive", async () => {
    const { shared, other, table, rowsOf } = await setup(open);
    const mine = open(shared);
    const t = createTables(interrupting(mine, "rows", () => other.insertRows(table.id, [{ Name: "a" }, { Name: "b" }], ada)));
    await t.eraseOwnerData(ada);
    expect(await rowsOf(mine)).toBe(0);
  });

  test("a row added during a required addField fails the change", async () => {
    const { shared, other, table } = await setup(open);
    const t = createTables(interrupting(open(shared), "rows", () => other.insertRow(table.id, { Name: "late" }, ada)));
    await expect(t.addField(table.id, { name: "Must", type: "text", required: true })).rejects.toBeInstanceOf(ValidationError);
    expect((await other.getTable(table.id)).fields).toHaveLength(1);
  });

  test("a table that links here, added during deleteTable, makes the delete refuse", async () => {
    const { shared, other, base, table } = await setup(open);
    const t = createTables(interrupting(open(shared), "tables", () => other.createTable(base.id, "Links", [{ name: "To", type: "link", linkTable: table.id }])));
    await expect(t.deleteTable(table.id)).rejects.toBeInstanceOf(ValidationError);
    expect((await other.listTables(base.id)).map((x) => x.name).sort()).toEqual(["Links", "T"]);
  });

  test("a view added during erase does not survive", async () => {
    const { shared, other, table } = await setup(open);
    const mine = open(shared);
    const t = createTables(interrupting(mine, "tables", () => other.createView(table.id, { name: "late", kind: "grid" })));
    await t.eraseOwnerData(ada);
    expect((await mine.query("views")).items).toEqual([]);
  });

  test("a row added during a type change is not left in the old type", async () => {
    const { shared, other, table } = await setup(open);
    await other.insertRow(table.id, { Name: "1" }, ada);
    const t = createTables(interrupting(open(shared), "rows", () => other.insertRow(table.id, { Name: "2" }, ada)));
    const report = await t.changeFieldType(table.id, "Name", { to: "number" });
    expect(report.total).toBe(2);
    expect((await other.queryRows(table.id)).items.map((r) => r.values.Name)).toEqual([1, 2]);
  });

  test("the revision counter does not appear in the API", async () => {
    const { other, base, table } = await setup(open);
    await other.insertRow(table.id, { Name: "x" }, ada);
    expect(Object.keys(await other.getTable(table.id))).not.toContain("rev");
    expect(Object.keys((await other.listBases())[0]!)).not.toContain("rev");
    expect(JSON.stringify(await other.exportOwnerData(ada))).not.toContain('"rev"');
    expect(base.id).toBeTruthy();
  });
});
