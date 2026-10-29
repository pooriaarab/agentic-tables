// Access checks through the real HTTP app on a memory store: fast, and the same code the Worker runs.
// The wrangler suite covers the same guard on D1.
//
// Failure cases, written from review findings:
//  1. A caller who gave a base away still exports or erases it through /me/*.
//  2. A credential with a read-only scope erases data through /me/data.
//  3. A row or view id answers differently for a stranger when it exists and when it does not.
//  4. A caller with a role on table A links a field to table B, and learns B exists.
//  5. An editor creates a table in a base.
//  6. A person is revoked on a base and keeps the owner role on a table they made.
//  7. A caller gave a base away, and the rows they wrote there are neither exported nor erased.
//  8. A caller with a role on table A inserts a link value and learns that a row of table B exists.
// 13. A base from an earlier version (no owner kind, no sharing record) stays behind while export, erase, and a new base report success.
// 10. Export with a base:read credential answers 200 with no bases.
// 11. A revoke on a base removes some table grants, then fails: a self-revoke, a missing scope, a bad subject id.
// 12. A body names a link field twice, an empty list under one key and a row id under the other. Clearing a link with null or [] needs the right to read the linked table.
//  9. An agent that acts for a person exports or erases that person's data.
// 14. Two claims of one base at the same time: one of them answers 404 instead of success.
// 15. A base gets another owner kind while a claim runs: the claim must refuse, and must not overwrite the kind.
import { createMemoryStore, createSharing } from "agentic-identity";
import { beforeEach, describe, expect, test } from "vitest";
import { createTables } from "./index.js";
import { createApp } from "./worker.js";

const person = (id: string, scopes?: string) => ({ "x-principal-id": id, "x-principal-kind": "human", ...(scopes ? { "x-principal-scopes": scopes } : {}) });
const [ada, bob, eve] = [person("ada"), person("bob"), person("eve")];

let app: ReturnType<typeof createApp>;
let store: ReturnType<typeof createMemoryStore>;
async function call(method: string, path: string, who: Record<string, string>, body?: unknown) {
  const res = await app.fetch(new Request(`http://x/api/v1/tables${path}`, { method, headers: { ...who, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }));
  return { status: res.status, body: (await res.json()) as any };
}

beforeEach(() => {
  store = createMemoryStore({ region: "eu" });
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
    // Export needs the same scope as erase: with less, it must not answer 200 with an empty list.
    expect((await call("GET", "/me/export", person("ada", "base:read"))).status).toBe(403);
    expect((await call("GET", "/me/export", person("ada", "base:admin"))).body.bases).toHaveLength(1);
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

describe("a revoke", () => {
  test("on a base also takes back the tables the person made", async () => {
    const { base } = await adaBase();
    await call("PUT", `/bases/${base.id}/members/bob`, ada, { role: "owner" });
    const t = (await call("POST", `/bases/${base.id}/tables`, bob, { name: "Bobs" })).body;
    expect((await call("DELETE", `/bases/${base.id}/members/bob`, ada)).status).toBe(200);
    for (const [method, path, body] of [["GET", `/tables/${t.id}`], ["PUT", `/tables/${t.id}/members/eve`, { role: "owner" }], ["DELETE", `/tables/${t.id}`]] as const) {
      expect((await call(method, path, bob, body)).status).toBe(404);
    }
    expect((await call("GET", `/tables/${t.id}`, ada)).status).toBe(200);
  });
});

describe("rows a caller wrote in a base they gave away", () => {
  test("are still exported and erased for the caller", async () => {
    const { base, a } = await adaBase();
    await call("POST", `/tables/${a.id}/rows`, ada, { values: { N: "mine" } });
    await call("PUT", `/bases/${base.id}/members/bob`, ada, { role: "owner" });
    await call("DELETE", `/bases/${base.id}/members/ada`, bob);
    await call("DELETE", `/tables/${a.id}/members/ada`, bob);
    const exported = (await call("GET", "/me/export", ada)).body;
    expect([exported.bases, exported.authoredRows.map((r: any) => r.values.N)]).toEqual([[], ["mine"]]);
    expect((await call("DELETE", "/me/data", ada)).body).toMatchObject({ bases: 0, authoredRows: 1 });
    expect((await call("GET", `/tables/${a.id}/rows`, bob)).body.items).toEqual([]);
  });
});

describe("link values", () => {
  test("need the right to read the linked table", async () => {
    const { a, b } = await adaBase();
    await call("POST", `/tables/${a.id}/fields`, ada, { name: "L", type: "link", linkTable: b.id });
    const target = (await call("POST", `/tables/${b.id}/rows`, ada, { values: { N: "t" } })).body;
    await call("PUT", `/tables/${a.id}/members/eve`, ada, { role: "editor" });
    for (const id of [target.id, "row_0000000000000000"]) {
      const res = await call("POST", `/tables/${a.id}/rows`, eve, { values: { L: [id] } });
      expect([res.status, res.body.error.code]).toEqual([404, "NOT_FOUND"]);
    }
    expect((await call("POST", `/tables/${a.id}/rows`, eve, { values: { N: "no link" } })).status).toBe(201);
    expect((await call("POST", `/tables/${a.id}/rows`, ada, { values: { L: [target.id] } })).status).toBe(201);
  });
});

describe("an agent that acts for a person", () => {
  test("cannot export or erase the data of that person", async () => {
    await adaBase();
    const agent = { "x-principal-id": "ag1", "x-principal-kind": "agent_of_human", "x-principal-chain": "human:ada" };
    expect((await call("GET", "/me/export", agent)).status).toBe(403);
    expect((await call("DELETE", "/me/data", agent)).status).toBe(403);
    expect((await call("GET", "/me/export", ada)).body.bases).toHaveLength(1);
  });

  test("with a narrow scope gets one refusal for a view that exists and one that does not", async () => {
    const { a } = await adaBase();
    const view = (await call("POST", `/tables/${a.id}/views`, ada, { name: "V", kind: "grid" })).body;
    const narrow = person("ada", "base:read");
    const real = await call("GET", `/views/${view.id}/rows`, narrow);
    const fake = await call("GET", `/views/view_0000000000000000/rows`, narrow);
    expect([real.status, fake.status]).toEqual([403, 403]);
    expect(real.body).toEqual(fake.body);
  });
});

describe("a revoke on a base", () => {
  test("changes nothing when it must fail, and says why", async () => {
    const { base, a } = await adaBase();
    await call("PUT", `/bases/${base.id}/members/bob`, ada, { role: "owner" });
    const bobs = (await call("POST", `/bases/${base.id}/tables`, bob, { name: "Bobs" })).body;
    // Leaving yourself from a base with tables is refused before any grant is touched.
    const self = await call("DELETE", `/bases/${base.id}/members/bob`, bob);
    expect([self.status, self.body.error.code]).toEqual([400, "BAD_REQUEST"]);
    expect((await call("GET", `/tables/${bobs.id}`, bob)).status).toBe(200);
    // A credential that cannot admin tables is refused with 403, not 500, and nothing is revoked.
    const scoped = await call("DELETE", `/bases/${base.id}/members/bob`, person("ada", "base:admin"));
    expect([scoped.status, scoped.body.error.code]).toEqual([403, "FORBIDDEN"]);
    expect((await call("GET", `/tables/${bobs.id}`, bob)).status).toBe(200);
    expect((await call("GET", `/tables/${a.id}`, bob)).status).toBe(200);
    // A subject id that grant would refuse is a 400 here too.
    for (const bad of ["a%2Fb", "x".repeat(250), "x%20y"]) expect((await call("DELETE", `/bases/${base.id}/members/${bad}`, ada)).status).toBe(400);
  });
});

describe("clearing a link", () => {
  test("names no row, so it needs no right on the linked table", async () => {
    const { a, b } = await adaBase();
    await call("POST", `/tables/${a.id}/fields`, ada, { name: "L", type: "link", linkTable: b.id });
    const row = (await call("POST", `/tables/${a.id}/rows`, ada, { values: { N: "x" } })).body;
    await call("PUT", `/tables/${a.id}/members/eve`, ada, { role: "editor" });
    for (const empty of [null, []]) expect((await call("PATCH", `/rows/${row.id}`, eve, { values: { L: empty } })).status).toBe(200);

    // One field under two keys, its name and its id: an empty list under one must not hide a row id under the other.
    const target = (await call("POST", `/tables/${b.id}/rows`, ada, { values: { N: "t" } })).body;
    const id = (await call("GET", `/tables/${a.id}`, ada)).body.fields.find((f: any) => f.name === "L").id;
    for (const rowId of [target.id, "row_0000000000000000"]) {
      const res = await call("POST", `/tables/${a.id}/rows`, eve, { values: { L: [], [id]: [rowId] } });
      expect([res.status, res.body.error.code]).toEqual([404, "NOT_FOUND"]);
    }
  });
});

describe("a base from an earlier version", () => {
  test("stops export, erase, and new bases until its owner claims it", async () => {
    const raw = createTables(store);
    const old = await raw.createBase("old", { id: "ada", kind: "human" });
    const table = await raw.createTable(old.id, "T", [{ name: "N", type: "text" }]);
    await raw.insertRow(table.id, { N: "old row" }, { id: "ada", kind: "human" });
    const { ownerKind: _kind, ...legacy } = (await store.get("bases", old.id))!;
    await store.put("bases", old.id, legacy);

    // Nothing is touched, and the answer names the base.
    for (const [method, path] of [["GET", "/me/export"], ["DELETE", "/me/data"], ["POST", "/bases"]] as const) {
      const res = await call(method, path, ada, method === "POST" ? { name: "new" } : undefined);
      expect([res.status, res.body.error.code]).toEqual([409, "LEGACY_BASE"]);
      expect(res.body.error.message).toContain(old.id);
    }
    expect((await raw.listRows(table.id)).items).toHaveLength(1);
    // Another principal is not held up, and cannot claim it.
    expect((await call("POST", "/bases", bob, { name: "bobs" })).status).toBe(201);
    expect((await call("POST", `/bases/${old.id}/claim`, bob)).status).toBe(404);
    expect((await call("POST", `/bases/${old.id}/claim`, person("ada", "base:read"))).status).toBe(403);
    expect((await call("GET", `/tables/${table.id}/rows`, ada)).status).toBe(404);

    // The owner claims it. The base and its table are then usable, and export and erase cover them.
    expect((await call("POST", `/bases/${old.id}/claim`, ada)).body).toEqual({ baseId: old.id, owner: { id: "ada", kind: "human" } });
    expect((await call("GET", `/tables/${table.id}/rows`, ada)).body.items.map((r: any) => r.values.N)).toEqual(["old row"]);
    expect((await call("GET", `/tables/${table.id}/rows`, bob)).status).toBe(404);
    expect((await call("POST", `/bases/${old.id}/claim`, ada)).status).toBe(404);
    expect((await call("GET", "/me/export", ada)).body.bases).toHaveLength(1);
    expect((await call("DELETE", "/me/data", ada)).body).toMatchObject({ bases: 1, tables: 1, rows: 1 });
  });

  // A base made by a build that had sharing but no owner kind, and given away. Its former owner holds no role, so the claim
  // cannot register the tables again. It must still clear the block, or export and erase stay closed for good.
  test("can be claimed by an owner who gave it away", async () => {
    const { base } = await adaBase();
    await call("PUT", `/bases/${base.id}/members/bob`, ada, { role: "owner" });
    expect((await call("DELETE", `/bases/${base.id}/members/ada`, bob)).status).toBe(200);
    const { ownerKind: _kind, ...legacy } = (await store.get("bases", base.id))!;
    await store.put("bases", base.id, legacy);

    expect((await call("GET", "/me/export", ada)).body.error.code).toBe("LEGACY_BASE");
    expect((await call("POST", `/bases/${base.id}/claim`, bob)).status).toBe(404);
    expect((await call("POST", `/bases/${base.id}/claim`, ada)).status).toBe(200);
    expect((await call("GET", "/me/export", ada)).body.bases).toEqual([]);
    expect((await call("DELETE", "/me/data", ada)).status).toBe(200);
    expect((await call("POST", "/bases", ada, { name: "fresh" })).status).toBe(201);
    expect((await call("GET", `/bases/${base.id}/tables`, bob)).body.items).toHaveLength(2);
  });

  // A credential that cannot write tables must not leave a half claim: a retry must not turn into a success that skips a table.
  test("is refused for a credential without the scopes it needs, every time", async () => {
    const raw = createTables(store);
    const old = await raw.createBase("old", { id: "ada", kind: "human" });
    const table = await raw.createTable(old.id, "T", [{ name: "N", type: "text" }]);
    const { ownerKind: _kind, ...legacy } = (await store.get("bases", old.id))!;
    await store.put("bases", old.id, legacy);

    for (const scopes of ["base:admin", "base:admin,table:read"]) {
      for (let attempt = 0; attempt < 2; attempt++) expect((await call("POST", `/bases/${old.id}/claim`, person("ada", scopes))).status).toBe(403);
    }
    expect((await call("GET", "/me/export", ada)).body.error.code).toBe("LEGACY_BASE");
    expect((await call("POST", `/bases/${old.id}/claim`, ada)).status).toBe(200);
    expect((await call("GET", `/tables/${table.id}/rows`, ada)).status).toBe(200);
  });

  // Makes a base look like one from an earlier version: no owner kind. The store still holds its sharing record.
  async function makeLegacy(baseId: string): Promise<void> {
    const { ownerKind: _kind, ...legacy } = (await store.get("bases", baseId))!;
    await store.put("bases", baseId, legacy);
  }

  // A store whose first read of `bases` runs `during` before it returns. That read is the claim's legacy-list check.
  function racingStore(during: () => Promise<void>): typeof store {
    let started = false;
    return {
      ...store,
      query: async (...args: Parameters<typeof store.query>) => {
        const page = await store.query(...args);
        if (args[0] === "bases" && !started) {
          started = true;
          await during();
        }
        return page;
      },
    } as typeof store;
  }

  // Failure case, written before the fix: two claims of one base by the same owner. The duplicate starts after the first has read the
  // legacy list and before the first writes the owner kind. The first claim then finds the kind already set and answers 404.
  test("a duplicate claim that races the first one returns success", async () => {
    const raw = createTables(store);
    const old = await raw.createBase("old", { id: "ada", kind: "human" });
    const table = await raw.createTable(old.id, "T", [{ name: "N", type: "text" }]);
    await makeLegacy(old.id);

    // The first claim reads the legacy list, then the duplicate runs its whole claim before the first one writes.
    let duplicate: { status: number; body: any } | undefined;
    const racing = racingStore(async () => void (duplicate = await call("POST", `/bases/${old.id}/claim`, ada)));
    app = createApp(createTables(racing), createSharing(racing));
    const first = await call("POST", `/bases/${old.id}/claim`, ada);
    expect(duplicate).toMatchObject({ status: 200, body: { baseId: old.id, owner: { id: "ada", kind: "human" } } });
    expect(first).toMatchObject({ status: 200, body: { baseId: old.id, owner: { id: "ada", kind: "human" } } });
    expect((await call("GET", `/tables/${table.id}/rows`, ada)).status).toBe(200);
    expect((await call("GET", "/me/export", ada)).body.bases).toHaveLength(1);
  });

  // Failure case 14: two claims of one base start at the same time. Both answer 200 with the same result, and the base keeps one kind.
  test("two claims at once both succeed", async () => {
    const raw = createTables(store);
    const old = await raw.createBase("old", { id: "ada", kind: "human" });
    const table = await raw.createTable(old.id, "T", [{ name: "N", type: "text" }]);
    await raw.insertRow(table.id, { N: "old row" }, { id: "ada", kind: "human" });
    await makeLegacy(old.id);

    const [first, second] = await Promise.all([call("POST", `/bases/${old.id}/claim`, ada), call("POST", `/bases/${old.id}/claim`, ada)]);
    expect(first).toEqual({ status: 200, body: { baseId: old.id, owner: { id: "ada", kind: "human" } } });
    expect(second).toEqual(first);
    expect((await store.get("bases", old.id))!.ownerKind).toBe("human");
    expect((await call("GET", `/tables/${table.id}/rows`, ada)).body.items.map((r: any) => r.values.N)).toEqual(["old row"]);
  });

  // Failure case 15: the base gets the kind "agent" while the human claim runs. The claim must refuse with 404 and keep "agent".
  test("a claim with a different kind is refused during a race", async () => {
    const raw = createTables(store);
    const old = await raw.createBase("old", { id: "ada", kind: "human" });
    await raw.createTable(old.id, "T", [{ name: "N", type: "text" }]);
    await makeLegacy(old.id);

    // The human claim reads the legacy list. Then an agent with the same owner id claims the base and writes its kind.
    const agent = { "x-principal-id": "ada", "x-principal-kind": "agent" };
    let agentClaim: { status: number; body: any } | undefined;
    const racing = racingStore(async () => void (agentClaim = await call("POST", `/bases/${old.id}/claim`, agent)));
    app = createApp(createTables(racing), createSharing(racing));

    const human = await call("POST", `/bases/${old.id}/claim`, ada);
    expect(agentClaim).toMatchObject({ status: 200, body: { owner: { id: "ada", kind: "agent" } } });
    expect(human).toMatchObject({ status: 404, body: { error: { code: "NOT_FOUND" } } });
    expect((await store.get("bases", old.id))!.ownerKind).toBe("agent");
  });
});
