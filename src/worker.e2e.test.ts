// End to end: the real Worker under `wrangler dev`. It starts with the unsafe
// flag set, and a second time without it to check that it refuses to serve. The run writes a JSON
// record of each request to $TMPDIR/agentic-tables-worker-e2e.json.
import { spawn, type ChildProcess } from "node:child_process";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

const WRANGLER = fileURLToPath(new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url));
const PORT = 18788;
const BASE = `http://127.0.0.1:${PORT}/api/v1/tables`;
const HUMAN = { "x-principal-id": "ada", "x-principal-kind": "human" };
const BOT = { "x-principal-id": "bot-1", "x-principal-kind": "agent_of_human" };
const steps: { step: string; status: number }[] = [];

async function call(method: string, path: string, headers: Record<string, string> = {}, body?: unknown, raw?: string) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: { ...(body === undefined && raw === undefined ? {} : { "content-type": "application/json" }), ...headers },
    body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
  steps.push({ step: `${method} ${path.replace(/[a-z]+_[0-9a-f]{16}/g, ":id").split("?")[0]}`, status: response.status });
  return { status: response.status, body: (await response.json()) as any };
}

const servers: ChildProcess[] = [];

async function start(port: number, vars: string[]): Promise<void> {
  const server = spawn(process.execPath, [WRANGLER, "dev", "--ip", "127.0.0.1", "--port", String(port), "--inspector-port", String(port + 100), ...vars.flatMap((v) => ["--var", v])], {
    env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  for (const stream of [server.stdout, server.stderr]) stream?.on("data", (chunk: Buffer) => (log = (log + chunk.toString()).slice(-2000)));
  servers.push(server);
  const deadline = Date.now() + 90_000;
  for (;;) {
    try {
      await fetch(`http://127.0.0.1:${port}/api/v1/tables/bases`);
      return;
    } catch {
      if (Date.now() > deadline) throw new Error(`wrangler dev did not start in time. Last output: ${log}`);
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
}

beforeAll(async () => {
  await start(PORT, ["AGENTIC_TABLES_UNSAFE_NO_AUTH:1"]);
  await start(PORT + 1, []);
}, 240_000);

afterAll(() => {
  for (const server of servers) server.kill("SIGTERM");
  writeFileSync(join(tmpdir(), "agentic-tables-worker-e2e.json"), JSON.stringify(steps, null, 2));
});

async function makePeople() {
  const base = (await call("POST", "/bases", HUMAN, { name: "Crm" })).body;
  const table = (
    await call("POST", `/bases/${base.id}/tables`, HUMAN, {
      name: "People",
      fields: [
        { name: "Name", type: "text", required: true },
        { name: "Age", type: "number" },
        { name: "Stage", type: "single_select", options: ["lead", "won"] },
      ],
    })
  ).body;
  return { base, table };
}

describe("tables Worker over wrangler dev", () => {
  test("does typed row CRUD, queries, and views, and labels agent writes", async () => {
    const { base, table } = await makePeople();
    expect(table.fields.map((f: any) => f.name)).toEqual(["Name", "Age", "Stage"]);
    expect((await call("GET", `/bases/${base.id}/tables`)).body.items).toHaveLength(1);

    const ada = (await call("POST", `/tables/${table.id}/rows`, HUMAN, { values: { Name: "Ada", Age: 36, Stage: "won" } })).body;
    const batch = await call("POST", `/tables/${table.id}/rows`, BOT, { rows: [{ Name: "Bob", Age: 20, Stage: "lead" }, { Name: "Cy", Age: 50, Stage: "lead" }] });
    expect(batch.status).toBe(201);
    expect(batch.body.items[0].createdBy).toEqual({ id: "bot-1", kind: "agent_of_human" });

    const updated = await call("PATCH", `/rows/${ada.id}`, BOT, { values: { Age: 37 } });
    expect(updated.body).toMatchObject({ values: { Age: 37 }, createdBy: { kind: "human" }, updatedBy: { kind: "agent_of_human" } });
    expect((await call("GET", `/rows/${ada.id}`)).body.values.Name).toBe("Ada");

    const filter = encodeURIComponent(JSON.stringify({ field: "Age", op: "gt", value: 30 }));
    const found = await call("GET", `/tables/${table.id}/rows?filter=${filter}&sort=Name:desc`);
    expect(found.body.items.map((r: any) => r.values.Name)).toEqual(["Cy", "Ada"]);
    expect(found.body.plan).toBe("memory");
    const first = await call("GET", `/tables/${table.id}/rows?limit=2`);
    expect(first.body).toMatchObject({ plan: "store", nextCursor: expect.any(String) });
    const second = await call("GET", `/tables/${table.id}/rows?limit=2&cursor=${first.body.nextCursor}`);
    expect(second.body.items).toHaveLength(1);

    const view = (await call("POST", `/tables/${table.id}/views`, HUMAN, { name: "Pipeline", kind: "board", groupBy: "Stage" })).body;
    const run = await call("GET", `/views/${view.id}/rows`);
    expect(run.body.groups.map((g: any) => [g.value, g.count])).toEqual([["lead", 2], ["won", 1], [null, 0]]);

    expect((await call("DELETE", `/rows/${ada.id}`, HUMAN)).body).toEqual({ deleted: ada.id });
    expect((await call("GET", `/rows/${ada.id}`)).status).toBe(404);
  });

  test("changes the schema and reports the rows that block a type change", async () => {
    const { table } = await makePeople();
    await call("POST", `/tables/${table.id}/rows`, HUMAN, { rows: [{ Name: "7" }, { Name: "seven" }] });
    const nameId = table.fields[0].id;
    const blocked = await call("POST", `/tables/${table.id}/fields/Name/type`, HUMAN, { to: "number" });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toMatchObject({ code: "MIGRATION_ABORTED", report: { applied: false, failures: [{ value: "seven" }] } });
    const dry = await call("POST", `/tables/${table.id}/fields/Name/type`, HUMAN, { to: "number", dryRun: true });
    expect(dry.body).toMatchObject({ applied: false, converted: 1 });
    const renamed = await call("PATCH", `/tables/${table.id}/fields/${nameId}`, HUMAN, { name: "Title" });
    expect(renamed.body.fields[0]).toMatchObject({ id: nameId, name: "Title" });
    expect((await call("POST", `/tables/${table.id}/fields`, HUMAN, { name: "Owner", type: "text", required: true })).status).toBe(422);
    const dropped = await call("DELETE", `/tables/${table.id}/fields/Owner`, HUMAN);
    expect(dropped.status).toBe(404);
  });

  test("changes required with a report, and deletes tables and bases", async () => {
    const { base, table } = await makePeople();
    const linked = (await call("POST", `/bases/${base.id}/tables`, HUMAN, { name: "Orders", fields: [{ name: "Who", type: "link", linkTable: table.id }] })).body;
    await call("POST", `/tables/${table.id}/rows`, HUMAN, { values: { Name: "Ada" } });
    await call("POST", `/tables/${table.id}/rows`, HUMAN, { values: { Name: "Bob", Age: 5 } });
    const blocked = await call("PUT", `/tables/${table.id}/fields/Age/required`, HUMAN, { required: true });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.report).toMatchObject({ applied: false, failures: [{ reason: "has no value" }] });
    expect((await call("PUT", `/tables/${table.id}/fields/Age/required`, HUMAN, { required: true, dryRun: true })).body.applied).toBe(false);
    expect((await call("PUT", `/tables/${table.id}/fields/Age/required`, HUMAN, { required: "yes" })).status).toBe(400);
    expect((await call("PUT", `/tables/${table.id}/fields/Age/required`, HUMAN, { required: false })).body.applied).toBe(true);

    expect((await call("DELETE", `/tables/${table.id}`, {})).status).toBe(401);
    const refused = await call("DELETE", `/tables/${table.id}`, HUMAN);
    expect(refused).toMatchObject({ status: 422, body: { error: { issues: [{ field: "Orders.Who" }] } } });
    expect((await call("DELETE", `/tables/${linked.id}`, HUMAN)).body).toEqual({ rows: 0, views: 0 });
    expect((await call("DELETE", `/bases/${base.id}`, HUMAN)).body).toEqual({ tables: 1, rows: 2, views: 0 });
    expect((await call("GET", `/tables/${table.id}`)).status).toBe(404);
    expect((await call("DELETE", `/bases/${base.id}`, HUMAN)).status).toBe(404);
  });

  test("refuses to serve without the unsafe flag", async () => {
    for (const [method, path] of [["GET", "/bases"], ["POST", "/bases"]] as const) {
      const response = await fetch(`http://127.0.0.1:${PORT + 1}/api/v1/tables${path}`, { method, headers: HUMAN, body: method === "POST" ? "{}" : undefined });
      expect(response.status).toBe(503);
      expect(((await response.json()) as any).error.code).toBe("UNSAFE_NOT_ENABLED");
    }
    steps.push({ step: "no unsafe flag: 503", status: 503 });
  });

  test("fails loudly, with a code and no internal detail", async () => {
    const { table } = await makePeople();
    const rows = `/tables/${table.id}/rows`;

    const noActor = await call("POST", rows, {}, { values: { Name: "X" } });
    expect(noActor).toMatchObject({ status: 401, body: { error: { code: "UNAUTHENTICATED" } } });
    expect((await call("POST", rows, { "x-principal-id": "a", "x-principal-kind": "wizard" }, { values: { Name: "X" } })).status).toBe(401);
    expect((await call("DELETE", "/rows/row_0000000000000000", {})).status).toBe(401);

    const invalid = await call("POST", rows, HUMAN, { rows: [{ Name: "Ok" }, { Name: "Bad", Stage: "lost" }] });
    expect(invalid.status).toBe(422);
    expect(invalid.body.error.issues[0]).toMatchObject({ field: "row 2.Stage", code: "option" });
    expect((await call("GET", rows)).body.items).toHaveLength(0);

    expect((await call("POST", rows, HUMAN, undefined, "{not json")).body.error.code).toBe("BAD_REQUEST");
    expect((await call("POST", rows, HUMAN, [1, 2])).status).toBe(400);
    expect((await call("GET", `${rows}?filter=%7Bbad`)).status).toBe(400);
    expect((await call("GET", `${rows}?limit=0`)).body.error.code).toBe("INVALID_QUERY");
    expect((await call("GET", `${rows}?cursor=zzz`)).body.error.code).toBe("INVALID_CURSOR");
    expect((await call("GET", `${rows}?sort=Name&cursor=zzz`)).body.error.code).toBe("INVALID_CURSOR");
    expect((await call("GET", `${rows}?filter=${encodeURIComponent('{"field":"Nope","op":"eq","value":1}')}`)).status).toBe(422);

    expect((await call("GET", "/tables/tbl_0000000000000000")).status).toBe(404);
    expect((await call("GET", "/nowhere")).body.error.code).toBe("NOT_FOUND");
  });
});
