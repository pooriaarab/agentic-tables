// Share links over the HTTP app with a memory store.
// Ways it can fail:
//  - an app made with no store lists or revokes links and crashes: it must answer 503 UNAVAILABLE
//  - a damaged link record shows as live: a bad revokedAt, a bad expiresAt, a key that differs from its id, or another resource
//  - a list is cut at 200 and does not say so
import { createMemoryStore, createSharing } from "agentic-identity";
import { beforeEach, describe, expect, test } from "vitest";
import { createUnsafeApp } from "./app.js";
import { createTables } from "./index.js";

const ada = { "x-principal-id": "ada", "x-principal-kind": "human" };
let store: ReturnType<typeof createMemoryStore>;
let app: ReturnType<typeof createUnsafeApp>;
const call = async (a: ReturnType<typeof createUnsafeApp>, method: string, path: string, body?: unknown) => {
  const res = await a.fetch(new Request(`http://x/api/v1/tables${path}`, { method, headers: { ...ada, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }));
  return { status: res.status, body: (await res.json()) as any };
};

beforeEach(() => {
  store = createMemoryStore({ region: "eu" });
  app = createUnsafeApp(createTables(store), createSharing(store), store);
});

describe("links without a store", () => {
  test("a create, a list, and a revoke answer 503", async () => {
    const bare = createUnsafeApp(createTables(store), createSharing(store));
    const base = (await call(bare, "POST", "/bases", { name: "B" })).body;
    for (const [method, path, body] of [["POST", `/bases/${base.id}/links`, { role: "viewer" }], ["GET", `/bases/${base.id}/links`], ["DELETE", `/bases/${base.id}/links/abc`]] as const) {
      expect(await call(bare, method, path, body)).toMatchObject({ status: 503, body: { error: { code: "UNAVAILABLE" } } });
    }
  });
});

describe("a damaged link record", () => {
  test("fails closed and the list says it is not complete", async () => {
    const base = (await call(app, "POST", "/bases", { name: "B" })).body;
    const put = (key: string, extra: Record<string, unknown>, id = key, resourceId = base.id) => store.transaction((tx) => tx.put("links", key, { id, resourceId, role: "viewer", tokenHash: "x", ...extra }));
    await put("revoked", { revokedAt: true });
    await put("bad-expiry", { expiresAt: "soon" });
    await put("key-a", {}, "key-b");
    await put("elsewhere", {}, "elsewhere", "other-resource");
    await put("owner-role", { role: "owner" });
    const listed = (await call(app, "GET", `/bases/${base.id}/links`)).body;
    expect(listed).toEqual({ items: [{ id: "revoked", role: "viewer", signedInOnly: false, revokedAt: 0 }], skipped: 3 });
  });

  test("a list of more than 200 links says it was cut, and live links come first", async () => {
    const base = (await call(app, "POST", "/bases", { name: "B" })).body;
    await store.transaction(async (tx) => {
      for (let i = 0; i < 201; i++) await tx.put("links", `old-${i}`, { id: `old-${i}`, resourceId: base.id, role: "viewer", tokenHash: "x", revokedAt: 1 });
    });
    const live = (await call(app, "POST", `/bases/${base.id}/links`, { role: "viewer" })).body;
    const listed = (await call(app, "GET", `/bases/${base.id}/links`)).body;
    expect([listed.items.length, listed.truncated, listed.items[0].id]).toEqual([200, true, live.id]);
  });
});
