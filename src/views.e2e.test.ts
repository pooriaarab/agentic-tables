// End to end: views and CSV import through the real CLI and the real MCP server, as child processes.
// Needs a build first (`npm run build`).
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

const cli = join(process.cwd(), "dist", "cli.js");
const dir = mkdtempSync(join(tmpdir(), "tables-views-e2e-"));
let n = 0;
/** A database file of its own, so a test owns no base at the start. */
const fresh = () => ({ AGENTIC_TABLES_DB: join(dir, `db-${n++}.json`), AGENTIC_TABLES_ACTOR: "human:cli" });
const run = (db: Record<string, string>, args: string[]) => {
  const r = spawnSync("node", [cli, ...args], { env: { ...process.env, ...db }, encoding: "utf8" });
  return { code: r.status, out: r.stdout, err: r.stderr };
};
const ok = (db: Record<string, string>, args: string[]) => {
  const r = run(db, args);
  expect(r.err).toBe("");
  expect(r.code).toBe(0);
  return JSON.parse(r.out) as any;
};
async function mcp<T>(db: Record<string, string>, fn: (call: (name: string, args?: Record<string, unknown>) => Promise<{ isError: boolean; body: any }>) => Promise<T>): Promise<T> {
  const client = new Client({ name: "e2e-views", version: "0.0.0" });
  await client.connect(new StdioClientTransport({ command: "node", args: [cli, "mcp"], env: { ...process.env, ...db } as Record<string, string> }));
  try {
    return await fn(async (name, args = {}) => {
      const res = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
      return { isError: res.isError === true, body: JSON.parse(res.content[0]!.text) };
    });
  } finally {
    await client.close();
  }
}

beforeAll(() => {
  if (!existsSync(cli)) throw new Error("dist/cli.js is missing. Run `npm run build` first.");
});
afterAll(() => rmSync(dir, { recursive: true }));

const seed = (db: Record<string, string>) => {
  ok(db, ["new", "Deals", "--field", "Name:text!", "--field", "Amount:number", "--field", "Stage:single_select=lead|won"]);
  ok(db, ["insert", "Deals", "--json", '[{"Name":"a","Amount":5,"Stage":"won"},{"Name":"b","Amount":50,"Stage":"lead"},{"Name":"c","Amount":500,"Stage":"won"}]']);
};

describe("views over the CLI", () => {
  test("help lists the commands", () => {
    const help = run(fresh(), ["--help"]).out;
    for (const word of ["views", "new-view", "view", "delete-view"]) expect(help).toMatch(new RegExp(`^  ${word} `, "m"));
  });

  test("creates, lists, runs, and deletes a grid and a board", () => {
    const db = fresh();
    seed(db);
    const grid = ok(db, ["new-view", "Deals", "Big", "--kind", "grid", "--filter", '{"field":"Amount","op":"gt","value":10}', "--sort", "Amount:desc"]);
    expect(grid).toMatchObject({ name: "Big", kind: "grid" });
    const typo = run(db, ["new-view", "Deals", "Typo", "--kind", "grid", "--sort", "Amount:dsc"]);
    expect(typo.code).not.toBe(0);
    expect(JSON.parse(typo.err).error).toMatchObject({ code: "VALIDATION_FAILED", issues: [{ field: "direction" }] });
    expect(run(db, ["new-view", "Deals", "NoField", "--kind", "grid", "--sort", ":desc"]).code).toBe(2);
    expect(run(db, ["new-view", "Deals", "Extra", "--kind", "grid", "--sort", "Amount:desc:junk"]).code).toBe(2);
    for (const filter of ["null", "false", "0", '"x"']) {
        const refused = run(db, ["new-view", "Deals", "Bad", "--kind", "grid", "--filter", filter]);
        expect(refused.code).not.toBe(0);
        expect(JSON.parse(refused.err).error.code).toBe("VALIDATION_FAILED");
    }
    expect(ok(db, ["views", "Deals"]).map((v: any) => v.name)).toEqual(["Big"]);
    const board = ok(db, ["new-view", "Deals", "By stage", "--kind", "board", "--group-by", "Stage"]);
    expect(ok(db, ["views", "Deals"]).map((v: any) => v.name)).toEqual(["Big", "By stage"]);

    const big = ok(db, ["view", grid.id]);
    expect(big.items.map((r: any) => r.values.Name)).toEqual(["c", "b"]);
    expect(ok(db, ["view", grid.id, "--limit", "1"]).items).toHaveLength(1);
    const groups = ok(db, ["view", board.id]);
    expect(groups.kind).toBe("board");
    expect(groups.groups.map((g: any) => [g.value, g.count])).toEqual(expect.arrayContaining([["won", 2], ["lead", 1]]));

    expect(run(db, ["delete-view", grid.id]).code).toBe(2);
    expect(ok(db, ["views", "Deals"])).toHaveLength(2);
    expect(ok(db, ["delete-view", grid.id, "--yes"])).toEqual({ deleted: grid.id });
    expect(ok(db, ["views", "Deals"]).map((v: any) => v.name)).toEqual(["By stage"]);
    expect(ok(db, ["query", "Deals"]).items).toHaveLength(3);
    expect(run(db, ["view", grid.id]).code).toBe(1);
  });

  test("refuses a bad view", () => {
    const db = fresh();
    seed(db);
    expect(run(db, ["new-view", "Deals", "X"]).code).toBe(2);
    expect(run(db, ["new-view", "Deals", "X", "--kind", "cards"]).code).toBe(2);
    const board = run(db, ["new-view", "Deals", "X", "--kind", "board", "--group-by", "Name"]);
    expect(board.code).toBe(1);
    expect(JSON.parse(board.err).error.code).toBe("VALIDATION_FAILED");
    const filter = run(db, ["new-view", "Deals", "X", "--kind", "grid", "--filter", '{"field":"Nope","op":"eq","value":1}']);
    expect(filter.code).toBe(1);
    expect(ok(db, ["views", "Deals"])).toEqual([]);
  });

  test("a viewer reads a view and cannot delete it", () => {
    const db = fresh();
    seed(db);
    const view = ok(db, ["new-view", "Deals", "All", "--kind", "grid"]);
    const base = ok(db, ["bases"])[0].id;
    ok({ ...db, AGENTIC_TABLES_BASE: base }, ["share", "eve", "viewer", "--kind", "human"]);
    const eve = { ...db, AGENTIC_TABLES_ACTOR: "human:eve", AGENTIC_TABLES_BASE: base };
    expect(ok(eve, ["view", view.id]).items).toHaveLength(3);
    const refused = run(eve, ["delete-view", view.id, "--yes"]);
    expect(refused.code).toBe(1);
    expect(JSON.parse(refused.err).error.code).toBe("FORBIDDEN");
    expect(ok(db, ["views", "Deals"])).toHaveLength(1);
  });
});

describe("views and CSV import over MCP", () => {
  test("runs the same view operations", async () => {
    const db = fresh();
    seed(db);
    await mcp(db, async (call) => {
      const grid = (await call("create_view", { table: "Deals", name: "Big", kind: "grid", filter: { field: "Amount", op: "gt", value: 10 }, sort: { field: "Amount", direction: "desc" } })).body;
      expect(grid).toMatchObject({ name: "Big", kind: "grid" });
      const board = (await call("create_view", { table: "Deals", name: "By stage", kind: "board", groupBy: "Stage" })).body;
      expect((await call("list_views", { table: "Deals" })).body.map((v: any) => v.name)).toEqual(["Big", "By stage"]);
      expect((await call("run_view", { viewId: grid.id })).body.items.map((r: any) => r.values.Name)).toEqual(["c", "b"]);
      expect((await call("run_view", { viewId: board.id })).body.kind).toBe("board");

      const nullFilter = await call("create_view", { table: "Deals", name: "X", kind: "grid", filter: null });
      expect(nullFilter.body.code).toBe("VALIDATION_FAILED");
      const bad = await call("create_view", { table: "Deals", name: "X", kind: "board", groupBy: "Name" });
      expect(bad.isError).toBe(true);
      expect(bad.body.code).toBe("VALIDATION_FAILED");

      expect((await call("delete_view", { viewId: grid.id })).body).toEqual({ deleted: grid.id });
      expect((await call("run_view", { viewId: grid.id })).isError).toBe(true);
      expect((await call("list_views", { table: "Deals" })).body).toHaveLength(1);
    });
  });

  test("imports CSV text, all or nothing", async () => {
    const db = fresh();
    await mcp(db, async (call) => {
      const made = await call("import_csv", { table: "Parts", csv: "Item,Qty,Done\nbolt,3,true\nnut,5,false\n", create: true });
      expect(made.body).toMatchObject({ inserted: 2, table: { fields: [{ type: "text" }, { type: "number" }, { type: "checkbox" }] } });
      const bad = await call("import_csv", { table: "Parts", csv: "Item,Qty,Done\nscrew,1,true\nwasher,many,false\n" });
      expect(bad.isError).toBe(true);
      expect(bad.body.issues[0].field).toBe("line 3: Qty");
      expect((await call("query_rows", { table: "Parts" })).body.items).toHaveLength(2);
      const missing = await call("import_csv", { table: "Nope", csv: "A\n1\n" });
      expect(missing.isError).toBe(true);
      expect(missing.body.code).toBe("NOT_FOUND");
      expect((await call("import_csv", { table: "Parts", csv: "" })).isError).toBe(true);
      const big = await call("import_csv", { table: "Parts", csv: `Item,Qty,Done\n${"x,1,true\n".repeat(501)}` });
      expect(big.isError).toBe(true);
      expect(big.body.code).toBe("PAYLOAD_TOO_LARGE");
      const wide = await call("import_csv", { table: "Parts", csv: `Item\n${"€".repeat(350_000)}\n` });
      expect(wide.isError).toBe(true);
      expect(wide.body.code).toBe("PAYLOAD_TOO_LARGE");
      expect((await call("query_rows", { table: "Parts" })).body.items).toHaveLength(2);
    });
  });

  test("a viewer reads views over MCP and cannot change them or import", async () => {
    const db = fresh();
    seed(db);
    const base = ok(db, ["bases"])[0].id;
    ok({ ...db, AGENTIC_TABLES_BASE: base }, ["share", "eve", "viewer", "--kind", "human"]);
    const view = ok(db, ["new-view", "Deals", "Big", "--kind", "grid"]);
    const eve = { ...db, AGENTIC_TABLES_ACTOR: "human:eve", AGENTIC_TABLES_BASE: base };
    await mcp(eve, async (call) => {
      expect((await call("run_view", { viewId: view.id })).isError).toBe(false);
      const attempts: [string, Record<string, unknown>][] = [
        ["create_view", { table: "Deals", name: "X", kind: "grid" }],
        ["delete_view", { viewId: view.id }],
        ["import_csv", { table: "Deals", csv: "Name\nz\n" }],
        ["import_csv", { table: "Nope", csv: "A\n1\n", create: true }],
      ];
      for (const [name, args] of attempts) {
        const refused = await call(name, args);
        expect(refused.isError).toBe(true);
        expect(refused.body.code).toBe("FORBIDDEN");
      }
    });
    expect(ok(db, ["views", "Deals"])).toHaveLength(1);
    expect(ok(db, ["query", "Deals"]).items).toHaveLength(3);
  });

  test("the CLI import still works from a file", () => {
    const db = fresh();
    writeFileSync(join(dir, "in.csv"), "Item,Qty\nbolt,3\n");
    expect(ok(db, ["import", "Parts", "--file", join(dir, "in.csv"), "--create"])).toMatchObject({ inserted: 1 });
    expect(run(db, ["import", "Parts"]).code).toBe(2);
  });
});
