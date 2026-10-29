// End to end: the Worker must serve under the default Workers runtime, with no compatibility flags.
// One run uses the repository config. The other bundles the built `agentic-tables/worker`, as a host does.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { startWorker, type RunningWorker } from "./wrangler-harness.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const HUMAN = { "x-principal-id": "ada", "x-principal-kind": "human", "content-type": "application/json" };
const VARS = ["AGENTIC_TABLES_UNSAFE_NO_AUTH:1", "AGENTIC_TABLES_REGION:eu"];
const dir = mkdtempSync(join(tmpdir(), "agentic-tables-flags-"));
const workers: RunningWorker[] = [];

// A host config: the built Worker as the entry, a D1 binding, and no compatibility flags at all.
const hostConfig = join(dir, "wrangler.jsonc");
writeFileSync(
  hostConfig,
  JSON.stringify({
    name: "host",
    main: join(ROOT, "dist/worker.js"),
    compatibility_date: "2026-01-01",
    send_metrics: false,
    d1_databases: [{ binding: "DB", database_name: "host", database_id: "00000000-0000-0000-0000-000000000000" }],
  }),
);

const ports = { repo: 18810, host: 18811 };
beforeAll(async () => {
  workers.push(await startWorker({ port: ports.repo, persistTo: join(dir, "a"), vars: VARS }));
  workers.push(await startWorker({ port: ports.host, persistTo: join(dir, "b"), vars: VARS, config: hostConfig }));
}, 240_000);
afterAll(async () => {
  await Promise.all(workers.map((w) => w.stop()));
  rmSync(dir, { recursive: true, force: true });
});

test("wrangler.jsonc sets no compatibility flags", () => {
  const text = readFileSync(join(ROOT, "wrangler.jsonc"), "utf8");
  expect(text).not.toMatch(/^\s*"compatibility_flags"\s*:\s*\[\s*"/m);
});

describe.each([["the repository config", "repo"], ["the built worker with a bare host config", "host"]] as const)("%s", (_name, which) => {
  test("serves a row round trip with default flags only", async () => {
    const index = which === "repo" ? 0 : 1;
    const base = `${workers[index]!.url}`;
    const call = async (method: string, path: string, body?: unknown) => {
      const r = await fetch(`${base}${path}`, { method, headers: HUMAN, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: r.status, body: (await r.json()) as any };
    };
    const b = await call("POST", "/bases", { name: "Crm" });
    expect(b.status).toBe(201);
    const t = await call("POST", `/bases/${b.body.id}/tables`, { name: "People", fields: [{ name: "Name", type: "text" }] });
    expect(t.status).toBe(201);
    expect((await call("POST", `/tables/${t.body.id}/rows`, { values: { Name: "Ada" } })).status).toBe(201);
    const rows = await call("GET", `/tables/${t.body.id}/rows`);
    expect(rows.body.items.map((r: any) => r.values.Name)).toEqual(["Ada"]);
    expect(workers[index]!.log()).not.toMatch(/node:|nodejs_compat|No such module/);
  });
});
