// Grants are keyed on a kind and an id (agentic-identity 0.4). Failure cases, written before the code:
//  1. A person and an agent with one id share a role: a grant to the person gives the agent access, or a revoke of one removes the other.
//  2. A share or unshare without a kind, or with an unknown kind, falls back to a default kind.
//  3. Deleting a table, a base, or a person's data leaves grants (and resources) in the store.
//  4. A delete that stopped after the data went, or after some table grants went, cannot be repeated.
//  5. A base or a table with too many owners fails after some grants are gone. A credential without table:admin fails after the same.
import { createMemoryStore, createSharing } from "agentic-identity";
import { beforeEach, describe, expect, test } from "vitest";
import { resolveCaller } from "./caller.js";
import { createTables } from "./index.js";
import { createApp } from "./worker.js";

const who = (kind: string, id: string) => ({ "x-principal-id": id, "x-principal-kind": kind });
const [ada, personSam, agentSam] = [who("human", "ada"), who("human", "sam"), who("agent", "sam")];

let app: ReturnType<typeof createApp>;
let store: ReturnType<typeof createMemoryStore>;
async function call(method: string, path: string, headers: Record<string, string>, body?: unknown) {
  const res = await app.fetch(new Request(`http://x/api/v1/tables${path}`, { method, headers: { ...headers, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }));
  return { status: res.status, body: (await res.json()) as any };
}
const count = async (collection: string) => (await store.query(collection, {})).items.length;

beforeEach(() => {
  store = createMemoryStore({ region: "eu" });
  app = createApp(createTables(store), createSharing(store));
});

async function setup() {
  const base = (await call("POST", "/bases", ada, { name: "B" })).body;
  const table = (await call("POST", `/bases/${base.id}/tables`, ada, { name: "T", fields: [{ name: "N", type: "text" }] })).body;
  return { base, table };
}

describe("grants by kind and id", () => {
  test("a person and an agent with one id hold separate roles", async () => {
    const { base, table } = await setup();
    expect((await call("PUT", `/bases/${base.id}/members/human/sam`, ada, { role: "editor" })).status).toBe(200);
    expect((await call("GET", `/tables/${table.id}`, personSam)).status).toBe(200);
    expect((await call("GET", `/tables/${table.id}`, agentSam)).status).toBe(404);

    expect((await call("PUT", `/bases/${base.id}/members/agent/sam`, ada, { role: "viewer" })).status).toBe(200);
    expect((await call("POST", `/tables/${table.id}/rows`, personSam, { values: { N: "p" } })).status).toBe(201);
    expect((await call("POST", `/tables/${table.id}/rows`, agentSam, { values: { N: "a" } })).status).toBe(403);

    // Taking the role back from the person leaves the agent's role.
    expect((await call("DELETE", `/bases/${base.id}/members/human/sam`, ada)).status).toBe(200);
    expect((await call("GET", `/tables/${table.id}`, personSam)).status).toBe(404);
    expect((await call("GET", `/tables/${table.id}`, agentSam)).status).toBe(200);
  });

  test("a table grant to one kind does not reach the other", async () => {
    const { table } = await setup();
    await call("PUT", `/tables/${table.id}/members/agent/sam`, ada, { role: "editor" });
    expect((await call("GET", `/tables/${table.id}`, agentSam)).status).toBe(200);
    expect((await call("GET", `/tables/${table.id}`, personSam)).status).toBe(404);
  });

  test("a subject kind is required, and must be human or agent", async () => {
    const { base } = await setup();
    for (const kind of ["user_token", "agent_of_human", "robot"]) {
      const put = await call("PUT", `/bases/${base.id}/members/${kind}/sam`, ada, { role: "viewer" });
      expect([put.status, put.body.error.message]).toEqual([400, "subject kind must be one of human, agent"]);
      expect((await call("DELETE", `/bases/${base.id}/members/${kind}/sam`, ada)).status).toBe(400);
    }
    // The old path with no kind is no route.
    expect((await call("PUT", `/bases/${base.id}/members/sam`, ada, { role: "viewer" })).status).toBe(404);
    expect(await count("grants")).toBe(2);
  });
});

describe("delete removes grants", () => {
  test("deleting a table removes its grants and its resource", async () => {
    const { base, table } = await setup();
    await call("PUT", `/tables/${table.id}/members/agent/sam`, ada, { role: "editor" });
    const [grants, resources] = [await count("grants"), await count("resources")];
    expect((await call("DELETE", `/tables/${table.id}`, ada)).status).toBe(200);
    expect([await count("grants"), await count("resources")]).toEqual([grants - 2, resources - 1]);
    expect((await call("GET", `/bases/${base.id}/tables`, ada)).status).toBe(200);
  });

  test("deleting a base removes every grant on it and on its tables", async () => {
    const { base, table } = await setup();
    await call("PUT", `/bases/${base.id}/members/human/sam`, ada, { role: "editor" });
    await call("PUT", `/tables/${table.id}/members/agent/sam`, ada, { role: "editor" });
    expect(await count("grants")).toBeGreaterThan(3);
    expect((await call("DELETE", `/bases/${base.id}`, ada)).status).toBe(200);
    expect(await count("grants")).toBe(0);
    expect(await count("resources")).toBe(0);
    expect((await call("GET", `/tables/${table.id}`, agentSam)).status).toBe(404);
  });

  test("erasing the data of a person removes the grants on their bases, and keeps other bases", async () => {
    const mine = await setup();
    await call("PUT", `/bases/${mine.base.id}/members/agent/sam`, ada, { role: "editor" });
    const other = (await call("POST", "/bases", personSam, { name: "S" })).body;
    expect((await call("DELETE", "/me/data", ada)).body).toMatchObject({ bases: 1 });
    const sharing = createSharing(store);
    const left = await sharing.listGrants(await resolveCaller({ id: "sam", kind: "human" }), other.id);
    expect(left.grants).toEqual([{ resourceId: other.id, subjectKind: "human", subjectId: "sam", role: "owner" }]);
    expect(await count("grants")).toBe(1);
    expect(await count("resources")).toBe(1);
    // The agent lost the role it held on the erased base.
    expect((await call("GET", `/bases/${mine.base.id}/tables`, agentSam)).status).toBe(404);
  });

  test("a repeat of a delete that stopped after the data went removes the grants", async () => {
    const { base, table } = await setup();
    // The data is gone, the grants are not: what a crash between the two steps leaves.
    await createTables(store).deleteTable(table.id);
    expect((await call("DELETE", `/tables/${table.id}`, ada)).status).toBe(200);
    expect(await count("grants")).toBe(1);
    await createTables(store).deleteBase(base.id);
    expect((await call("DELETE", `/bases/${base.id}`, ada)).status).toBe(200);
    expect(await count("grants")).toBe(0);
  });
});

describe("a delete that stops half way", () => {
  test("can be repeated when a table grant went and its data did not", async () => {
    const { base, table } = await setup();
    const second = (await call("POST", `/bases/${base.id}/tables`, ada, { name: "U", fields: [{ name: "N", type: "text" }] })).body;
    // What a crash leaves, or a claim that never registered a table: one table has no resource.
    await createSharing(store).deleteResource(await resolveCaller({ id: "ada", kind: "human" }), table.id);
    expect((await call("DELETE", `/bases/${base.id}`, ada)).status).toBe(200);
    expect(await count("grants")).toBe(0);
    expect(await count("resources")).toBe(0);
    expect((await call("GET", `/tables/${second.id}`, ada)).status).toBe(404);

    const again = await setup();
    await createSharing(store).deleteResource(await resolveCaller({ id: "ada", kind: "human" }), again.table.id);
    expect((await call("DELETE", "/me/data", ada)).body).toMatchObject({ bases: 1, tables: 1 });
    expect(await count("grants")).toBe(0);
  });

  test("is refused before any grant goes when a table has too many owners", async () => {
    const { base, table } = await setup();
    const extra = (await call("POST", `/bases/${base.id}/tables`, ada, { name: "U", fields: [{ name: "N", type: "text" }] })).body;
    for (let i = 0; i < 101; i++) await call("PUT", `/tables/${extra.id}/members/agent/o${i}`, ada, { role: "owner" });
    const [grants, resources] = [await count("grants"), await count("resources")];
    for (const attempt of [() => call("DELETE", `/bases/${base.id}`, ada), () => call("DELETE", "/me/data", ada)]) {
      const refused = await attempt();
      expect([refused.status, refused.body.error.code]).toEqual([400, "BAD_REQUEST"]);
      expect([await count("grants"), await count("resources")]).toEqual([grants, resources]);
    }
    expect((await call("GET", `/tables/${table.id}`, ada)).status).toBe(200);
  });

  test("is refused before any grant goes for a credential without table:admin", async () => {
    const { base } = await setup();
    const narrow = { ...ada, "x-principal-scopes": "base:admin" };
    const [grants, resources] = [await count("grants"), await count("resources")];
    expect((await call("DELETE", `/bases/${base.id}`, narrow)).status).toBe(403);
    expect((await call("DELETE", "/me/data", narrow)).status).toBe(403);
    expect([await count("grants"), await count("resources")]).toEqual([grants, resources]);
  });
});

test("an erase whose last step fails names the bases, and a base delete finishes them", async () => {
  const first = await setup();
  const second = await setup();
  // The base resource delete fails after the data went, as a store outage would.
  const sharing = createSharing(store);
  const real = sharing.deleteResource.bind(sharing);
  const failing = createSharing(store);
  failing.deleteResource = async (ctx, id) => (id === first.base.id ? Promise.reject(new Error("store down")) : real(ctx, id));
  app = createApp(createTables(store), failing);
  const erased = await call("DELETE", "/me/data", ada);
  expect([erased.status, erased.body.error.code]).toEqual([409, "ERASE_INCOMPLETE"]);
  expect(erased.body.error.message).toContain(first.base.id);
  expect(erased.body.error.message).not.toContain(second.base.id);
  // The data is gone for both. The other base is clean, and the named one is finished by a base delete.
  expect(await count("resources")).toBe(1);
  app = createApp(createTables(store), createSharing(store));
  expect((await call("DELETE", `/bases/${first.base.id}`, ada)).status).toBe(200);
  expect(await count("grants")).toBe(0);
  expect(await count("resources")).toBe(0);
});
