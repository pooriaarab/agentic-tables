// Failure cases for the account contract, written before the code.
//  1. A subject with no id or no kind is refused. A context for someone else, a context with an agent
//     chain, or missing deps is refused: it would export or erase another person's data.
//  2. Export holds only what the subject owns: a second owner, and a second subject with the same id
//     and another kind, never show up.
//  3. Export is plain JSON: it survives a JSON round trip (strictly), and keeps the principal kind.
//  4. Rows the subject wrote in a base it does not own are in `authored_rows`, not in `rows`.
//  5. Counts equal the lengths of the export taken just before. After erase, export is empty and a
//     second erase counts zero.
//  6. Erase leaves a second owner's bases, tables, and views whole, and the same-id agent's too.
//  7. A legacy base (no owner kind) stops both calls with LEGACY_BASE and changes nothing.
//  8. A base the subject gave away is not exported and not erased.
//  9. The grants of an erased base go with it.
// 10. The collection names stay stable, so a rename fails here before it breaks a host.
import { beforeEach, describe, expect, test } from "vitest";
import { createMemoryStore, createSharing, type PrincipalContext } from "agentic-identity";
import { createTables, tablesAccount, type Actor, type Tables } from "./index.js";
import { createGuarded, type Sharing } from "./guarded.js";

const ada: Actor = { id: "ada", kind: "human" };
const adaBot: Actor = { id: "ada", kind: "agent" };
const bob: Actor = { id: "bob", kind: "human" };
const ctxOf = (who: Actor): PrincipalContext => ({ principalId: who.id, kind: who.kind, chain: [{ id: who.id, kind: who.kind }], scopes: ["*:admin"] });

let store: ReturnType<typeof createMemoryStore>;
let tables: Tables;
let sharing: Sharing;
const deps = (who: Actor) => ({ tables, sharing, ctx: ctxOf(who) });
const as = (who: Actor) => createGuarded(tables, sharing)(ctxOf(who));
beforeEach(() => {
  store = createMemoryStore();
  tables = createTables(store);
  sharing = createSharing(store);
});

async function fill(owner: Actor, tag: string) {
  const g = as(owner);
  const base = await g.createBase(`${tag}-base`);
  const table = await g.createTable(base.id, `${tag}-table`, [{ name: "Note", type: "text" }]);
  await g.insertRow(table.id, { Note: `${tag}-value` });
  await g.createView(table.id, { name: `${tag}-view`, kind: "grid" });
  return { base, table };
}

describe("subject and deps", () => {
  test("refuses a bad subject, a context for someone else, an agent chain, and missing deps", async () => {
    await fill(ada, "ada");
    for (const bad of [{ id: "", kind: "human" }, { id: "ada" }, { id: "ada", kind: "wizard" }, null]) {
      await expect(tablesAccount.exportAccount(bad as never, deps(ada))).rejects.toThrow(/subject/);
      await expect(tablesAccount.eraseAccount(bad as never, deps(ada))).rejects.toThrow(/subject/);
    }
    await expect(tablesAccount.exportAccount(ada, deps(bob))).rejects.toThrow(/does not match/);
    await expect(tablesAccount.eraseAccount(ada, deps(adaBot))).rejects.toThrow(/does not match/);
    const viaAgent = { ...deps(ada), ctx: { ...ctxOf(adaBot), chain: [{ id: "ada", kind: "human" as const }, { id: "ada", kind: "agent" as const }] } };
    await expect(tablesAccount.eraseAccount(ada, viaAgent as never)).rejects.toThrow(/does not match/);
    await expect(tablesAccount.exportAccount(ada, {} as never)).rejects.toThrow("needs deps.tables");
    await expect(tablesAccount.eraseAccount(ada, undefined as never)).rejects.toThrow("needs deps.tables");
    expect((await tablesAccount.exportAccount(ada, deps(ada))).bases).toHaveLength(1);
  });
});

describe("exportAccount", () => {
  test("holds only the subject's data, as plain JSON, under stable names", async () => {
    await fill(ada, "ada");
    await fill(bob, "bob");
    const bot = await fill(adaBot, "bot");
    await tables.insertRow(bot.table.id, { Note: "bot-authored" }, ada);
    const elsewhere = await fill(bob, "bob2");
    await tables.insertRow(elsewhere.table.id, { Note: "bot-elsewhere" }, adaBot);
    const out = await tablesAccount.exportAccount(ada, deps(ada));
    expect(Object.keys(out)).toEqual(["bases", "tables", "views", "rows", "authored_rows"]);
    expect(out.bases).toMatchObject([{ name: "ada-base" }]);
    expect(out.rows).toMatchObject([{ values: { Note: "ada-value" }, createdBy: { id: "ada", kind: "human" } }]);
    expect(out.authored_rows).toMatchObject([{ values: { Note: "bot-authored" } }]); // not the agent's row in bob's base
    expect(JSON.stringify(out)).not.toMatch(/bob|bot-elsewhere/);
    expect(JSON.parse(JSON.stringify(out))).toStrictEqual(out);
  });

  test("a base the subject gave away is not theirs to export", async () => {
    const { base } = await fill(ada, "ada");
    await as(ada).grant("base", base.id, { kind: "human", id: "bob" }, "owner");
    await as(bob).revokeGrant("base", base.id, { kind: "human", id: "ada" });
    expect((await tablesAccount.exportAccount(ada, deps(ada))).bases).toEqual([]);
  });

  test("a legacy base stops the export", async () => {
    const { base } = await fill(ada, "ada");
    const { ownerKind: _kind, ...legacy } = (await store.get("bases", base.id))!;
    await store.put("bases", base.id, legacy);
    await expect(tablesAccount.exportAccount(ada, deps(ada))).rejects.toMatchObject({ code: "LEGACY_BASE" });
  });
});

describe("eraseAccount", () => {
  test("counts what it removed, leaves others whole, and is safe to run twice", async () => {
    await fill(ada, "ada");
    const bobFilled = await fill(bob, "bob");
    await tables.insertRow(bobFilled.table.id, { Note: "from ada" }, ada);
    await fill(adaBot, "bot");
    const bobBefore = await tablesAccount.exportAccount(bob, deps(bob));
    const botBefore = await tablesAccount.exportAccount(adaBot, deps(adaBot));
    const listed = await tablesAccount.exportAccount(ada, deps(ada));
    const counts = await tablesAccount.eraseAccount(ada, deps(ada));
    expect(counts).toEqual({ bases: 1, tables: 1, views: 1, rows: 1, authored_rows: 1 });
    expect(counts).toEqual(Object.fromEntries(Object.entries(listed).map(([name, list]) => [name, list.length])));
    expect(Object.values(await tablesAccount.exportAccount(ada, deps(ada))).every((list) => list.length === 0)).toBe(true);
    expect(await tablesAccount.eraseAccount(ada, deps(ada))).toEqual({ bases: 0, tables: 0, views: 0, rows: 0, authored_rows: 0 });
    // Bob keeps his bases, tables, and views whole. Only the row that ada wrote in his base goes.
    expect(await tablesAccount.exportAccount(bob, deps(bob))).toEqual({ ...bobBefore, rows: bobBefore.rows.filter((r) => (r as { values: { Note: string } }).values.Note !== "from ada") });
    expect(await tablesAccount.exportAccount(adaBot, deps(adaBot))).toEqual(botBefore);
  });

  test("takes the grants of the erased base with it", async () => {
    const { base, table } = await fill(ada, "ada");
    await tablesAccount.eraseAccount(ada, deps(ada));
    expect((await sharing.can(ctxOf(ada), "read", base.id)).allowed).toBe(false);
    expect((await sharing.can(ctxOf(ada), "read", table.id)).allowed).toBe(false);
  });

  test("a legacy base stops the erase and nothing goes", async () => {
    const { base } = await fill(ada, "ada");
    await fill(ada, "second");
    const { ownerKind: _kind, ...legacy } = (await store.get("bases", base.id))!;
    await store.put("bases", base.id, legacy);
    await expect(tablesAccount.eraseAccount(ada, deps(ada))).rejects.toMatchObject({ code: "LEGACY_BASE" });
    expect(await tables.listBases()).toHaveLength(2);
  });

  test("leaves a base the subject gave away", async () => {
    const { base } = await fill(ada, "ada");
    await as(ada).grant("base", base.id, { kind: "human", id: "bob" }, "owner");
    await as(bob).revokeGrant("base", base.id, { kind: "human", id: "ada" });
    expect(await tablesAccount.eraseAccount(ada, deps(ada))).toMatchObject({ bases: 0 });
    expect((await tablesAccount.exportAccount(bob, deps(bob))).bases).toHaveLength(0); // bob is not the stored owner, so it is not his to export either
    expect(await tables.listBases()).toHaveLength(1);
  });
});
