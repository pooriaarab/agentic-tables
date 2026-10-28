// End to end: the real CLI and the real MCP server, as child processes over
// stdio. Needs a build first (`npm run build`). `npm run ci:local` does both.
// The run writes a JSON record of each step to $TMPDIR/agentic-tables-e2e.json.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

const cli = join(process.cwd(), "dist", "cli.js");
const dir = mkdtempSync(join(tmpdir(), "tables-e2e-"));
const env = { ...process.env, AGENTIC_TABLES_DB: join(dir, "db.json") };
const steps: { step: string; ok: boolean }[] = [];

const run = (args: string[], actor = "human:cli") => {
  const result = spawnSync("node", [cli, ...args], { env: { ...env, AGENTIC_TABLES_ACTOR: actor }, encoding: "utf8" });
  return { code: result.status, out: result.stdout, err: result.stderr };
};
const ok = (args: string[], actor?: string) => {
  const r = run(args, actor);
  steps.push({ step: args.join(" ").slice(0, 60), ok: r.code === 0 });
  expect(r.err).toBe("");
  expect(r.code).toBe(0);
  return JSON.parse(r.out) as any;
};

beforeAll(() => {
  if (!existsSync(cli)) throw new Error("dist/cli.js is missing. Run `npm run build` first.");
});
afterAll(() => {
  writeFileSync(join(tmpdir(), "agentic-tables-e2e.json"), JSON.stringify(steps, null, 2));
  rmSync(dir, { recursive: true });
});

describe("cli", () => {
  test("creates, writes, rejects, queries, imports, and exports across processes", () => {
    const table = ok(["new", "People", "--field", "Name:text!", "--field", "Age:number", "--field", "Stage:single_select=lead|won"]);
    expect(table.fields.map((f: any) => f.name)).toEqual(["Name", "Age", "Stage"]);
    expect(ok(["schema", "People"]).fields[0]).toMatchObject({ name: "Name", required: true });

    const row = ok(["insert", "People", "--json", '{"Name":"Ada","Age":36,"Stage":"won"}'], "agent:claude");
    expect(row.createdBy).toEqual({ id: "claude", kind: "agent" });
    ok(["insert", "People", "--json", '{"Name":"Bob","Age":20,"Stage":"lead"}']);

    const bad = run(["insert", "People", "--json", '{"Name":"Cy","Age":"old"}']);
    expect(bad.code).toBe(1);
    expect(JSON.parse(bad.err).error).toMatchObject({ code: "VALIDATION_FAILED", issues: [{ field: "Age", code: "type" }] });
    expect(run(["add-field", "People", "--field", "Owner:text!"]).code).toBe(1);

    const upd = ok(["update", "People", row.id, "--json", '{"Age":37}'], "human:me");
    expect(upd).toMatchObject({ values: { Age: 37 }, createdBy: { kind: "agent" }, updatedBy: { id: "me", kind: "human" } });

    const q = ok(["query", "People", "--filter", '{"field":"Age","op":"gt","value":30}', "--sort", "Name:desc"]);
    expect(q.items.map((r: any) => r.values.Name)).toEqual(["Ada"]);

    const csv = run(["export", "People"]);
    expect(csv.out).toBe("Name,Age,Stage\nAda,37,won\nBob,20,lead\n");

    writeFileSync(join(dir, "in.csv"), "Item,Qty,Done\nbolt,3,true\nnut,5,false\n");
    const imported = ok(["import", "Parts", "--file", join(dir, "in.csv"), "--create"]);
    expect(imported).toMatchObject({ inserted: 2, table: { fields: [{ type: "text" }, { type: "number" }, { type: "checkbox" }] } });
    writeFileSync(join(dir, "bad.csv"), "Item,Qty,Done\nbolt,3,true\nnut,many,false\n");
    const badImport = run(["import", "Parts", "--file", join(dir, "bad.csv")]);
    expect(badImport.code).toBe(1);
    expect(JSON.parse(badImport.err).error.issues[0].field).toBe("line 3: Qty");
    expect(ok(["query", "Parts"]).items).toHaveLength(2);
    expect(run(["frobnicate"]).code).toBe(2);
  });
});

describe("mcp", () => {
  test("describes the schema and does typed row CRUD over stdio", async () => {
    const client = new Client({ name: "e2e", version: "0.0.0" });
    await client.connect(new StdioClientTransport({ command: "node", args: [cli, "mcp"], env: { ...env, AGENTIC_TABLES_ACTOR: "agent:e2e" } as Record<string, string> }));
    try {
      const names = (await client.listTools()).tools.map((t) => t.name);
      expect(names).toEqual(expect.arrayContaining(["list_tables", "describe_table", "create_table", "add_field", "insert_rows", "update_row", "delete_row", "get_row", "query_rows"]));
      const call = async (name: string, args: Record<string, unknown>) => {
        const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
        steps.push({ step: `mcp ${name}`, ok: !r.isError });
        return { isError: r.isError === true, body: JSON.parse(r.content[0]!.text) };
      };
      // The CLI test already made People in this database.
      const described = await call("describe_table", { table: "People" });
      expect(described.body.fields.find((f: any) => f.name === "Stage")).toMatchObject({ type: "single_select", options: ["lead", "won"], operators: expect.arrayContaining(["eq", "in"]) });

      const inserted = await call("insert_rows", { table: "People", rows: [{ Name: "Di", Age: 41, Stage: "lead" }] });
      expect(inserted.body.rows[0].createdBy).toEqual({ id: "e2e", kind: "agent" });
      const rejected = await call("insert_rows", { table: "People", rows: [{ Name: "Ok" }, { Name: "Bad", Stage: "lost" }] });
      expect(rejected.isError).toBe(true);
      expect(rejected.body.issues[0]).toMatchObject({ field: "row 2.Stage", code: "option" });

      const id = inserted.body.rows[0].id;
      expect((await call("update_row", { rowId: id, values: { Age: 42 } })).body.values.Age).toBe(42);
      const found = await call("query_rows", { table: "People", filter: { field: "Age", op: "gte", value: 42 } });
      expect(found.body.items.map((r: any) => r.values.Name)).toEqual(["Di"]);
      expect((await call("get_row", { rowId: id })).body.values.Name).toBe("Di");
      expect((await call("delete_row", { rowId: id })).isError).toBe(false);
      expect((await call("get_row", { rowId: id })).isError).toBe(true);
      expect((await call("query_rows", { table: "People", filter: { field: "Nope", op: "eq", value: 1 } })).isError).toBe(true);
    } finally {
      await client.close();
    }
  });
});
