// End to end: bases and field edits through the real CLI and the real MCP server, as child processes.
// Needs a build first (`npm run build`).
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

const cli = join(process.cwd(), "dist", "cli.js");
const dir = mkdtempSync(join(tmpdir(), "tables-parity-e2e-"));
const env = { ...process.env, AGENTIC_TABLES_DB: join(dir, "db.json"), AGENTIC_TABLES_ACTOR: "human:cli" } as Record<string, string>;
const run = (args: string[], extra: Record<string, string> = {}) => {
  const r = spawnSync("node", [cli, ...args], { env: { ...env, ...extra }, encoding: "utf8" });
  return { code: r.status, out: r.stdout, err: r.stderr };
};
const ok = (args: string[], extra?: Record<string, string>) => {
  const r = run(args, extra);
  expect(r.err).toBe("");
  expect(r.code).toBe(0);
  return JSON.parse(r.out) as any;
};
async function mcp<T>(fn: (call: (name: string, args?: Record<string, unknown>) => Promise<{ isError: boolean; body: any }>) => Promise<T>, extra: Record<string, string> = {}): Promise<T> {
  const client = new Client({ name: "e2e-parity", version: "0.0.0" });
  await client.connect(new StdioClientTransport({ command: "node", args: [cli, "mcp"], env: { ...env, AGENTIC_TABLES_ACTOR: "human:cli", ...extra } }));
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

describe("help", () => {
  test("lists the new commands", () => {
    const help = run(["--help"]).out;
    for (const word of ["bases", "new-base", "delete-base", "rename-field", "delete-field", "change-type"]) expect(help).toMatch(new RegExp(`^  ${word} `, "m"));
  });
});

describe("bases over the CLI", () => {
  test("creates, lists, works inside, and deletes a base", () => {
    const base = ok(["new-base", "Sales"]);
    expect(base).toMatchObject({ name: "Sales", ownerId: "cli" });
    expect(ok(["bases"]).map((b: any) => b.name)).toContain("Sales");
    const inBase = { AGENTIC_TABLES_BASE: base.id };
    ok(["new", "Leads", "--field", "Name:text"], inBase);
    const refused = run(["delete-base", base.id]);
    expect(refused.code).toBe(2);
    expect(ok(["bases"]).map((b: any) => b.id)).toContain(base.id);
    expect(ok(["delete-base", base.id, "--yes"])).toEqual({ tables: 1, rows: 0, views: 0 });
    expect(ok(["bases"]).map((b: any) => b.id)).not.toContain(base.id);
    expect(run(["delete-base", base.id, "--yes"]).code).toBe(1);
    expect(run(["delete-base"]).code).toBe(2);
  });

  test("change-type refuses a flag the target type ignores", () => {
    ok(["new", "Tags", "--field", "Label:text"]);
    expect(run(["change-type", "Tags", "Label", "--to", "number", "--options", "a|b"]).code).toBe(2);
    expect(run(["change-type", "Tags", "Label", "--to", "text", "--link-table", "Tags"]).code).toBe(2);
    expect(ok(["schema", "Tags"]).fields[0].type).toBe("text");
  });

  test("a viewer cannot delete a base", () => {
    const base = ok(["new-base", "Shared"]);
    ok(["share", "eve", "viewer", "--kind", "human"], { AGENTIC_TABLES_BASE: base.id });
    const res = run(["delete-base", base.id, "--yes"], { AGENTIC_TABLES_ACTOR: "human:eve" });
    expect(res.code).toBe(1);
    expect(JSON.parse(res.err).error.code).toBe("FORBIDDEN");
    expect(ok(["bases"]).map((b: any) => b.id)).toContain(base.id);
  });
});

describe("field edits over the CLI", () => {
  test("renames, converts, and deletes fields", () => {
    ok(["new", "People", "--field", "Name:text", "--field", "Age:text"]);
    ok(["insert", "People", "--json", '[{"Name":"Ada","Age":"36"},{"Name":"Bob","Age":"old"}]']);
    expect(ok(["rename-field", "People", "Name", "Full name"]).fields.map((f: any) => f.name)).toEqual(["Full name", "Age"]);
    expect(run(["rename-field", "People", "Age"]).code).toBe(2);
    expect(run(["rename-field", "People", "Nope", "X"]).code).toBe(1);

    expect(run(["change-type", "People", "Age"]).code).toBe(2);
    const blocked = run(["change-type", "People", "Age", "--to", "number"]);
    expect(blocked.code).toBe(1);
    expect(JSON.parse(blocked.err).error).toMatchObject({ code: "MIGRATION_ABORTED" });
    expect(ok(["change-type", "People", "Age", "--to", "number", "--dry-run"])).toMatchObject({ applied: false });
    expect(ok(["schema", "People"]).fields[1].type).toBe("text");
    expect(run(["change-type", "People", "Age", "--to", "number", "--on-failure", "clear"]).code).toBe(2);
    expect(ok(["change-type", "People", "Age", "--to", "number", "--on-failure", "clear", "--yes"])).toMatchObject({ applied: true });
    expect(ok(["query", "People", "--sort", "Full name"]).items.map((r: any) => r.values.Age)).toEqual([36, null]);

    expect(run(["delete-field", "People", "Age"]).code).toBe(2);
    expect(ok(["schema", "People"]).fields).toHaveLength(2);
    expect(ok(["delete-field", "People", "Age", "--yes"]).fields.map((f: any) => f.name)).toEqual(["Full name"]);
    expect(ok(["query", "People"]).items[0].values).toEqual({ "Full name": "Ada" });
  });
});

describe("the work base", () => {
  // Each test uses its own database file, so the actor owns no base at the start.
  const fresh = () => ({ AGENTIC_TABLES_DB: join(dir, `work-${Math.random().toString(36).slice(2)}.json`) });
  const tableNames = (extra: Record<string, string>, baseId: string) => ok(["list"], { ...extra, AGENTIC_TABLES_BASE: baseId }).map((t: any) => t.name);

  test("the first base an actor makes is its work base", () => {
    const db = fresh();
    const sales = ok(["new-base", "Sales"], db);
    ok(["new", "Leads", "--field", "Name:text"], db);
    expect(tableNames(db, sales.id)).toEqual(["Leads"]);
    expect(ok(["bases"], db)).toHaveLength(1);
  });

  test("a later base is not the work base until AGENTIC_TABLES_BASE names it", () => {
    const db = fresh();
    ok(["new", "First", "--field", "Name:text"], db);
    const [first] = ok(["bases"], db);
    const second = ok(["new-base", "Second"], db);
    ok(["new", "Second table", "--field", "Name:text"], db);
    expect(tableNames(db, first.id)).toEqual(["First", "Second table"]);
    expect(tableNames(db, second.id)).toEqual([]);
  });

  test("after the work base is deleted, the next oldest base is the work base", () => {
    const db = fresh();
    ok(["new", "First", "--field", "Name:text"], db);
    const [first] = ok(["bases"], db);
    const second = ok(["new-base", "Second"], db);
    ok(["delete-base", first.id, "--yes"], db);
    ok(["new", "After", "--field", "Name:text"], db);
    expect(tableNames(db, second.id)).toEqual(["After"]);
    const named = run(["list"], { ...db, AGENTIC_TABLES_BASE: first.id });
    expect(named.code).toBe(1);
    expect(JSON.parse(named.err).error.code).toBe("NOT_FOUND");
  });
});

describe("bases and field edits over MCP", () => {
  test("a viewer is refused", async () => {
    const base = ok(["new-base", "Guarded"]);
    ok(["share", "eve", "viewer", "--kind", "human"], { AGENTIC_TABLES_BASE: base.id });
    await mcp(async (call) => {
      const refused = await call("delete_base", { baseId: base.id });
      expect(refused.isError).toBe(true);
      expect(refused.body.code).toBe("FORBIDDEN");
    }, { AGENTIC_TABLES_ACTOR: "human:eve", AGENTIC_TABLES_BASE: base.id });
    expect(ok(["bases"]).map((b: any) => b.id)).toContain(base.id);
  });

  test("runs the same operations and reports failures as errors", async () => {
    const db = { AGENTIC_TABLES_DB: join(dir, "mcp-ops.json") };
    await mcp(async (call) => {
      // The actor owns no base yet, so a table made first goes into its own work base, and Ops stays empty.
      await call("create_table", { name: "Seed", fields: [] });
      const made = await call("create_base", { name: "Ops" });
      expect(made.body).toMatchObject({ name: "Ops" });
      expect((await call("list_bases")).body.map((b: any) => b.name)).toContain("Ops");

      await call("create_table", { name: "Items", fields: [{ name: "Title", type: "text" }, { name: "Qty", type: "text" }] });
      await call("insert_rows", { table: "Items", rows: [{ Title: "bolt", Qty: "3" }, { Title: "nut", Qty: "many" }] });
      expect((await call("rename_field", { table: "Items", field: "Title", name: "Item" })).body.fields.map((f: any) => f.name)).toEqual(["Item", "Qty"]);

      const blocked = await call("change_field_type", { table: "Items", field: "Qty", to: "number" });
      expect(blocked.isError).toBe(true);
      expect(blocked.body.code).toBe("MIGRATION_ABORTED");
      expect((await call("change_field_type", { table: "Items", field: "Qty", to: "number", dryRun: true })).body).toMatchObject({ applied: false });
      expect((await call("change_field_type", { table: "Items", field: "Qty", to: "number", onFailure: "clear" })).body).toMatchObject({ applied: true });
      expect((await call("query_rows", { table: "Items", sort: { field: "Item" } })).body.items.map((r: any) => r.values.Qty)).toEqual([3, null]);

      expect((await call("delete_field", { table: "Items", field: "Qty" })).body.fields.map((f: any) => f.name)).toEqual(["Item"]);
      const gone = await call("delete_field", { table: "Items", field: "Qty" });
      expect(gone.isError).toBe(true);

      // create_base does not switch the work base, so Ops is empty.
      const bases = (await call("list_bases")).body as { id: string; name: string }[];
      const ops = bases.find((b) => b.name === "Ops")!;
      expect((await call("delete_base", { baseId: ops.id })).body).toEqual({ tables: 0, rows: 0, views: 0 });
      expect((await call("list_bases")).body.map((b: any) => b.id)).not.toContain(ops.id);
      expect((await call("delete_base", { baseId: ops.id })).isError).toBe(true);
    }, db);
  });
});
