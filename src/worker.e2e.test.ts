// End to end: the real Worker under `wrangler dev`. It starts with the unsafe
// flag set, and a second time without it to check that it refuses to serve. The run writes a JSON
// record of each request to $TMPDIR/agentic-tables-worker-e2e.json.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { startWorker, type RunningWorker } from "./wrangler-harness.js";

const PORT = 18788;
const BASE = `http://127.0.0.1:${PORT}/api/v1/tables`;
const HUMAN = { "x-principal-id": "ada", "x-principal-kind": "human" };
const BOT = { "x-principal-id": "bot-1", "x-principal-kind": "agent_of_human", "x-principal-chain": "human:ada" };
const steps: { step: string; status: number }[] = [];

async function call(method: string, path: string, headers: Record<string, string> = HUMAN, body?: unknown, raw?: string) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: { ...(body === undefined && raw === undefined ? {} : { "content-type": "application/json" }), ...headers },
    body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
  steps.push({ step: `${method} ${path.replace(/[a-z]+_[0-9a-f]{16}/g, ":id").split("?")[0]}`, status: response.status });
  return { status: response.status, body: (await response.json()) as any };
}

const persistTo = mkdtempSync(join(tmpdir(), "agentic-tables-e2e-"));
const workers: RunningWorker[] = [];

beforeAll(async () => {
  workers.push(await startWorker({ port: PORT, persistTo, vars: ["AGENTIC_TABLES_UNSAFE_NO_AUTH:1", "AGENTIC_TABLES_REGION:eu"] }));
  workers.push(await startWorker({ port: PORT + 1, persistTo }));
}, 240_000);

afterAll(async () => {
  await Promise.all(workers.map((w) => w.stop()));
  rmSync(persistTo, { recursive: true, force: true });
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

  test("exports and hard deletes the data of the caller only", async () => {
    const eve = { "x-principal-id": "eve", "x-principal-kind": "human" };
    const mine = await makePeople();
    await call("POST", `/tables/${mine.table.id}/rows`, BOT, { values: { Name: "Mine" } });
    const theirs = (await call("POST", "/bases", eve, { name: "Eve" })).body;
    await call("POST", `/bases/${theirs.id}/tables`, eve, { name: "Secret", fields: [{ name: "Note", type: "text" }] });

    expect((await call("POST", "/bases", {}, { name: "x" })).status).toBe(401);
    expect((await call("GET", "/me/export", {})).status).toBe(401);
    expect((await call("DELETE", "/me/data", {})).status).toBe(401);

    const exported = (await call("GET", "/me/export", eve)).body;
    expect(exported).toMatchObject({ format: "agentic-tables-export", ownerId: "eve", bases: [{ base: { id: theirs.id }, tables: [{ name: "Secret" }] }] });
    expect(JSON.stringify(exported)).not.toContain("Mine");
    const adaExport = (await call("GET", "/me/export", HUMAN)).body;
    expect(JSON.stringify(adaExport)).not.toContain("Secret");
    expect(adaExport.bases.some((b: any) => b.base.id === mine.base.id && b.rows[0].values.Name === "Mine" && b.rows[0].createdBy.kind === "agent_of_human")).toBe(true);

    // Eve also wrote a row in Ada's base, as an editor on that table. Export and erase for Eve cover it, and Ada's other rows stay.
    expect((await call("PUT", `/tables/${mine.table.id}/members/eve`, HUMAN, { role: "editor" })).status).toBe(200);
    await call("POST", `/tables/${mine.table.id}/rows`, eve, { values: { Name: "Eve was here" } });
    expect((await call("GET", "/me/export", eve)).body.authoredRows.map((r: any) => r.values.Name)).toEqual(["Eve was here"]);
    expect((await call("GET", "/me/export", HUMAN)).body.authoredRows).toEqual([]);

    const erased = await call("DELETE", "/me/data", eve);
    expect(erased.body).toEqual({ bases: 1, tables: 1, rows: 0, views: 0, authoredRows: 1 });
    expect((await call("GET", `/tables/${mine.table.id}/rows`)).body.items.map((r: any) => r.values.Name)).toEqual(["Mine"]);
    expect((await call("GET", "/me/export", eve)).body.bases).toEqual([]);
    expect((await call("GET", `/bases/${theirs.id}/tables`)).status).toBe(404);
    expect((await call("GET", `/tables/${mine.table.id}`)).status).toBe(200);
  });

  // Roles from agentic-identity: viewer < commenter < editor < owner. A role on a base passes down to its tables.
  // Reading needs viewer, rows and views need editor, a schema change or a delete needs owner. No role: not found.
  test("checks roles: a viewer cannot write, an agent is cut down by its scopes, a stranger sees nothing", async () => {
    const { base, table } = await makePeople();
    const person = (id: string) => ({ "x-principal-id": id, "x-principal-kind": "human" });
    const [vic, eve, stranger] = [person("vic"), person("eve"), person("stranger")];
    const row = (await call("POST", `/tables/${table.id}/rows`, HUMAN, { values: { Name: "Ada" } })).body;
    const rows = `/tables/${table.id}/rows`;
    const status = async (method: string, path: string, who: Record<string, string>, body?: unknown) => (await call(method, path, who, body)).status;

    // A stranger learns nothing: not the base, not the table, not the row.
    expect(await status("GET", rows, stranger)).toBe(404);
    expect(await status("GET", `/rows/${row.id}`, stranger)).toBe(404);
    expect(await status("POST", rows, stranger, { values: { Name: "x" } })).toBe(404);
    expect((await call("GET", "/bases", stranger)).body.items).toEqual([]);
    // Only an owner shares.
    expect(await status("PUT", `/bases/${base.id}/members/vic`, stranger, { role: "viewer" })).toBe(404);
    expect(await status("PUT", `/bases/${base.id}/members/vic`, HUMAN, { role: "boss" })).toBe(400);

    // A viewer on the base reads its tables and rows, and cannot change anything.
    expect(await status("PUT", `/bases/${base.id}/members/vic`, HUMAN, { role: "viewer" })).toBe(200);
    expect(await status("GET", rows, vic)).toBe(200);
    expect(await status("GET", `/rows/${row.id}`, vic)).toBe(200);
    expect((await call("GET", "/bases", vic)).body.items.map((b: any) => b.id)).toEqual([base.id]);
    const denied = [
      await call("POST", rows, vic, { values: { Name: "Vic was here" } }),
      await call("PATCH", `/rows/${row.id}`, vic, { values: { Name: "Changed" } }),
      await call("DELETE", `/rows/${row.id}`, vic),
      await call("POST", `/tables/${table.id}/views`, vic, { name: "V", kind: "grid" }),
      await call("POST", `/tables/${table.id}/fields`, vic, { name: "F", type: "text" }),
      await call("POST", `/bases/${base.id}/tables`, vic, { name: "T2" }),
      await call("DELETE", `/tables/${table.id}`, vic),
      await call("DELETE", `/bases/${base.id}`, vic),
      await call("PUT", `/bases/${base.id}/members/eve`, vic, { role: "owner" }),
    ];
    expect(denied.map((r) => [r.status, r.body.error.code])).toEqual(Array(9).fill([403, "FORBIDDEN"]));
    const after = (await call("GET", rows, HUMAN)).body.items;
    expect(after.map((r: any) => r.values.Name)).toEqual(["Ada"]);
    expect((await call("GET", `/bases/${base.id}/tables`, HUMAN)).body.items).toHaveLength(1);

    // An editor on the table writes rows, and still cannot change the schema or share.
    expect(await status("PUT", `/tables/${table.id}/members/eve`, HUMAN, { role: "editor" })).toBe(200);
    expect(await status("POST", rows, eve, { values: { Name: "Eve" } })).toBe(201);
    expect(await status("POST", `/tables/${table.id}/fields`, eve, { name: "F", type: "text" })).toBe(403);
    expect(await status("PUT", `/tables/${table.id}/members/vic`, eve, { role: "editor" })).toBe(403);
    expect(await status("GET", `/bases/${base.id}/tables`, eve)).toBe(404);

    // An agent acts with the role of its owner, cut down by its scopes. It can never exceed either.
    const agent = (scopes?: string) => ({ "x-principal-id": "bot-2", "x-principal-kind": "agent_of_human", "x-principal-chain": "human:ada", ...(scopes ? { "x-principal-scopes": scopes } : {}) });
    expect(await status("POST", rows, agent(), { values: { Name: "Bot" } })).toBe(201);
    expect(await status("GET", rows, agent("table:read,base:read"))).toBe(200);
    const narrowed = await call("POST", rows, agent("table:read"), { values: { Name: "Bot again" } });
    expect([narrowed.status, narrowed.body.error.code]).toEqual([403, "FORBIDDEN"]);
    expect(await status("POST", rows, { ...agent(), "x-principal-chain": "human:vic" }, { values: { Name: "Bot of vic" } })).toBe(403);
    expect(await status("POST", rows, { ...agent(), "x-principal-chain": "agent_of_human:nobody" }, { values: { Name: "x" } })).toBe(401);
    // The row shows who wrote it: the agent, not its owner.
    const written = (await call("GET", `${rows}?sort=Name`, HUMAN)).body.items.find((r: any) => r.values.Name === "Bot");
    expect(written.createdBy).toEqual({ id: "bot-2", kind: "agent_of_human" });
    // An agent cannot export or erase its owner's data.
    expect(await status("DELETE", "/me/data", agent())).toBe(403);
    expect(await status("GET", "/me/export", agent())).toBe(403);

    // Revoking takes the access away at once.
    expect(await status("DELETE", `/bases/${base.id}/members/vic`, HUMAN)).toBe(200);
    expect(await status("GET", rows, vic)).toBe(404);
  });

  test("refuses to serve without the unsafe flag", async () => {
    for (const [method, path] of [["GET", "/bases"], ["POST", "/bases"]] as const) {
      const response = await fetch(`http://127.0.0.1:${PORT + 1}/api/v1/tables${path}`, { method, headers: HUMAN, body: method === "POST" ? "{}" : undefined });
      expect(response.status).toBe(503);
      expect(((await response.json()) as any).error.code).toBe("UNSAFE_NOT_ENABLED");
    }
    steps.push({ step: "no unsafe flag: 503", status: 503 });
  });

  test("rejects bodies that do not match the schema, and oversize bodies", async () => {
    const { base, table } = await makePeople();
    const rows = `/tables/${table.id}/rows`;
    const bad = async (path: string, body: unknown, status = 400) => {
      const response = await call("POST", path, HUMAN, body);
      expect(response.status).toBe(status);
      expect(response.body.error.code).toBe(status === 413 ? "PAYLOAD_TOO_LARGE" : "BAD_REQUEST");
      return response;
    };

    await bad(rows, { values: 5 });
    await bad(rows, { values: [1] });
    await bad(rows, { values: null });
    await bad(rows, { rows: [5] });
    await bad(rows, { rows: [null] });
    await bad(rows, { rows: "x" });
    await bad(rows, { values: { Name: "Ok" }, extra: true });
    await bad(rows, { values: { Name: "Ok" }, rows: [{ Name: "Ok" }] });
    await bad(rows, { rows: Array.from({ length: 501 }, () => ({ Name: "Ok" })) });
    await bad(`/bases/${base.id}/tables`, { name: "T", fields: [{ name: "A", type: "text", required: "false" }] });
    await bad(`/bases/${base.id}/tables`, { name: "T", fields: [null] });
    await bad(`/bases/${base.id}/tables`, { name: "T", fields: [{ name: "A", type: "select", options: [1] }] });
    await bad(`/bases/${base.id}/tables`, { name: "T", fields: [{ name: "A", type: "single_select", options: [1] }] });
    await bad(`/bases/${base.id}/tables`, { name: "T", extra: 1 });
    await bad(`/tables/${table.id}/fields`, { name: "B", type: "text", required: "no" });
    await bad(`/tables/${table.id}/fields`, { name: "B", type: "text", unknown: 1 });
    await bad("/bases", { name: "" });
    await bad("/bases", { name: 5 });
    await bad(`/tables/${table.id}/views`, { name: "V", kind: "grid", extra: 1 });
    await bad(`/tables/${table.id}/views`, { name: "V", kind: "calendar" });
    await bad(`/tables/${table.id}/fields/Name/type`, { to: "number", dryRun: "yes" });
    expect((await call("PATCH", `/tables/${table.id}/fields/Name`, HUMAN, { name: 5 })).status).toBe(400);
    for (const body of [{ required: "true" }, { required: true, dryRun: "yes" }, { required: true, extra: 1 }, {}]) {
      expect((await call("PUT", `/tables/${table.id}/fields/Age/required`, HUMAN, body)).status).toBe(400);
    }
    expect((await call("PATCH", `/rows/${(await call("POST", rows, HUMAN, { values: { Name: "R" } })).body.id}`, HUMAN, { values: 5 })).status).toBe(400);

    const big = await call("POST", rows, HUMAN, { values: { Name: "x".repeat(1024 * 1024 + 1) } });
    expect(big.status).toBe(413);
    expect(big.body.error.code).toBe("PAYLOAD_TOO_LARGE");
    const noLength = await call("POST", rows, HUMAN, undefined, JSON.stringify({ values: { Name: "x".repeat(1024 * 1024 + 1) } }));
    expect(noLength.status).toBe(413);

    // Nothing bad reached the store. Only the one "R" row exists.
    expect((await call("GET", rows)).body.items.map((r: any) => r.values.Name)).toEqual(["R"]);
    // A 500-row batch still passes.
    const max = await call("POST", rows, HUMAN, { rows: Array.from({ length: 500 }, (_, i) => ({ Name: `n${i}` })) });
    expect(max.status).toBe(201);
    // A bad limit is a client error.
    const view = (await call("POST", `/tables/${table.id}/views`, HUMAN, { name: "B", kind: "board", groupBy: "Stage" })).body;
    for (const limit of ["-1", "abc", "0", "1001"]) expect((await call("GET", `/views/${view.id}/rows?limit=${limit}`)).status).toBe(400);
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
