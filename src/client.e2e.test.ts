// The remote client against the real Worker under `wrangler dev`.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createClient, TablesClientError } from "./client.js";
import { startWorker, type RunningWorker } from "./wrangler-harness.js";

const PORT = 18792;
const persistTo = mkdtempSync(join(tmpdir(), "agentic-tables-client-"));
let worker: RunningWorker;

beforeAll(async () => {
  worker = await startWorker({ port: PORT, persistTo, vars: ["AGENTIC_TABLES_UNSAFE_NO_AUTH:1", "AGENTIC_TABLES_REGION:eu"] });
}, 240_000);

afterAll(async () => {
  await worker?.stop();
  rmSync(persistTo, { recursive: true, force: true });
});

const ada = () => createClient({ baseUrl: `http://127.0.0.1:${PORT}`, token: "t", principal: { id: "ada", kind: "human" } });

async function failure(promise: Promise<unknown>): Promise<TablesClientError> {
  const error = await promise.then(() => undefined, (e: unknown) => e);
  expect(error).toBeInstanceOf(TablesClientError);
  return error as TablesClientError;
}

describe("remote client over wrangler dev", () => {
  test("covers rows, fields, views and sharing with typed results", async () => {
    const c = ada();
    const base = await c.createBase("Crm");
    expect(await c.listBases()).toEqual([base]);
    const table = await c.createTable(base.id, "People", [{ name: "Name", type: "text", required: true }, { name: "Age", type: "number" }, { name: "Stage", type: "single_select", options: ["lead", "won"] }]);
    expect((await c.listTables(base.id)).map((t) => t.name)).toEqual(["People"]);
    expect((await c.getTable(table.id)).fields).toHaveLength(3);

    const row = await c.insertRow(table.id, { Name: "Ada", Age: 36, Stage: "won" });
    expect(row.createdBy).toEqual({ id: "ada", kind: "human" });
    const more = await c.insertRows(table.id, [{ Name: "Bob", Age: 20, Stage: "lead" }, { Name: "Cy", Age: 50, Stage: "lead" }]);
    expect(more).toHaveLength(2);
    expect((await c.updateRow(row.id, { Age: 37 })).values.Age).toBe(37);
    expect((await c.getRow(row.id)).values.Name).toBe("Ada");

    const found = await c.queryRows(table.id, { filter: { field: "Age", op: "gt", value: 30 }, sort: { field: "Name", direction: "desc" } });
    expect(found.items.map((r) => r.values.Name)).toEqual(["Cy", "Ada"]);
    const first = await c.queryRows(table.id, { limit: 2 });
    expect(first.nextCursor).toEqual(expect.any(String));
    expect((await c.queryRows(table.id, { limit: 2, cursor: first.nextCursor })).items).toHaveLength(1);

    const withEmail = await c.addField(table.id, { name: "Email", type: "text" });
    expect(withEmail.fields.map((f) => f.name)).toContain("Email");
    const renamed = await c.renameField(table.id, "Email", "Mail");
    expect(renamed.fields.map((f) => f.name)).toContain("Mail");
    expect((await c.setRequired(table.id, "Age", false, { dryRun: true })).applied).toBe(false);
    expect((await c.changeFieldType(table.id, "Mail", { to: "long_text" })).applied).toBe(true);
    expect((await c.deleteField(table.id, "Mail")).fields.map((f) => f.name)).not.toContain("Mail");

    const view = await c.createView(table.id, { name: "Pipeline", kind: "board", groupBy: "Stage" });
    expect(await c.listViews(table.id)).toHaveLength(1);
    const run = await c.runView(view.id);
    expect(run.kind === "board" && run.groups.map((g) => [g.value, g.count])).toEqual([["lead", 2], ["won", 1], [null, 0]]);
    expect(await c.deleteView(view.id)).toEqual({ deleted: view.id });
    expect(await c.deleteRow(more[0]!.id)).toEqual({ deleted: more[0]!.id });

    const eve = { kind: "human", id: "eve" } as const;
    expect(await c.shareBase(base.id, eve, "viewer")).toMatchObject({ subjectId: "eve", role: "viewer" });
    const asEve = createClient({ baseUrl: `http://127.0.0.1:${PORT}/api/v1/tables`, principal: { id: "eve", kind: "human" } });
    expect((await asEve.getTable(table.id)).id).toBe(table.id);
    expect((await failure(asEve.insertRow(table.id, { Name: "x" }))).code).toBe("FORBIDDEN");
    await c.unshareBase(base.id, eve);
    expect((await failure(asEve.getTable(table.id))).status).toBe(404);
    await c.shareTable(table.id, eve, "viewer");
    await c.unshareTable(table.id, eve);

    expect((await c.exportMyData()).bases.length).toBeGreaterThan(0);
    expect(await c.deleteTable(table.id)).toMatchObject({ views: 0 });
    expect(await c.deleteBase(base.id)).toMatchObject({ tables: 0 });
    expect(await c.eraseMyData()).toMatchObject({ bases: 0 });
  });

  test("reports an auth failure with the API code and status", async () => {
    const anonymous = createClient({ baseUrl: `http://127.0.0.1:${PORT}`, token: "t" });
    const error = await failure(anonymous.listBases());
    expect(error).toMatchObject({ code: "UNAUTHENTICATED", status: 401 });
  });

  test("reports a missing resource and field issues", async () => {
    const c = ada();
    expect(await failure(c.getRow("row_0000000000000000"))).toMatchObject({ code: "NOT_FOUND", status: 404 });
    expect(await failure(c.claimBase("base_0000000000000000"))).toMatchObject({ code: "NOT_FOUND", status: 404 });
    const base = await c.createBase("Issues");
    const table = await c.createTable(base.id, "T", [{ name: "N", type: "number" }]);
    const bad = await failure(c.insertRow(table.id, { N: "x" }));
    expect(bad).toMatchObject({ code: "VALIDATION_FAILED", status: 422, issues: [{ field: "N", code: "type" }] });
    await c.insertRow(table.id, { N: 1 });
    await c.insertRow(table.id, {});
    const blocked = await failure(c.setRequired(table.id, "N", true));
    expect(blocked).toMatchObject({ code: "MIGRATION_ABORTED", status: 409, report: { applied: false } });
  });

  test("imports no runtime module, so it stays free of Node and store code", () => {
    const source = readFileSync(new URL("./client.ts", import.meta.url), "utf8");
    const imports = source.split("\n").filter((line) => /^\s*(import|export)\b.*\bfrom\b/.test(line));
    expect(imports.length).toBeGreaterThan(0);
    for (const line of imports) expect(line).toMatch(/^(import|export) type /);
  });

  test("cancels with an AbortSignal and does not retry", async () => {
    const c = ada();
    const controller = new AbortController();
    controller.abort();
    await expect(c.listBases({ signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    let calls = 0;
    const flaky = createClient({ baseUrl: "http://x.invalid", fetch: async () => (calls++, Promise.reject(new TypeError("down"))) });
    expect(await failure(flaky.insertRow("table_0000000000000000", {}))).toMatchObject({ code: "NETWORK", status: 0 });
    expect(calls).toBe(1);
  });
});
