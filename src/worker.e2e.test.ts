// End to end: the real Worker under `wrangler dev`. It starts with the unsafe
// flag set, and a second time without it to check that it refuses to serve. The run writes a JSON
// record of each request to $TMPDIR/agentic-tables-worker-e2e.json.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { startWorker, type RunningWorker } from "./wrangler-harness.js";

import { defineApiSuite, HUMAN } from "./api-suite.js";

const PORT = 18788;
const BASE = `http://127.0.0.1:${PORT}/api/v1/tables`;
const steps: { step: string; status: number }[] = [];

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

defineApiSuite({ title: "tables Worker over wrangler dev", base: BASE, steps });

describe("tables Worker without the unsafe flag", () => {
  test("refuses to serve without the unsafe flag", async () => {
    for (const [method, path] of [["GET", "/bases"], ["POST", "/bases"]] as const) {
      const response = await fetch(`http://127.0.0.1:${PORT + 1}/api/v1/tables${path}`, { method, headers: HUMAN, body: method === "POST" ? "{}" : undefined });
      expect(response.status).toBe(503);
      expect(((await response.json()) as any).error.code).toBe("UNSAFE_NOT_ENABLED");
    }
    steps.push({ step: "no unsafe flag: 503", status: 503 });
  });
});
