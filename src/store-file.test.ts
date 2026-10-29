// The file store is `agentic-identity/file`, which has its own lock and contract tests. These cases cover what
// this package relies on: the path-first signature, shared data between stores, the file after a failed
// transaction, and two Tables on one file. A store call made inside a transaction of the same path waits for
// that transaction, as agentic-identity serializes calls on a path. Nothing in this package makes one.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { createTables } from "./index.js";
import { createFileStore } from "./store-file.js";

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agentic-tables-file-"));
  path = join(dir, "db.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("two stores on one path share their data, and concurrent writes all survive", async () => {
  const a = createFileStore(path);
  const b = createFileStore(path);
  await Promise.all(Array.from({ length: 40 }, (_, i) => (i % 2 ? a : b).put("rows", `r${i}`, { n: i })));
  expect((await createFileStore(path).query("rows", { limit: 100 })).items).toHaveLength(40);
});

test("takes the region option", () => {
  expect(createFileStore(path, { region: "eu" }).region).toBe("eu");
});

test("a transaction that throws writes nothing and leaves the store usable", async () => {
  const store = createFileStore(path);
  await expect(store.transaction(async (tx) => {
    await tx.get("rows", "a");
    await tx.put("rows", "a", { n: 1 });
    throw new Error("stop");
  })).rejects.toThrow("stop");
  expect(await store.get("rows", "a")).toBeNull();
  await store.put("rows", "b", { n: 2 });
  expect(await store.get("rows", "b")).toEqual({ n: 2 });
});

test("two Tables on one file lose no concurrent change", async () => {
  const one = createTables(createFileStore(path));
  const two = createTables(createFileStore(path));
  const ada = { id: "ada", kind: "human" } as const;
  const base = await one.createBase("b", ada);
  const table = await one.createTable(base.id, "T", [{ name: "Name", type: "text" }]);
  await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? one : two).insertRow(table.id, { Name: `r${i}` }, ada)));
  expect((await two.queryRows(table.id, { limit: 100 })).items).toHaveLength(20);
});

test("a file that is not JSON is never replaced", async () => {
  writeFileSync(path, "garbage");
  await expect(createFileStore(path).put("rows", "x", { n: 1 })).rejects.toThrow();
});
