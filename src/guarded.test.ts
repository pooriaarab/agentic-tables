// Access checks through the real HTTP app on a memory store: fast, and the same code the Worker runs.
// The wrangler suite covers the same guard on D1.
//
// Failure cases, written from review findings:
//  1. A caller who gave a base away still exports or erases it through /me/*.
//  2. A credential with a read-only scope erases data through /me/data.
//  3. A row or view id answers differently for a stranger when it exists and when it does not.
//  4. A caller with a role on table A links a field to table B, and learns B exists.
//  5. An editor creates a table in a base.
import { createMemoryStore, createSharing } from "agentic-identity";
import { beforeEach, describe, expect, test } from "vitest";
import { createTables } from "./index.js";
import { createApp } from "./worker.js";

const person = (id: string, scopes?: string) => ({ "x-principal-id": id, "x-principal-kind": "human", ...(scopes ? { "x-principal-scopes": scopes } : {}) });
const [ada, bob, eve] = [person("ada"), person("bob"), person("eve")];

let app: ReturnType<typeof createApp>;
async function call(method: string, path: string, who: Record<string, string>, body?: unknown) {
  const res = await app.fetch(new Request(`http://x/api/v1/tables${path}`, { method, headers: { ...who, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }));
  return { status: res.status, body: (await res.json()) as any };
}

beforeEach(() => {
  const store = createMemoryStore({ region: "eu" });
  app = createApp(createTables(store), createSharing(store));
});

async function adaBase() {
  const base = (await call("POST", "/bases", ada, { name: "B" })).body;
  const a = (await call("POST", `/bases/${base.id}/tables`, ada, { name: "A", fields: [{ name: "N", type: "text" }] })).body;
  const b = (await call("POST", `/bases/${base.id}/tables`, ada, { name: "B", fields: [{ name: "N", type: "text" }] })).body;
  return { base, a, b };
}

describe("export and erase", () => {
  test("only touch bases the caller still owns", async () => {
    const { base, a } = await adaBase();
    await call("PUT", `/bases/${base.id}/members/bob`, ada, { role: "owner" });
    await call("POST", `/tables/${a.id}/rows`, bob, { values: { N: "bob secret" } });
    await call("PUT", `/tables/${a.id}/members/bob`, bob, { role: "owner" });
    expect((await call("DELETE", `/bases/${base.id}/members/ada`, bob)).status).toBe(200);
    expect((await call("DELETE", `/tables/${a.id}/members/ada`, bob)).status).toBe(200);
    expect((await call("GET", `/tables/${a.id}/rows`, ada)).status).toBe(404);

    expect((await call("GET", "/me/export", ada)).body.bases).toEqual([]);
    expect((await call("DELETE", "/me/data", ada)).body).toMatchObject({ bases: 0, tables: 0, rows: 0 });
    expect((await call("GET", `/tables/${a.id}/rows`, bob)).body.items.map((r: any) => r.values.N)).toEqual(["bob secret"]);
  });

  test("need the scope for the action", async () => {
    await adaBase();
    expect((await call("DELETE", "/me/data", person("ada", "table:read"))).status).toBe(403);
    expect((await call("GET", "/me/export", person("ada", "table:comment"))).status).toBe(403);
    expect((await call("GET", "/me/export", person("ada", "base:read"))).status).toBe(200);
    expect((await call("GET", "/bases", ada)).body.items).toHaveLength(1);
  });
});

describe("a stranger", () => {
  test("cannot tell a row or view that exists from one that does not", async () => {
    const { a } = await adaBase();
    const row = (await call("POST", `/tables/${a.id}/rows`, ada, { values: { N: "x" } })).body;
    const view = (await call("POST", `/tables/${a.id}/views`, ada, { name: "V", kind: "grid" })).body;
    const none = "row_0000000000000000";
    for (const [real, fake, method, body] of [
      [`/rows/${row.id}`, `/rows/${none}`, "GET"],
      [`/rows/${row.id}`, `/rows/${none}`, "PATCH", { values: { N: "y" } }],
      [`/rows/${row.id}`, `/rows/${none}`, "DELETE"],
      [`/views/${view.id}/rows`, `/views/view_0000000000000000/rows`, "GET"],
      [`/views/${view.id}`, `/views/view_0000000000000000`, "DELETE"],
    ] as const) {
      expect(await call(method, real, eve, body)).toEqual(await call(method, fake, eve, body));
      expect((await call(method, real, eve, body)).status).toBe(404);
    }
  });

  test("with a narrow scope gets the same refusal for an id that exists and one that does not", async () => {
    const { a } = await adaBase();
    const row = (await call("POST", `/tables/${a.id}/rows`, ada, { values: { N: "x" } })).body;
    const narrow = person("ada", "table:read");
    const real = await call("PATCH", `/rows/${row.id}`, narrow, { values: { N: "y" } });
    const fake = await call("PATCH", `/rows/row_0000000000000000`, narrow, { values: { N: "y" } });
    expect([real.status, fake.status]).toEqual([403, 403]);
    expect(real.body).toEqual(fake.body);
  });
});

describe("a link field", () => {
  test("needs the right to read the table it points at", async () => {
    const { base, a, b } = await adaBase();
    await call("PUT", `/tables/${a.id}/members/eve`, ada, { role: "owner" });
    expect((await call("GET", `/tables/${b.id}`, eve)).status).toBe(404);
    expect((await call("POST", `/tables/${a.id}/fields`, eve, { name: "L", type: "link", linkTable: b.id })).status).toBe(404);
    await call("POST", `/tables/${a.id}/fields`, ada, { name: "T", type: "text" });
    expect((await call("POST", `/tables/${a.id}/fields/T/type`, eve, { to: "link", linkTable: b.id })).status).toBe(404);
    expect((await call("POST", `/tables/${a.id}/fields`, eve, { name: "L2", type: "link", linkTable: "__x__" })).status).toBe(404);
    // Ada can read both, so she may link them.
    expect((await call("POST", `/tables/${a.id}/fields`, ada, { name: "L", type: "link", linkTable: b.id })).status).toBe(201);
    // Eve is not owner of the base, so she cannot create a table that links to B either.
    expect((await call("POST", `/bases/${base.id}/tables`, eve, { name: "C", fields: [{ name: "L", type: "link", linkTable: b.id }] })).status).toBe(404);
  });
});

describe("creating a table", () => {
  test("needs the owner role on the base", async () => {
    const { base } = await adaBase();
    await call("PUT", `/bases/${base.id}/members/bob`, ada, { role: "editor" });
    const refused = await call("POST", `/bases/${base.id}/tables`, bob, { name: "T" });
    expect([refused.status, refused.body.error.code]).toEqual([403, "FORBIDDEN"]);
    await call("PUT", `/bases/${base.id}/members/bob`, ada, { role: "owner" });
    expect((await call("POST", `/bases/${base.id}/tables`, bob, { name: "T" })).status).toBe(201);
  });
});
