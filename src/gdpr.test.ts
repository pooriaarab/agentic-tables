// Failure cases for data export and hard delete, written before the code.
//
//  1. A base needs an owner with an id and a valid kind. A missing kind is an
//     error, never "human".
//  2. Export of an owner holds only that owner's bases, tables, views, and
//     rows. A second owner's data is never in it.
//  3. Export for an owner with no bases is an empty list, not an error.
//  4. Export and erase refuse an empty or non-string owner id. An empty id
//     must never match every base.
//  5. A base with no owner (an old file) is never exported and never erased.
//  6. Erase removes every base, table, row, and view of the owner, and
//     nothing of a second owner. Export after erase is empty.
//  7. Erase for an owner with no bases changes nothing.
//  8. After erase in a file store, the file holds no trace of the owner's
//     values or names (a hard delete, no tombstone).
//  9. The export is plain JSON: it survives a JSON round trip unchanged, and
//     it keeps the principal kind of each row.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, test } from "vitest";
import { createMemoryStore } from "agentic-identity";
import { createTables, TablesError, type Actor, type Tables } from "./index.js";
import { createFileStore } from "./store-file.js";

const ada: Actor = { id: "ada", kind: "human" };
const bot: Actor = { id: "bot-1", kind: "agent_of_human" };
const bob: Actor = { id: "bob", kind: "human" };

async function fill(t: Tables, owner: Actor, secret: string) {
  const base = await t.createBase(`${secret}-base`, owner);
  const table = await t.createTable(base.id, `${secret}-table`, [{ name: "Note", type: "text" }]);
  await t.insertRow(table.id, { Note: `${secret}-value` }, bot);
  await t.createView(table.id, { name: `${secret}-view`, kind: "grid" });
  return { base, table };
}

let t: Tables;
beforeEach(() => {
  t = createTables(createMemoryStore());
});

describe("owner", () => {
  test("a base needs an owner with a valid kind", async () => {
    await expect(t.createBase("x", {} as Actor)).rejects.toThrow(/actor/);
    await expect(t.createBase("x", { id: "a" } as Actor)).rejects.toThrow(/actor/);
    await expect(t.createBase("x", { id: "a", kind: "wizard" } as unknown as Actor)).rejects.toThrow(/actor/);
  });

  test("refuses a missing owner, an empty id, and an id with no kind", async () => {
    await fill(t, ada, "ada");
    for (const bad of ["", "ada", undefined, null, 5, { id: "ada" }, { id: "", kind: "human" }] as unknown[]) {
      await expect(t.exportOwnerData(bad as never)).rejects.toThrow(/actor/);
      await expect(t.eraseOwnerData(bad as never)).rejects.toThrow(/actor/);
    }
    expect((await t.exportOwnerData(ada)).bases).toHaveLength(1);
  });
});

describe("export", () => {
  test("holds only the owner's data, as plain JSON, with the principal kind kept", async () => {
    await fill(t, ada, "ada");
    await fill(t, bob, "bob");
    const out = await t.exportOwnerData(ada);
    expect(out).toMatchObject({ format: "agentic-tables-export", version: 2, owner: { id: "ada", kind: "human" } });
    expect(out.bases).toHaveLength(1);
    expect(out.bases[0]).toMatchObject({ base: { name: "ada-base", ownerId: "ada" }, tables: [{ name: "ada-table" }], views: [{ name: "ada-view" }] });
    expect(out.bases[0]!.rows).toMatchObject([{ values: { Note: "ada-value" }, createdBy: { id: "bot-1", kind: "agent_of_human" } }]);
    expect(JSON.stringify(out)).not.toContain("bob");
    expect(JSON.parse(JSON.stringify(out))).toEqual(out);
  });

  test("an owner with no bases gets an empty list", async () => {
    await fill(t, bob, "bob");
    expect((await t.exportOwnerData(ada)).bases).toEqual([]);
  });
});

describe("one id, two kinds", () => {
  // A person and an agent can share an id. Export and erase must key on both, or one erases the other's data.
  test("export and erase touch only the principal with that id and kind", async () => {
    const agentAda: Actor = { id: "ada", kind: "agent" };
    await fill(t, ada, "person");
    const other = await fill(t, agentAda, "agent");
    const row = await t.insertRow(other.table.id, { Note: "agent-row" }, agentAda);
    const shared = await t.createBase("shared", bob);
    const sharedTable = await t.createTable(shared.id, "T", [{ name: "Note", type: "text" }]);
    await t.insertRow(sharedTable.id, { Note: "person-row" }, ada);
    await t.insertRow(sharedTable.id, { Note: "agent-row-2" }, agentAda);

    const person = await t.exportOwnerData(ada);
    expect(person.bases.map((b) => b.base.name)).toEqual(["person-base"]);
    expect(person.authoredRows.map((r) => r.values.Note)).toEqual(["person-row"]);
    expect(JSON.stringify(person)).not.toContain("agent-row");

    expect(await t.eraseOwnerData(ada)).toEqual({ bases: 1, tables: 1, rows: 1, views: 1, authoredRows: 1 });
    expect((await t.exportOwnerData(agentAda)).bases.map((b) => b.base.name)).toEqual(["agent-base"]);
    expect((await t.getRow(row.id)).values.Note).toBe("agent-row");
    expect((await t.listRows(sharedTable.id)).items.map((r) => r.values.Note)).toEqual(["agent-row-2"]);
  });
});

describe("erase", () => {
  test("removes everything of the owner and nothing of anyone else", async () => {
    await fill(t, ada, "ada");
    await fill(t, ada, "ada2");
    const { table } = await fill(t, bob, "bob");
    expect(await t.eraseOwnerData(ada)).toEqual({ bases: 2, tables: 2, rows: 2, views: 2, authoredRows: 0 });
    expect((await t.exportOwnerData(ada)).bases).toEqual([]);
    expect((await t.listBases()).map((b) => b.ownerId)).toEqual(["bob"]);
    expect((await t.listRows(table.id)).items).toHaveLength(1);
    expect(await t.eraseOwnerData(ada)).toEqual({ bases: 0, tables: 0, rows: 0, views: 0, authoredRows: 0 });
  });

  // Two rows the erased principal wrote, each linking the other, in a base it does not own.
  // Each is rewritten to drop the link and also deleted: the delete must win, in either order.
  test("erases linked rows the principal wrote, and leaves no row behind", async () => {
    const base = await t.createBase("shared", bob);
    const table = await t.createTable(base.id, "T", [{ name: "Name", type: "text" }]);
    await t.addField(table.id, { name: "Peer", type: "link", linkTable: table.id });
    const [a, b] = await t.insertRows(table.id, [{ Name: "a" }, { Name: "b" }], ada);
    const keep = await t.insertRow(table.id, { Name: "keep", Peer: [a!.id, b!.id] }, bob);
    await t.updateRow(a!.id, { Peer: [b!.id] }, ada);
    await t.updateRow(b!.id, { Peer: [a!.id] }, ada);
    expect((await t.eraseOwnerData(ada)).authoredRows).toBe(2);
    expect((await t.listRows(table.id)).items.map((r) => r.id)).toEqual([keep.id]);
    expect((await t.getRow(keep.id)).values.Peer).toEqual([]);
  });

  test("a base with no owner is never exported or erased", async () => {
    const store = createMemoryStore();
    await store.put("bases", "base_old", { name: "old", createdAt: "2026-01-01T00:00:00.000Z" });
    const old = createTables(store);
    expect((await old.exportOwnerData(ada)).bases).toEqual([]);
    expect((await old.eraseOwnerData(ada)).bases).toBe(0);
    expect(await old.listBases()).toHaveLength(1);
  });

  // A base made by an earlier build has no owner kind and no sharing record. The base is left alone, but rows the principal wrote in it still count.
  test("rows written in a base with no owner kind are still exported and erased as authored rows", async () => {
    const store = createMemoryStore();
    const old = createTables(store);
    await store.put("bases", "base_old", { name: "old", ownerId: "ada", createdAt: "2026-01-01T00:00:00.000Z" });
    const table = await old.createTable("base_old", "T", [{ name: "Note", type: "text" }]);
    await old.insertRow(table.id, { Note: "old-row" }, ada);
    expect((await old.exportOwnerData(ada)).bases).toEqual([]);
    expect((await old.exportOwnerData(ada)).authoredRows.map((r) => r.values.Note)).toEqual(["old-row"]);
    expect(await old.eraseOwnerData(ada)).toMatchObject({ bases: 0, authoredRows: 1 });
    expect(await old.listBases()).toHaveLength(1);
  });

  test("a file store keeps no trace after erase", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tables-gdpr-"));
    try {
      const file = join(dir, "db.json");
      const ft = createTables(createFileStore(file));
      await fill(ft, ada, "ada-secret");
      await fill(ft, bob, "bob");
      expect(readFileSync(file, "utf8")).toContain("ada-secret-value");
      await ft.eraseOwnerData(ada);
      const text = readFileSync(file, "utf8");
      expect(text).not.toContain("ada-secret");
      expect(text).toContain("bob-value");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
