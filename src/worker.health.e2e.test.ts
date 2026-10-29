// End to end: the real Worker under `wrangler dev`, built by wrangler. GET /health needs no credential, and the API still does.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import pkg from "../package.json" with { type: "json" };
import { startWorker, type RunningWorker } from "./wrangler-harness.js";

const PORT = 18795;
const BASE = `http://127.0.0.1:${PORT}`;
const persistTo = mkdtempSync(join(tmpdir(), "agentic-tables-health-e2e-"));
const workers: RunningWorker[] = [];

beforeAll(async () => {
  workers.push(await startWorker({ port: PORT, persistTo, vars: ["AGENTIC_TABLES_LOCAL_DEV:1", "AGENTIC_TABLES_REGION:eu"] }));
}, 240_000);

afterAll(async () => {
  await Promise.all(workers.map((w) => w.stop()));
  rmSync(persistTo, { recursive: true, force: true });
});

describe("tables Worker /health over wrangler dev", () => {
  test("answers 200 with name and version and no credential", async () => {
    const response = await fetch(`${BASE}/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, name: "agentic-tables", version: pkg.version });
  });

  test("the API still answers 401 without a credential", async () => {
    const response = await fetch(`${BASE}/api/v1/tables/bases`);
    expect(response.status).toBe(401);
  });
});
