// End to end: the real CLI and the real MCP server, as child processes over
// stdio. Needs a build first (`npm run build`). `npm run ci:local` does both.
// The run writes a JSON record of each step to $TMPDIR/agentic-tables-e2e.json.
import { execFile, execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

const cli = join(process.cwd(), "dist", "cli.js");
const dir = mkdtempSync(join(tmpdir(), "tables-e2e-"));
const env = { ...process.env, AGENTIC_TABLES_DB: join(dir, "db.json") };
const steps: { step: string; ok: boolean }[] = [];

// Each actor has its own default base. The tests that mix actors on one table name the base of human:cli.
let sharedBase: string | undefined;
const run = (args: string[], actor = "human:cli") => {
  const result = spawnSync("node", [cli, ...args], { env: { ...env, AGENTIC_TABLES_ACTOR: actor, ...(sharedBase ? { AGENTIC_TABLES_BASE: sharedBase } : {}) }, encoding: "utf8" });
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
    sharedBase = ok(["export-data"]).bases[0].base.id;
    // The other actors in this test write into this base, so the owner shares it with them.
    ok(["share", "claude", "editor"]);
    ok(["share", "me", "editor"]);
    ok(["share", "e2e", "editor"]);
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

describe("required and delete over the CLI", () => {
  test("lists blocking rows, applies, and deletes only with --yes", () => {
    ok(["new", "Notes", "--field", "Title:text", "--field", "Body:text"]);
    ok(["insert", "Notes", "--json", '[{"Title":"a","Body":"x"},{"Title":"b"}]']);
    const blocked = run(["required", "Notes", "Body", "true"]);
    expect(blocked.code).toBe(1);
    expect(JSON.parse(blocked.err).error).toMatchObject({ code: "MIGRATION_ABORTED", report: { failures: [{ reason: "has no value" }] } });
    expect(ok(["required", "Notes", "Body", "true", "--dry-run"])).toMatchObject({ applied: false });
    expect(ok(["required", "Notes", "Title", "true"])).toMatchObject({ applied: true });
    expect(run(["required", "Notes", "Title", "maybe"]).code).toBe(2);
    expect(run(["delete-table", "Notes"]).code).toBe(2);
    expect(ok(["query", "Notes"]).items).toHaveLength(2);
    expect(ok(["delete-table", "Notes", "--yes"])).toEqual({ rows: 2, views: 0 });
    expect(run(["schema", "Notes"]).code).toBe(1);
  });
});

describe("data rights over the CLI and MCP", () => {
  test("exports and erases only what the actor owns", async () => {
    const dir2 = mkdtempSync(join(tmpdir(), "tables-gdpr-e2e-"));
    const env2 = { ...process.env, AGENTIC_TABLES_DB: join(dir2, "db.json") } as Record<string, string>;
    const cli2 = (args: string[], actor: string) => spawnSync("node", [cli, ...args], { env: { ...env2, AGENTIC_TABLES_ACTOR: actor }, encoding: "utf8" });
    try {
      expect(cli2(["new", "Mine", "--field", "Note:text"], "human:ada").status).toBe(0);
      expect(cli2(["insert", "Mine", "--json", '{"Note":"ada-secret"}'], "human:ada").status).toBe(0);
      const other = cli2(["export-data"], "human:eve");
      expect(JSON.parse(other.stdout).bases).toEqual([]);
      const own = JSON.parse(cli2(["export-data"], "human:ada").stdout);
      expect(own.bases[0].rows[0].values.Note).toBe("ada-secret");
      steps.push({ step: "cli export-data", ok: true });

      const refused = cli2(["erase-data"], "human:ada");
      expect(refused.status).toBe(2);
      expect(JSON.parse(cli2(["erase-data", "--yes"], "human:eve").stdout)).toEqual({ bases: 0, tables: 0, rows: 0, views: 0, authoredRows: 0 });
      expect(cli2(["export-data"], "human:ada").stdout).toContain("ada-secret");

      const client = new Client({ name: "e2e-gdpr", version: "0.0.0" });
      await client.connect(new StdioClientTransport({ command: "node", args: [cli, "mcp"], env: { ...env2, AGENTIC_TABLES_ACTOR: "human:ada" } }));
      try {
        const exported = (await client.callTool({ name: "export_my_data", arguments: {} })) as { content: { text: string }[] };
        expect(JSON.parse(exported.content[0]!.text).bases).toHaveLength(1);
        const erased = (await client.callTool({ name: "erase_my_data", arguments: {} })) as { content: { text: string }[] };
        expect(JSON.parse(erased.content[0]!.text)).toEqual({ bases: 1, tables: 1, rows: 1, views: 0, authoredRows: 0 });
        steps.push({ step: "mcp export_my_data and erase_my_data", ok: true });
      } finally {
        await client.close();
      }
      expect(readFileSync(join(dir2, "db.json"), "utf8")).not.toContain("ada-secret");
    } finally {
      rmSync(dir2, { recursive: true, force: true });
    }
  }, 60_000);
});

describe("data rights across two principals", () => {
  test("erase removes only the data of the principal that asks, and counts it", async () => {
    const dir3 = mkdtempSync(join(tmpdir(), "tables-two-actors-"));
    const env3 = { ...process.env, AGENTIC_TABLES_DB: join(dir3, "db.json") } as Record<string, string>;
    const cli3 = (args: string[], extra: Record<string, string> = {}) =>
      JSON.parse(execFileSync("node", [cli, ...args], { env: { ...env3, AGENTIC_TABLES_ACTOR: "human:cli", ...extra }, encoding: "utf8" })) as any;
    const mcp = async <T>(extra: Record<string, string>, fn: (call: (name: string, args?: Record<string, unknown>) => Promise<any>) => Promise<T>): Promise<T> => {
      const client = new Client({ name: "e2e-two", version: "0.0.0" });
      await client.connect(new StdioClientTransport({ command: "node", args: [cli, "mcp"], env: { ...env3, AGENTIC_TABLES_ACTOR: "agent:mcp", ...extra } }));
      try {
        return await fn(async (name, args = {}) => JSON.parse(((await client.callTool({ name, arguments: args })) as { content: { text: string }[] }).content[0]!.text));
      } finally {
        await client.close();
      }
    };
    try {
      // The human makes a table and a row in the human's default base.
      cli3(["new", "People", "--field", "Name:text"]);
      cli3(["insert", "People", "--json", '{"Name":"cli-secret"}']);
      const humanBase = cli3(["export-data"]).bases[0].base.id as string;

      // The agent does not see the human's table. It gets its own default base.
      await mcp({}, async (call) => {
        expect(await call("list_tables")).toEqual([]);
        await call("create_table", { name: "Notes", fields: [{ name: "Body", type: "text" }] });
        await call("insert_rows", { table: "Notes", rows: [{ Body: "mcp-secret" }] });
      });
      // The human shares the base with the agent as an editor. The agent then writes one row into it, by naming that base.
      cli3(["share", "mcp", "editor"]);
      await mcp({ AGENTIC_TABLES_BASE: humanBase }, async (call) => {
        await call("insert_rows", { table: "People", rows: [{ Name: "mcp-in-human-base" }] });
      });

      // Export for each principal. Each holds its own base, and the agent also holds its row in the human's base.
      const humanExport = cli3(["export-data"]);
      expect(humanExport.bases).toHaveLength(1);
      expect(humanExport.bases[0].rows.map((r: any) => r.values.Name).sort()).toEqual(["cli-secret", "mcp-in-human-base"]);
      expect(humanExport.authoredRows).toEqual([]);
      const agentExport = await mcp({}, (call) => call("export_my_data"));
      expect(agentExport.bases).toHaveLength(1);
      expect(agentExport.bases[0].rows.map((r: any) => r.values.Body)).toEqual(["mcp-secret"]);
      expect(agentExport.authoredRows.map((r: any) => r.values.Name)).toEqual(["mcp-in-human-base"]);

      // The agent erases. Its base and its row in the human's base go. The human's own row stays.
      const erased = await mcp({}, (call) => call("erase_my_data"));
      expect(erased).toEqual({ bases: 1, tables: 1, rows: 1, views: 0, authoredRows: 1 });
      const after = cli3(["export-data"]);
      expect(after.bases[0].rows.map((r: any) => r.values.Name)).toEqual(["cli-secret"]);
      const dump = readFileSync(join(dir3, "db.json"), "utf8");
      expect(dump).not.toContain("mcp-secret");
      expect(dump).not.toContain("mcp-in-human-base");
      expect(dump).toContain("cli-secret");
      expect(await mcp({}, (call) => call("erase_my_data"))).toEqual({ bases: 0, tables: 0, rows: 0, views: 0, authoredRows: 0 });

      // The human erases. Everything of the human goes, and the counts match.
      expect(cli3(["erase-data", "--yes"])).toEqual({ bases: 1, tables: 1, rows: 1, views: 0, authoredRows: 0 });
      expect(readFileSync(join(dir3, "db.json"), "utf8")).not.toContain("cli-secret");
      steps.push({ step: "two principals: export and erase", ok: true });
    } finally {
      rmSync(dir3, { recursive: true, force: true });
    }
  }, 90_000);
});

describe("roles over the CLI and MCP", () => {
  test("a viewer cannot write, a stranger sees nothing, and an agent acts with its owner's role cut down by its scopes", async () => {
    const dir4 = mkdtempSync(join(tmpdir(), "tables-roles-"));
    const env4 = { ...process.env, AGENTIC_TABLES_DB: join(dir4, "db.json") } as Record<string, string>;
    const cli4 = (args: string[], extra: Record<string, string>) => {
      const r = spawnSync("node", [cli, ...args], { env: { ...env4, ...extra }, encoding: "utf8" });
      steps.push({ step: `roles ${args[0]}`, ok: r.status === 0 });
      return { code: r.status, out: r.stdout ? JSON.parse(r.stdout) : undefined, err: r.stderr ? JSON.parse(r.stderr.split("\n")[0]!) : undefined };
    };
    const owner = { AGENTIC_TABLES_ACTOR: "human:owen" };
    try {
      cli4(["new", "Notes", "--field", "Body:text"], owner);
      const base = cli4(["export-data"], owner).out.bases[0].base.id as string;
      cli4(["insert", "Notes", "--json", '{"Body":"first"}'], owner);
      // A base made by this version is not a base from an earlier one, so there is nothing to claim.
      expect(cli4(["claim-base", base], owner).err.error.code).toBe("NOT_FOUND");
      expect(cli4(["share", "vera", "viewer"], owner).code).toBe(0);
      const viewer = { AGENTIC_TABLES_ACTOR: "agent:vera", AGENTIC_TABLES_BASE: base };
      const stranger = { AGENTIC_TABLES_ACTOR: "agent:sam", AGENTIC_TABLES_BASE: base };

      // CLI: the viewer reads and cannot write or share. The stranger gets not found.
      expect(cli4(["query", "Notes"], viewer).out.items).toHaveLength(1);
      const denied = cli4(["insert", "Notes", "--json", '{"Body":"viewer was here"}'], viewer);
      expect([denied.code, denied.err.error.code]).toEqual([1, "FORBIDDEN"]);
      expect(cli4(["share", "sam", "editor"], viewer).err.error.code).toBe("FORBIDDEN");
      expect(cli4(["add-field", "Notes", "--field", "X:text"], viewer).err.error.code).toBe("FORBIDDEN");
      expect(cli4(["query", "Notes"], stranger).err.error.code).toBe("NOT_FOUND");
      expect(cli4(["query", "Notes"], owner).out.items).toHaveLength(1);

      // An agent of the owner acts with the owner's role. A narrow scope cuts it down. It cannot export the owner's data.
      const agent = { AGENTIC_TABLES_ACTOR: "agent_of_human:bot", AGENTIC_TABLES_CHAIN: "human:owen" };
      expect(cli4(["insert", "Notes", "--json", '{"Body":"from the agent"}'], agent).out.createdBy).toEqual({ id: "bot", kind: "agent_of_human" });
      expect(cli4(["insert", "Notes", "--json", '{"Body":"cut down"}'], { ...agent, AGENTIC_TABLES_SCOPES: "table:read,base:read" }).err.error.code).toBe("FORBIDDEN");
      expect(cli4(["export-data"], agent).err.error.code).toBe("FORBIDDEN");
      expect(cli4(["insert", "Notes", "--json", "{}"], { AGENTIC_TABLES_ACTOR: "agent_of_human:bot" }).err.error.code).toBe("UNAUTHENTICATED");

      // MCP: the same rules, as an error with a code.
      const client = new Client({ name: "e2e-roles", version: "0.0.0" });
      await client.connect(new StdioClientTransport({ command: "node", args: [cli, "mcp"], env: { ...env4, ...viewer } }));
      try {
        const call = async (name: string, args: Record<string, unknown>) => {
          const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
          return { isError: r.isError === true, body: JSON.parse(r.content[0]!.text) };
        };
        expect((await call("query_rows", { table: "Notes" })).isError).toBe(false);
        const refused = await call("insert_rows", { table: "Notes", rows: [{ Body: "mcp viewer" }] });
        expect([refused.isError, refused.body.code]).toEqual([true, "FORBIDDEN"]);
        expect((await call("share", { subject: "sam", role: "viewer" })).body.code).toBe("FORBIDDEN");
      } finally {
        await client.close();
      }

      // Revoke: the viewer loses access, and the rows stay as they were.
      expect(cli4(["unshare", "vera"], owner).code).toBe(0);
      expect(cli4(["query", "Notes"], viewer).err.error.code).toBe("NOT_FOUND");
      expect(cli4(["query", "Notes"], owner).out.items.map((r: any) => r.values.Body)).toEqual(["first", "from the agent"]);
    } finally {
      rmSync(dir4, { recursive: true, force: true });
    }
  }, 120_000);
});

describe("mcp", () => {
  test("describes the schema and does typed row CRUD over stdio", async () => {
    const client = new Client({ name: "e2e", version: "0.0.0" });
    await client.connect(new StdioClientTransport({ command: "node", args: [cli, "mcp"], env: { ...env, AGENTIC_TABLES_ACTOR: "agent:e2e", AGENTIC_TABLES_BASE: sharedBase! } as Record<string, string> }));
    try {
      const names = (await client.listTools()).tools.map((t) => t.name);
      expect(names).toEqual(expect.arrayContaining(["list_tables", "describe_table", "create_table", "add_field", "insert_rows", "update_row", "delete_row", "get_row", "query_rows", "set_required", "delete_table", "export_my_data", "erase_my_data", "share", "unshare"]));
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

describe("one file, many processes", () => {
  test("a CLI write while the MCP server runs is never lost, and parallel CLI writes all land", async () => {
    const shared = mkdtempSync(join(tmpdir(), "tables-shared-"));
    const sharedEnv = { ...process.env, AGENTIC_TABLES_DB: join(shared, "db.json") } as Record<string, string>;
    const cliRun = (args: string[]) => spawnSync("node", [cli, ...args], { env: sharedEnv, encoding: "utf8" });
    const client = new Client({ name: "e2e-shared", version: "0.0.0" });
    try {
      expect(cliRun(["new", "Log", "--field", "Msg:text"]).status).toBe(0);
      expect(cliRun(["share", "mcp", "editor"]).status).toBe(0);
      const sharedBase = JSON.parse(cliRun(["export-data"]).stdout).bases[0].base.id as string;
      await client.connect(new StdioClientTransport({ command: "node", args: [cli, "mcp"], env: { ...sharedEnv, AGENTIC_TABLES_ACTOR: "agent:mcp", AGENTIC_TABLES_BASE: sharedBase } }));
      // The server has loaded the file. Now the CLI writes, then the server writes.
      expect(cliRun(["insert", "Log", "--json", '{"Msg":"from cli"}']).status).toBe(0);
      const viaMcp = (await client.callTool({ name: "insert_rows", arguments: { table: "Log", rows: [{ Msg: "from mcp" }] } })) as { isError?: boolean };
      expect(viaMcp.isError).toBeFalsy();
      steps.push({ step: "cli insert then mcp insert on one file", ok: true });

      const run = promisify(execFile);
      const parallel = await Promise.all(Array.from({ length: 8 }, (_, i) => run("node", [cli, "insert", "Log", "--json", JSON.stringify({ Msg: `p${i}` })], { env: sharedEnv })));
      expect(parallel).toHaveLength(8);
      const rows = JSON.parse(cliRun(["query", "Log", "--limit", "100"]).stdout).items.map((r: any) => r.values.Msg).sort();
      expect(rows).toEqual(["from cli", "from mcp", ...Array.from({ length: 8 }, (_, i) => `p${i}`)].sort());
      steps.push({ step: "8 parallel cli inserts on one file", ok: true });
    } finally {
      await client.close();
      rmSync(shared, { recursive: true, force: true });
    }
  }, 60_000);
});
