// End to end: the real Worker under `wrangler dev`. Every request needs a credential that agentic-identity checks.
// The API suite signs in with seeded tokens. The auth cases cover no token, a bad token, a revoked token, a
// narrow scope, and a cookie write. The run writes a JSON record of each request to $TMPDIR/agentic-tables-worker-e2e.json.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { startWorker, type RunningWorker } from "./wrangler-harness.js";

import { defineApiSuite, HUMAN } from "./api-suite.js";
import { seedD1 } from "./seed-d1.js";

const PORT = 18788;
const BASE = `http://127.0.0.1:${PORT}/api/v1/tables`;
const steps: { step: string; status: number }[] = [];

const persistTo = mkdtempSync(join(tmpdir(), "agentic-tables-e2e-"));
const workers: RunningWorker[] = [];
let seed: ReturnType<typeof seedD1>;

beforeAll(async () => {
  workers.push(await startWorker({ port: PORT, persistTo, vars: ["AGENTIC_TABLES_LOCAL_DEV:1", "AGENTIC_TABLES_REGION:eu", "AGENTIC_TABLES_ORIGINS:https://app.example.org"] }));
  seed = seedD1(persistTo);
}, 240_000);

afterAll(async () => {
  await Promise.all(workers.map((w) => w.stop()));
  rmSync(persistTo, { recursive: true, force: true });
  writeFileSync(join(tmpdir(), "agentic-tables-worker-e2e.json"), JSON.stringify(steps, null, 2));
});

defineApiSuite({ title: "tables Worker over wrangler dev", base: BASE, steps, headers: (h) => seed.asBearer(h) });

describe("tables Worker auth", () => {
  const send = async (method: string, path: string, headers: Record<string, string> = {}, body?: unknown) => {
    const response = await fetch(`${BASE}${path}`, { method, headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    steps.push({ step: `auth: ${method} ${path}`, status: response.status });
    return { response, body: (await response.json()) as any };
  };
  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

  test("answers 401 to no credential, a bad one, a wrong scheme, and a header that claims a principal", async () => {
    for (const headers of [
      {},
      bearer("aid_not_a_credential"),
      { authorization: `Basic ${Buffer.from("ada:x").toString("base64")}` },
      { authorization: "Bearer " },
      HUMAN,
    ]) {
      for (const [method, path] of [["GET", "/bases"], ["POST", "/bases"], ["GET", "/rows/row_0000000000000000"]] as const) {
        const { response, body } = await send(method, path, headers, method === "POST" ? { name: "X" } : undefined);
        expect([response.status, body.error.code]).toEqual([401, "UNAUTHENTICATED"]);
        expect(response.headers.get("www-authenticate")).toBe("Bearer");
        expect(JSON.stringify(body)).not.toContain("aid_");
      }
    }
  });

  test("answers 401 to a revoked token, and to a token whose principal has expired", async () => {
    const revoked = seed.issue({ id: "gone-1", kind: "human" });
    expect((await send("GET", "/bases", bearer(revoked))).response.status).toBe(200);
    seed.revoke(revoked);
    expect((await send("GET", "/bases", bearer(revoked))).response.status).toBe(401);
    const expired = seed.issue({ id: "gone-2", kind: "human", expiresAt: Date.now() - 1000 });
    expect((await send("GET", "/bases", bearer(expired))).response.status).toBe(401);
  });

  test("answers 403 when the scope is too narrow, 401 when the chain is broken", async () => {
    const owner = seed.issue({ id: "scope-owner", kind: "human" });
    const base = (await send("POST", "/bases", bearer(owner), { name: "Scopes" })).body;
    const table = (await send("POST", `/bases/${base.id}/tables`, bearer(owner), { name: "T", fields: [{ name: "Name", type: "text" }] })).body;
    const reader = seed.issue({ id: "scope-agent", kind: "agent_of_human", chain: [{ id: "scope-owner", kind: "human" }], scopes: ["table:read", "base:read"] });
    expect((await send("GET", `/tables/${table.id}`, bearer(reader))).response.status).toBe(200);
    for (const [method, path, body] of [
      ["POST", `/tables/${table.id}/rows`, { values: { Name: "x" } }],
      ["POST", `/tables/${table.id}/fields`, { name: "F", type: "text" }],
      ["DELETE", `/tables/${table.id}`, undefined],
      ["POST", "/bases", { name: "Y" }],
      ["PUT", `/tables/${table.id}/members/human/someone`, { role: "viewer" }],
    ] as const) {
      const { response, body: answer } = await send(method, path, bearer(reader), body);
      expect([method, path, response.status, answer.error.code]).toEqual([method, path, 403, "FORBIDDEN"]);
    }
    // Listing bases needs base:read too.
    const tableOnly = seed.issue({ id: "scope-table-only", kind: "human", scopes: ["table:read"] });
    expect((await send("GET", "/bases", bearer(tableOnly))).response.status).toBe(403);
    // The table is intact, and the narrow agent wrote nothing.
    expect((await send("GET", `/tables/${table.id}/rows`, bearer(owner))).body.items).toEqual([]);
    const orphan = seed.issue({ id: "scope-orphan", kind: "agent_of_human", chain: [{ id: "scope-owner", kind: "agent" }] });
    expect((await send("GET", "/bases", bearer(orphan))).response.status).toBe(401);
  });

  test("a write that rides on a cookie needs a listed origin", async () => {
    const token = seed.issue({ id: "cookie-user", kind: "human" });
    const cookie = { cookie: `session=${token}` };
    expect((await send("GET", "/bases", cookie)).response.status).toBe(200);
    expect((await send("POST", "/bases", cookie, { name: "C" })).response.status).toBe(403);
    expect((await send("POST", "/bases", { ...cookie, origin: "https://evil.example" }, { name: "C" })).response.status).toBe(403);
    expect((await send("POST", "/bases", { ...cookie, origin: "https://app.example.org" }, { name: "C" })).response.status).toBe(201);
  });
});
