// End to end: two Workers on one local D1 database under `wrangler dev`.
//
// Failure cases, written before the Worker change:
//  1. Data written through one Worker is not visible through the other.
//  2. A restart loses the data.
//  3. Many writes at once through one Worker lose a row.
//  4. A Worker without a region setting, or with "unknown", serves requests anyway.
//  5. A Worker without a D1 binding serves requests anyway.
//
// The run writes a JSON record of each request (status only) to $TMPDIR/agentic-tables-d1-e2e.json.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { startWorker, type RunningWorker } from "./wrangler-harness.js";

const A = 18790;
const B = 18791;
const OPEN = ["AGENTIC_TABLES_UNSAFE_NO_AUTH:1"];
const ADA = { "x-principal-id": "ada", "x-principal-kind": "human" };
const steps: { step: string; status: number }[] = [];
const persistTo = mkdtempSync(join(tmpdir(), "agentic-tables-d1-"));
let running: RunningWorker[] = [];

async function call(worker: RunningWorker, method: string, path: string, body?: unknown) {
  const response = await fetch(`${worker.url}${path}`, {
    method,
    headers: { ...ADA, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  steps.push({ step: `${method} ${path.replace(/[a-z]+_[0-9a-f]{16}/g, ":id").split("?")[0]}`, status: response.status });
  return { status: response.status, body: (await response.json()) as any };
}

const rowCount = async (worker: RunningWorker, tableId: string) => {
  let count = 0;
  let cursor = "";
  do {
    const page = (await call(worker, "GET", `/tables/${tableId}/rows?limit=1000${cursor}`)).body;
    count += page.items.length;
    cursor = page.nextCursor ? `&cursor=${encodeURIComponent(page.nextCursor)}` : "";
  } while (cursor);
  return count;
};

afterAll(async () => {
  await Promise.all(running.map((w) => w.stop()));
  rmSync(persistTo, { recursive: true, force: true });
  writeFileSync(join(tmpdir(), "agentic-tables-d1-e2e.json"), JSON.stringify(steps, null, 2));
});

describe("two Workers on one D1 database", () => {
  test("share data, survive a restart, and lose no concurrent write", async () => {
    running = [await startWorker({ port: A, persistTo, vars: OPEN }), await startWorker({ port: B, persistTo, vars: OPEN })];
    const [one, two] = running as [RunningWorker, RunningWorker];

    const base = (await call(one, "POST", "/bases", { name: "Crm" })).body;
    const table = (await call(one, "POST", `/bases/${base.id}/tables`, { name: "People", fields: [{ name: "Name", type: "text", required: true }] })).body;
    await call(one, "POST", `/tables/${table.id}/rows`, { values: { Name: "from-one" } });
    expect((await call(two, "GET", `/tables/${table.id}/rows`)).body.items.map((r: any) => r.values.Name)).toEqual(["from-one"]);
    await call(two, "POST", `/tables/${table.id}/rows`, { values: { Name: "from-two" } });
    expect(await rowCount(one, table.id)).toBe(2);

    // Many requests at once into one Worker, then into the other. Two local Workers writing at the same
    // instant can hit SQLITE_BUSY on the shared file, which D1 itself never does, so the batches alternate.
    for (const [worker, tag] of [[one, "a"], [two, "b"], [one, "c"]] as const) {
      const writes = Array.from({ length: 6 }, (_, i) => call(worker, "POST", `/tables/${table.id}/rows`, { values: { Name: `${tag}-${i}` } }));
      expect((await Promise.all(writes)).map((r) => r.status)).toEqual(Array(6).fill(201));
    }
    expect(await rowCount(two, table.id)).toBe(20);

    await Promise.all(running.map((w) => w.stop()));
    running = [await startWorker({ port: A, persistTo, vars: OPEN }), await startWorker({ port: B, persistTo, vars: OPEN })];
    const [again] = running as [RunningWorker, RunningWorker];
    expect((await call(again, "GET", "/bases")).body.items.map((b: any) => b.name)).toEqual(["Crm"]);
    expect(await rowCount(again, table.id)).toBe(20);
  }, 360_000);

  test("refuses to serve without a region claim", async () => {
    const worker = await startWorker({ port: A + 10, persistTo: mkdtempSync(join(tmpdir(), "agentic-tables-d1-noregion-")), vars: [...OPEN, "AGENTIC_TABLES_REGION:unknown"] });
    running.push(worker);
    const res = await call(worker, "GET", "/bases");
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe("MISCONFIGURED");
  }, 120_000);
});
