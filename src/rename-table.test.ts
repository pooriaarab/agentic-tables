// Failure cases: invalid names; missing ids; lost schema/rows/views; lost concurrent
// field changes; editor/viewer writes; absent role; insufficient admin scope.
import { createMemoryStore, createSharing } from "agentic-identity";
import { expect, test } from "vitest";
import { createTables } from "./tables.js";
import { createUnsafeApp } from "./app.js";
import { createClient, TablesClientError } from "./client.js";

test("rename persists through the HTTP client and preserves dependent data", async () => {
  const store = createMemoryStore({ region: "eu" });
  const tables = createTables(store);
  const app = createUnsafeApp(tables, createSharing(store));
  const client = (id: string, scopes?: string[]) => createClient({ baseUrl: "http://localhost", principal: { id, kind: "human", scopes: scopes?.join(",") }, fetch: ((input, init) => app.fetch(new Request(input, init))) as typeof fetch });
  const owner = client("owner");
  const base = await owner.createBase("Base");
  const table = await owner.createTable(base.id, "Before", [{ name: "Name", type: "text" }]);
  const row = await owner.insertRow(table.id, { Name: "Value" });
  const view = await owner.createView(table.id, { name: "All", kind: "grid" });
  const renamed = await owner.renameTable(table.id, " After ");
  expect(renamed).toMatchObject({ ...table, name: "After", updatedAt: expect.any(String) });
  expect((await createTables(store).getTable(table.id)).name).toBe("After");
  expect((await owner.listTables(base.id))[0]!.name).toBe("After");
  expect(await owner.getRow(row.id)).toEqual(row);
  expect((await owner.runView(view.id)).kind).toBe("grid");
  for (const name of ["", "  ", "x".repeat(201), null, 3]) {
    await expect(tables.renameTable(table.id, name as string)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(owner.renameTable(table.id, name as string)).rejects.toBeInstanceOf(TablesClientError);
    expect((await tables.getTable(table.id)).name).toBe("After");
  }
  await expect(owner.renameTable("missing", "Name")).rejects.toMatchObject({ code: "NOT_FOUND" });
  for (const role of ["editor", "viewer"] as const) {
    await owner.shareTable(table.id, { id: role, kind: "human" }, role);
    await expect(client(role).renameTable(table.id, "Denied")).rejects.toMatchObject({ code: "FORBIDDEN" });
  }
  await expect(client("stranger").renameTable(table.id, "Denied")).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(client("owner", ["table:read", "table:write"]).renameTable(table.id, "Denied")).rejects.toMatchObject({ code: "FORBIDDEN" });
  await Promise.all([tables.renameTable(table.id, "Final"), tables.addField(table.id, { name: "Age", type: "number" })]);
  expect(await tables.getTable(table.id)).toMatchObject({ name: "Final", fields: [{ name: "Name" }, { name: "Age" }] });
});
