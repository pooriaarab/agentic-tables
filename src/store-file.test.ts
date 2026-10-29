// Failure cases for the file store, written before the code.
//
//  1. Two stores on one file write at the same time: every write survives.
//  2. A store that opened the file before another store wrote still keeps that
//     write when it writes (it reads the file again under the lock).
//  3. A lock whose owner is a dead process is taken over.
//  4. A lock that is too old is taken over, even if its owner is alive.
//  5. A fresh lock held by a live process is never taken: the write fails.
//  6. A lock with content that does not parse, or a bad pid or time, counts as
//     live: the write fails, and the lock stays.
//  7. A database file that is not JSON is never replaced: the write fails.
//  8. A transaction that throws writes nothing and releases the lock.
//  9. A lock that a takeover replaced is not removed by its old owner.
// The two-store test is the guard check: with the lock removed it must fail.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createFileStore } from "./store-file.js";

let dir: string;
let path: string;
const lock = () => `${path}.lock`;
const ids = async (store: ReturnType<typeof createFileStore>) => (await store.query("rows")).items.map((e) => e.id).sort();

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tables-file-store-"));
  path = join(dir, "db.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("shared file", () => {
  test("two stores writing at once lose nothing", async () => {
    const a = createFileStore(path);
    const b = createFileStore(path);
    const writes = Array.from({ length: 40 }, (_, i) => (i % 2 === 0 ? a : b).put("rows", `r${String(i).padStart(2, "0")}`, { n: i }));
    await Promise.all(writes);
    expect(await ids(createFileStore(path))).toHaveLength(40);
  });

  test("a store opened earlier keeps the writes of another store", async () => {
    const early = createFileStore(path);
    await early.put("rows", "first", { n: 1 });
    const other = createFileStore(path);
    await other.put("rows", "second", { n: 2 });
    await early.put("rows", "third", { n: 3 });
    expect(await ids(early)).toEqual(["first", "second", "third"]);
    expect(await ids(other)).toEqual(["first", "second", "third"]);
  });

  test("a transaction that throws writes nothing and frees the lock", async () => {
    const store = createFileStore(path);
    await store.put("rows", "keep", { n: 1 });
    await expect(
      store.transaction(async (tx) => {
        await tx.put("rows", "gone", { n: 2 });
        throw new Error("stop");
      }),
    ).rejects.toThrow("stop");
    expect(existsSync(lock())).toBe(false);
    expect(await ids(store)).toEqual(["keep"]);
  });

  test("a file that is not JSON is never replaced", async () => {
    writeFileSync(path, "{not json");
    const store = createFileStore(path);
    await expect(store.put("rows", "x", { n: 1 })).rejects.toThrow(/not valid JSON/);
    expect(readFileSync(path, "utf8")).toBe("{not json");
    expect(existsSync(lock())).toBe(false);
  });
});

describe("the lock", () => {
  const held = (pid: number, at: number) => writeFileSync(lock(), JSON.stringify({ pid, at, token: "someone" }));

  test("takes over a lock whose owner is dead", async () => {
    const child = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
    held(Number(child.stdout), Date.now());
    await createFileStore(path, { lockTimeoutMs: 2000 }).put("rows", "x", { n: 1 });
    expect(existsSync(lock())).toBe(false);
  });

  test("takes over a lock that is too old", async () => {
    held(process.pid, Date.now() - 60_000);
    await createFileStore(path, { lockTimeoutMs: 2000, staleAfterMs: 1000 }).put("rows", "x", { n: 1 });
    expect(existsSync(lock())).toBe(false);
  });

  test("never takes a fresh lock of a live process", async () => {
    held(process.pid, Date.now());
    await expect(createFileStore(path, { lockTimeoutMs: 150 }).put("rows", "x", { n: 1 })).rejects.toThrow(/locked/);
    expect(JSON.parse(readFileSync(lock(), "utf8")).token).toBe("someone");
    expect(existsSync(path)).toBe(false);
  });

  test.each([
    ["not JSON", "garbage"],
    ["empty", ""],
    ["a string pid", JSON.stringify({ pid: "1", at: Date.now() })],
    ["a null time", JSON.stringify({ pid: 999999, at: null })],
    ["a missing time", JSON.stringify({ pid: 999999 })],
    ["an array", "[]"],
  ])("treats a lock with %s as live", async (_name, content) => {
    writeFileSync(lock(), content);
    await expect(createFileStore(path, { lockTimeoutMs: 150, staleAfterMs: 1 }).put("rows", "x", { n: 1 })).rejects.toThrow(/locked/);
    expect(readFileSync(lock(), "utf8")).toBe(content);
  });

  test("an old owner does not remove the lock that replaced its own", async () => {
    const store = createFileStore(path);
    // A large doc keeps the write busy long enough to replace the lock while the owner still holds it.
    const write = store.put("rows", "big", { text: "x".repeat(20_000_000) });
    let settled = false;
    void write.then(() => (settled = true));
    // The lock file exists empty for an instant. Wait until its owner has written its token.
    while (!(existsSync(lock()) && readFileSync(lock(), "utf8").includes('"token"'))) await new Promise((resolve) => setImmediate(resolve));
    writeFileSync(lock(), JSON.stringify({ pid: process.pid, at: Date.now(), token: "taker" }));
    expect(settled).toBe(false);
    await write;
    expect(JSON.parse(readFileSync(lock(), "utf8")).token).toBe("taker");
  });
});
