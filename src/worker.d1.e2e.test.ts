// End to end: two Workers on one local D1 database under `wrangler dev`.
//
// Failure cases, written before the Worker change:
//  1. Data written through one Worker is not visible through the other.
//  2. A restart loses the data.
//  3. Many writes at once through one Worker lose a row.
//  4. A Worker without a region setting, or with "unknown" or "EU", serves requests anyway.
//  5. A Worker without a D1 binding serves requests anyway.
//  6. A path id the store refuses ends as a 500 and puts the id in a log. It must be a 404.
//  7. Rename loses a concurrent field change, or disappears after a restart.
//
// The run writes a JSON record of each request (status only) to $TMPDIR/agentic-tables-d1-e2e.json.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test, vi } from "vitest";
import { createMemoryStore, createSharing } from "agentic-identity";
import { createTables } from "./index.js";
import worker from "./worker.js";
import { createApp } from "./app.js";
import { seedD1 } from "./seed-d1.js";
import { startWorker, type RunningWorker } from "./wrangler-harness.js";

const A = 18790;
const B = 18791;
const OPEN = ["AGENTIC_TABLES_LOCAL_DEV:1", "AGENTIC_TABLES_REGION:eu"];
const ADA = { "x-principal-id": "ada", "x-principal-kind": "human" };
// Set once the first Worker has made its table: the bearer token of ada.
let signedIn: Record<string, string> = {};
const steps: { step: string; status: number }[] = [];
const persistTo = mkdtempSync(join(tmpdir(), "agentic-tables-d1-"));
let running: RunningWorker[] = [];

async function call(worker: RunningWorker, method: string, path: string, body?: unknown) {
  const response = await fetch(`${worker.url}${path}`, {
    method,
    headers: { ...signedIn, ...(body === undefined ? {} : { "content-type": "application/json" }) },
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
    signedIn = seedD1(persistTo).asBearer(ADA);

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

    const renamed = await Promise.all([
      call(one, "PATCH", `/tables/${table.id}`, { name: "Contacts" }),
      call(one, "POST", `/tables/${table.id}/fields`, { name: "Age", type: "number" }),
    ]);
    expect(renamed.map((r) => r.status)).toEqual([200, 201]);
    expect((await call(two, "GET", `/tables/${table.id}`)).body).toMatchObject({ name: "Contacts", fields: [{ name: "Name" }, { name: "Age" }] });

    await Promise.all(running.map((w) => w.stop()));
    running = [await startWorker({ port: A, persistTo, vars: OPEN }), await startWorker({ port: B, persistTo, vars: OPEN })];
    const [again] = running as [RunningWorker, RunningWorker];
    expect((await call(again, "GET", "/bases")).body.items.map((b: any) => b.name)).toEqual(["Crm"]);
    expect(await rowCount(again, table.id)).toBe(20);
    expect((await call(again, "GET", `/tables/${table.id}`)).body).toMatchObject({ name: "Contacts", fields: [{ name: "Name" }, { name: "Age" }] });

    // An id the store refuses is a missing resource, and its text stays out of the log.
    expect((await call(again, "GET", "/rows/__secret__")).status).toBe(404);
    expect((await call(again, "GET", "/tables/__secret__/rows")).status).toBe(404);
    expect(again.log()).not.toContain("invalid id");

    // D1 refuses to bind an object, so a cursor that decodes to one must be an invalid cursor, not a 500.
    const object = Buffer.from(JSON.stringify([{ a: 1 }, "x"])).toString("base64url");
    expect((await call(again, "GET", `/tables/${table.id}/rows?cursor=${object}`)).status).toBe(400);
  }, 360_000);

  test("refuses to serve without a region claim, in a real Worker", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agentic-tables-d1-noregion-"));
    const unknown = await startWorker({ port: A + 10, persistTo: dir, vars: [OPEN[0]!, "AGENTIC_TABLES_REGION:unknown"] });
    running.push(unknown);
    const first = await call(unknown, "GET", "/bases");
    expect([first.status, first.body.error.code]).toEqual([500, "MISCONFIGURED"]);
    const missing = await startWorker({ port: A + 11, persistTo: dir, vars: [OPEN[0]!] });
    running.push(missing);
    const second = await call(missing, "GET", "/bases");
    expect([second.status, second.body.error.code]).toEqual([500, "MISCONFIGURED"]);
  }, 180_000);

  // The handler itself, with the environment a bad deploy would give it.
  test.each([
    ["no database", { AGENTIC_TABLES_LOCAL_DEV: "1", AGENTIC_TABLES_REGION: "eu" }],
    ["no region", { AGENTIC_TABLES_LOCAL_DEV: "1", DB: {} }],
    ["an upper case region", { AGENTIC_TABLES_LOCAL_DEV: "1", AGENTIC_TABLES_REGION: "EU", DB: {} }],
    ["an unknown region", { AGENTIC_TABLES_LOCAL_DEV: "1", AGENTIC_TABLES_REGION: "unknown", DB: {} }],
  ])("answers 500 MISCONFIGURED with %s", async (_name, env) => {
    const res = await worker.fetch(new Request("http://x/api/v1/tables/bases"), env as never);
    expect([res.status, ((await res.json()) as any).error.code]).toEqual([500, "MISCONFIGURED"]);
  });

  // The handler writes the failure of a store to the log. The log never holds the caller's input.
  test("logs no caller text when the store fails, and answers 503 when the database is not ready", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const boom = () => Promise.reject(new Error('invalid id "secret@example.com"'));
      const store = { ...createMemoryStore({ region: "eu" }), query: boom, get: boom };
      const failed = await createApp(createTables(store as never), createSharing(store as never), { authenticate: async () => ({ principalId: "ada", kind: "human", chain: [{ id: "ada", kind: "human" }], scopes: ["*:admin"] }) }).fetch(new Request("http://x/api/v1/tables/bases", { headers: { authorization: "Bearer aid_x" } }));
      expect(failed.status).toBe(500);

      const db = { prepare: () => ({ run: boom }) };
      const env = { AGENTIC_TABLES_LOCAL_DEV: "1", AGENTIC_TABLES_REGION: "eu", DB: db };
      const res = await worker.fetch(new Request("http://x/api/v1/tables/bases"), env as never);
      const body = JSON.stringify(await res.json());
      expect([res.status, body]).toEqual([503, expect.not.stringContaining("secret@example.com")]);
      expect(log.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(JSON.stringify(log.mock.calls)).not.toContain("secret@example.com");
    } finally {
      log.mockRestore();
    }
  });
});
