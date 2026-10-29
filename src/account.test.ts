// Failure cases for the account contract, written before the code.
//  1. A subject with no id or no kind is refused. An empty id never matches every base.
//  2. Export holds only the subject's data. A second owner, and a second subject with the same id
//     and another kind, never show up.
//  3. Export is plain JSON: it survives a JSON round trip, and keeps the principal kind of each row.
//  4. Rows the subject wrote in a base it does not own are in `authored_rows`, not in `rows`.
//  5. Erase counts match what export listed. After it, export is empty. A second erase counts zero.
//  6. Erase removes nothing of another owner.
//  7. The contract names stay stable: a rename of a collection fails here before it breaks a host.
import { beforeEach, describe, expect, test } from "vitest";
import { createMemoryStore } from "agentic-identity";
import { createTables, tablesAccount, type Actor, type Tables } from "./index.js";

const ada: Actor = { id: "ada", kind: "human" };
const adaBot: Actor = { id: "ada", kind: "agent" };
const bob: Actor = { id: "bob", kind: "human" };

let tables: Tables;
const deps = () => ({ tables });
beforeEach(() => {
  tables = createTables(createMemoryStore());
});

async function fill(owner: Actor, tag: string) {
  const base = await tables.createBase(`${tag}-base`, owner);
  const table = await tables.createTable(base.id, `${tag}-table`, [{ name: "Note", type: "text" }]);
  await tables.insertRow(table.id, { Note: `${tag}-value` }, owner);
  await tables.createView(table.id, { name: `${tag}-view`, kind: "grid" });
  return table;
}

describe("exportAccount", () => {
  test("refuses a bad subject", async () => {
    await fill(ada, "ada");
    for (const bad of [{ id: "", kind: "human" }, { id: "ada" }, { id: "ada", kind: "wizard" }, null, "ada"]) {
      await expect(tablesAccount.exportAccount(bad as never, deps())).rejects.toThrow(/actor/);
      await expect(tablesAccount.eraseAccount(bad as never, deps())).rejects.toThrow(/actor/);
    }
  });

  test("holds only the subject's data, as plain JSON, under stable collection names", async () => {
    await fill(ada, "ada");
    await fill(bob, "bob");
    await fill(adaBot, "bot");
    const out = await tablesAccount.exportAccount(ada, deps());
    expect(Object.keys(out)).toEqual(["bases", "tables", "views", "rows", "authored_rows"]);
    expect(out.bases).toMatchObject([{ name: "ada-base" }]);
    expect(out.rows).toMatchObject([{ values: { Note: "ada-value" }, createdBy: { id: "ada", kind: "human" } }]);
    expect(JSON.stringify(out)).not.toMatch(/bob|bot-/);
    expect(JSON.parse(JSON.stringify(out))).toEqual(out);
  });

  test("rows written in a base the subject does not own are authored rows", async () => {
    const table = await fill(bob, "bob");
    await tables.insertRow(table.id, { Note: "from ada" }, ada);
    const out = await tablesAccount.exportAccount(ada, deps());
    expect(out.bases).toEqual([]);
    expect(out.rows).toEqual([]);
    expect(out.authored_rows).toMatchObject([{ values: { Note: "from ada" } }]);
  });
});

describe("eraseAccount", () => {
  test("counts what it removed, leaves others, and is safe to run twice", async () => {
    await fill(ada, "ada");
    const bobTable = await fill(bob, "bob");
    await tables.insertRow(bobTable.id, { Note: "from ada" }, ada);
    expect(await tablesAccount.eraseAccount(ada, deps())).toEqual({ bases: 1, tables: 1, views: 1, rows: 1, authored_rows: 1 });
    const after = await tablesAccount.exportAccount(ada, deps());
    expect(Object.values(after).every((list) => list.length === 0)).toBe(true);
    expect(await tablesAccount.eraseAccount(ada, deps())).toEqual({ bases: 0, tables: 0, views: 0, rows: 0, authored_rows: 0 });
    expect((await tablesAccount.exportAccount(bob, deps())).rows).toHaveLength(1);
  });
});
