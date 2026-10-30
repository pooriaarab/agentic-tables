// Failure cases, written before the checks:
// missing kind/store; sole versus shared owners; changed owner; delegated author and
// same-id other kind; damaged grant/key/path/author/orphan; rollback and retry;
// JSON records, file references, pagination, and surviving links to a deleted table.
import { describe, expect, test } from "vitest";
import { createMemoryStore, createSharing, type Store, type PrincipalContext } from "agentic-identity";
import { createAccountRegistry, type AccountPackage } from "agentic-identity/account";
import { tablesAccount, ERASED_ACCOUNT_ID, type TablesAccountDeps } from "./account.js";
import { createTables } from "./tables.js";
import { createGuarded } from "./guarded.js";
import type { Actor } from "./model.js";
const ada: Actor = { id: "ada", kind: "human" };
const bob: Actor = { id: "bob", kind: "human" };
const bot: Actor = { id: "ada", kind: "agent_of_human" };
const ctx = (p: Actor): PrincipalContext => ({ principalId: p.id, kind: p.kind, chain: [p], scopes: ["*:admin"] });
async function setup() {
  const store = createMemoryStore();
  const tables = createTables(store);
  const sharing = createSharing(store);
  const make = async (p: Actor) => {
    const g = createGuarded(tables, sharing)(ctx(p));
    const base = await g.createBase("Base");
    const table = await g.createTable(base.id, "Table", [{ name: "File", type: "file" }]);
    const row = await g.insertRow(table.id, { File: [{ key: "asset", name: "File" }] });
    await g.createView(table.id, { name: "Grid", kind: "grid" });
    return { base, table, row };
  };
  return { store, tables, sharing, make };
}

describe("store account contributor", () => {
  test("fits the registry and exports owned data, file refs, grants and authored edits", async () => {
    const s = await setup();
    const mine = await s.make(ada);
    const other = await s.make(bob);
    await s.tables.updateRow(other.row.id, {}, bot);
    const pkg: AccountPackage<TablesAccountDeps> = tablesAccount;
    expect(createAccountRegistry().register(pkg, { store: s.store }).ids()).toEqual(["tables"]);
    const out = await pkg.exportAccount(ada, { store: s.store });
    expect(out.bases).toMatchObject([{ id: mine.base.id }]);
    expect(out.rows).toMatchObject([{ values: { [mine.table.fields[0]!.id]: [{ key: "asset", name: "File" }] } }]);
    expect(JSON.parse(JSON.stringify(out))).toEqual(out);
    const authored = await pkg.exportAccount(bot, { store: s.store });
    expect(authored.authored_rows).toMatchObject([{ id: other.row.id, updatedBy: bot }]);
    await pkg.eraseAccount(bot, { store: s.store });
    expect((await s.store.get("rows", other.row.id))?.updatedBy).toEqual({ id: ERASED_ACCOUNT_ID, kind: bot.kind });
    expect((await pkg.exportAccount(bot, { store: s.store })).authored_rows).toEqual([]);
  });

  test("deletes sole ownership, keeps shared trees and other owners, then counts zero", async () => {
    const s = await setup();
    const sole = await s.make(ada);
    const joint = await s.make(ada);
    await s.sharing.grant(ctx(ada), joint.base.id, bob as never, "owner");
    await s.sharing.createInvite(ctx(ada), sole.base.id, { email: "friend@example.test", role: "viewer" });
    const counts = await tablesAccount.eraseAccount(ada, s);
    expect(counts).toMatchObject({ bases: 1, tables: 1, rows: 1, views: 1, authored_rows: 1 });
    expect(await s.store.get("bases", sole.base.id)).toBeNull();
    expect(await s.store.get("bases", joint.base.id)).not.toBeNull();
    expect((await s.sharing.can(ctx(bob), "admin", joint.table.id)).allowed).toBe(true);
    expect((await tablesAccount.exportAccount(bob, s)).bases).toMatchObject([{ id: joint.base.id }]);
    expect(await tablesAccount.eraseAccount(ada, s)).toEqual({ bases: 0, tables: 0, rows: 0, views: 0, authored_rows: 0, grants: 0 });
    expect((await s.store.query("invites")).items).toEqual([]);
  });

  test("a direct table co-owner preserves its base; transferred ownership exports for its new owner", async () => {
    const s = await setup();
    const made = await s.make(ada);
    await s.sharing.grant(ctx(ada), made.table.id, bob as never, "owner");
    await tablesAccount.eraseAccount(ada, s);
    expect(await s.store.get("bases", made.base.id)).not.toBeNull();
    expect(await s.store.get("tables", made.table.id)).not.toBeNull();
    expect((await tablesAccount.exportAccount(bob, s)).tables).toMatchObject([{ id: made.table.id }]);
  });

  test.each(["grant", "key", "parent", "author", "orphan", "time", "field"])("rejects damaged %s without erasing anything", async (damage) => {
    const s = await setup();
    const { base, table, row } = await s.make(ada);
    if (damage === "grant") await s.store.put("grants", `${base.id}:human:bob`, { resourceId: base.id, subjectId: "bob", role: "owner" });
    if (damage === "key") await s.store.put("grants", "bad-key", { resourceId: base.id, subjectId: "bob", subjectKind: "human", role: "owner" });
    if (damage === "parent") await s.store.put("resources", base.id, { id: base.id, type: "base", parentId: base.id });
    if (damage === "author") await s.store.put("rows", row.id, { ...(await s.store.get("rows", row.id))!, updatedBy: { id: "bob" } });
    if (damage === "time") await s.store.put("rows", row.id, { ...(await s.store.get("rows", row.id))!, createdAt: "bad" });
    if (damage === "field") await s.store.put("tables", table.id, { ...(await s.store.get("tables", table.id))!, fields: [null] });
    if (damage === "orphan") await s.store.delete("tables", table.id);
    await expect(tablesAccount.exportAccount(ada, s)).rejects.toMatchObject({ code: "DAMAGED_ACCOUNT_DATA" });
    await expect(tablesAccount.eraseAccount(ada, s)).rejects.toMatchObject({ code: "DAMAGED_ACCOUNT_DATA" });
    expect(await s.store.get("bases", base.id)).not.toBeNull();
    expect(await s.store.get("rows", row.id)).not.toBeNull();
  });

  test("transaction failure rolls back and a retry finishes", async () => {
    const s = await setup();
    const made = await s.make(ada);
    const failing: Store = { ...s.store, transaction: (run) => s.store.transaction((tx) => run({ ...tx, delete: async () => { throw new Error("write failed"); } })) };
    await expect(tablesAccount.eraseAccount(ada, { store: failing })).rejects.toThrow("write failed");
    expect(await s.store.get("bases", made.base.id)).not.toBeNull();
    expect((await tablesAccount.eraseAccount(ada, s)).bases).toBe(1);
    expect((await tablesAccount.eraseAccount(ada, s)).bases).toBe(0);
  });


  test("reads later pages and distinguishes principal kinds", async () => {
    const s = await setup();
    const made = await s.make(bob);
    await s.tables.insertRows(made.table.id, Array.from({ length: 105 }, () => ({})), bot);
    await s.tables.insertRow(made.table.id, {}, ada);
    expect((await tablesAccount.exportAccount(bot, s)).authored_rows).toHaveLength(105);
    expect((await tablesAccount.eraseAccount(bot, s)).authored_rows).toBe(105);
    expect((await tablesAccount.exportAccount(ada, s)).authored_rows).toHaveLength(1);
    expect((await tablesAccount.eraseAccount(bot, s)).authored_rows).toBe(0);
  });

  test("refuses to leave links to a deleted table", async () => {
    const s = await setup();
    const made = await s.make(ada);
    const linked = await s.tables.createTable(made.base.id, "Links", [{ name: "Ref", type: "link", linkTable: made.table.id }]);
    await s.sharing.createResource(ctx(ada), { id: linked.id, type: "table", parentId: made.base.id });
    await s.sharing.grant(ctx(ada), linked.id, bob as never, "owner");
    await expect(tablesAccount.eraseAccount(ada, s)).rejects.toMatchObject({ code: "LINKED_TABLE" });
    expect(await s.store.get("bases", made.base.id)).not.toBeNull();
  });

  test("rejects invalid subjects and dependencies", async () => {
    const s = await setup();
    for (const bad of [null, { id: "ada" }, { id: "", kind: "human" }, { id: ERASED_ACCOUNT_ID, kind: "human" }]) {
      await expect(tablesAccount.exportAccount(bad as never, s)).rejects.toThrow(/subject/);
      await expect(tablesAccount.eraseAccount(bad as never, s)).rejects.toThrow(/subject/);
    }
    await expect(tablesAccount.eraseAccount(ada, {} as never)).rejects.toThrow(/store/);
  });
});
