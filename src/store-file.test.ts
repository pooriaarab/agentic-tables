// Failure cases for the file store, written with the wrapper:
//
//  1. The call is path first, with a region option.
//  2. Two stores on one path share their data, and concurrent writes all survive.
//  3. A transaction that throws writes nothing and leaves the store usable.
//  4. A file that is not JSON is never replaced.
//  5. A conflict from another process runs again, then gives up after 50 runs. Another error is not run again.
//  6. A lock that another process holds is not run again.
//  7. A file of the old shape is converted once, keeps every doc, and is saved as <db>.bak. A mutex left by a dead conversion is taken over.
//  8. A half-valid old file and a file of an unknown format are left as they are, on a read and on a write.
// The adapter of agentic-identity runs one call at a time on a path. A call on that path from inside a transaction
// on it waits for the transaction. Nothing in this package makes one.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StoreConflictError } from "agentic-identity";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
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
  await expect(createFileStore(path).put("rows", "x", { n: 1 })).rejects.toThrow(/not an agentic-identity store file/);
  expect(readFileSync(path, "utf8")).toBe("garbage");
});

test("converts a file of the old shape and keeps every doc", async () => {
  writeFileSync(path, JSON.stringify({ rows: { a: { n: 1 }, constructor: { n: 2 } }, tables: {} }));
  const store = createFileStore(path);
  expect(await store.get("rows", "a")).toEqual({ n: 1 });
  expect(await store.get("rows", "constructor")).toEqual({ n: 2 });
  await store.put("rows", "b", { n: 3 });
  expect(JSON.parse(readFileSync(path, "utf8")).format).toBe(1);
  expect(await createFileStore(path).get("rows", "b")).toEqual({ n: 3 });
  expect(JSON.parse(readFileSync(`${path}.bak`, "utf8")).rows.a).toEqual({ n: 1 });
  expect(existsSync(`${path}.migrate`)).toBe(false);
});

test("takes over the mutex of a conversion that died", async () => {
  writeFileSync(path, JSON.stringify({ rows: { a: { n: 1 } } }));
  mkdirSync(`${path}.migrate`);
  const old = new Date(Date.now() - 60_000);
  utimesSync(`${path}.migrate`, old, old);
  expect(await createFileStore(path).get("rows", "a")).toEqual({ n: 1 });
  expect(existsSync(`${path}.migrate`)).toBe(false);
});

test("leaves a half-valid old file alone", async () => {
  const text = JSON.stringify({ rows: { a: 5 } });
  writeFileSync(path, text);
  await expect(createFileStore(path).get("rows", "a")).rejects.toThrow();
  await expect(createFileStore(path).put("rows", "b", { n: 1 })).rejects.toThrow();
  expect(readFileSync(path, "utf8")).toBe(text);
});

test("leaves a file of an unknown format alone", async () => {
  const text = JSON.stringify({ format: 2, collections: {} });
  writeFileSync(path, text);
  await expect(createFileStore(path).put("rows", "b", { n: 1 })).rejects.toThrow();
  expect(readFileSync(path, "utf8")).toBe(text);
});

test("a conflict is run again, a lock or another error is not, and 50 conflicts give up", async () => {
  vi.resetModules();
  const put = vi.fn();
  vi.doMock("agentic-identity/file", () => ({ createFileStore: () => ({ region: "unknown", get: vi.fn(), query: vi.fn(), put, delete: put, transaction: put }) }));
  const { createFileStore: wrapped } = await import("./store-file.js");
  const store = wrapped(path);
  put.mockRejectedValueOnce(new StoreConflictError("the store file changed during the write")).mockResolvedValue(undefined);
  await store.put("rows", "a", { n: 1 });
  expect(put).toHaveBeenCalledTimes(2);

  put.mockReset().mockRejectedValue(new StoreConflictError("the store file changed during the write"));
  await expect(store.delete("rows", "a")).rejects.toBeInstanceOf(StoreConflictError);
  expect(put).toHaveBeenCalledTimes(50);

  put.mockReset().mockRejectedValue(new StoreConflictError("the store file is locked by another process"));
  await expect(store.transaction(async () => 1)).rejects.toThrow(/locked/);
  expect(put).toHaveBeenCalledTimes(1);

  put.mockReset().mockRejectedValue(new TypeError("boom"));
  await expect(store.put("rows", "a", { n: 1 })).rejects.toThrow("boom");
  expect(put).toHaveBeenCalledTimes(1);
  vi.doUnmock("agentic-identity/file");
});
