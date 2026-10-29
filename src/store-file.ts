import { randomUUID } from "node:crypto";
import { chmodSync, closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmdirSync, statSync, unlinkSync, writeSync } from "node:fs";
import { resolve } from "node:path";
import { createFileStore as createIdentityFileStore } from "agentic-identity/file";
import { StoreConflictError, type AdapterOptions, type Store } from "agentic-identity";

export type FileStoreOptions = AdapterOptions;

const MAX_RUNS = 50;
const MIGRATE_STALE_MS = 10_000;
const MIGRATE_WAIT_MS = MIGRATE_STALE_MS + 2_000;

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** Collection, then id, then doc: the file of 0.7 and before, which has no `format` key. Anything else is not that file. */
function legacySnapshot(text: string): Record<string, Record<string, unknown>> | undefined {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isObject(data) || "format" in data) return undefined;
  for (const docs of Object.values(data)) {
    if (!isObject(docs)) return undefined;
    for (const doc of Object.values(docs)) if (!isObject(doc)) return undefined;
  }
  return data as Record<string, Record<string, unknown>>;
}

const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * Before 0.8 the file held `{ collection: { id: doc } }`. The shared adapter reads `{ format, collections }` and refuses the
 * old shape. Convert a file of the old shape once, in place, only when it parses in full. The original is kept as `<db>.bak`. A mutex folder keeps two
 * processes from converting at the same time. A file of any other shape is left for the adapter to accept or refuse.
 */
function migrateLegacyFile(path: string): void {
  if (!existsSync(path)) return;
  if (legacySnapshot(readFileSync(path, "utf8")) === undefined) return;
  const mutex = `${path}.migrate`;
  const start = Date.now();
  for (;;) {
    try {
      mkdirSync(mutex);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        if (Date.now() - statSync(mutex).mtimeMs > MIGRATE_STALE_MS) rmdirSync(mutex);
      } catch {
        // Gone already, or taken by another process.
      }
      if (Date.now() - start > MIGRATE_WAIT_MS) throw new StoreConflictError("the store file is being converted by another process");
      sleepSync(10);
    }
  }
  try {
    // Read again under the mutex: another process may have converted it.
    const collections = legacySnapshot(readFileSync(path, "utf8"));
    if (collections === undefined) return;
    copyFileSync(path, `${path}.bak`);
    chmodSync(`${path}.bak`, 0o600);
    const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      const fd = openSync(temp, "w", 0o600);
      try {
        writeSync(fd, JSON.stringify({ format: 1, collections }));
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(temp, path);
    } catch (error) {
      try {
        unlinkSync(temp);
      } catch {
        // Never written, or gone already.
      }
      throw error;
    }
  } finally {
    try {
      rmdirSync(mutex);
    } catch {
      // Removed by a process that found it stale.
    }
  }
}

/** The shared adapter fails a write with a conflict when another process saved the file in between. The port says to run it again. */
async function untilSaved<T>(run: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await run();
    } catch (error) {
      // A lock that another process holds is not a stale read. The adapter already waited for it, so fail.
      if (!(error instanceof StoreConflictError) || /locked|converted/.test(error.message) || attempt >= MAX_RUNS) throw error;
      await new Promise((resolve) => setTimeout(resolve, Math.random() * 10 * Math.min(attempt, 10)));
    }
  }
}

/**
 * A `Store` in one JSON file. The adapter is `agentic-identity/file`, so every package in the suite shares one
 * implementation of the lock, the atomic save, and the transaction rule. Stores on one path share their data.
 * A write that meets a save from another process runs again, up to 50 times, as the `Store` port requires.
 * A file written by an earlier version is converted when the store opens.
 */
export function createFileStore(path: string, options: FileStoreOptions = {}): Store {
  migrateLegacyFile(resolve(path));
  const inner = createIdentityFileStore({ ...options, path });
  return {
    region: inner.region,
    get: (collection, id) => inner.get(collection, id),
    query: (collection, query) => inner.query(collection, query),
    put: (collection, id, doc) => untilSaved(() => inner.put(collection, id, doc)),
    delete: (collection, id) => untilSaved(() => inner.delete(collection, id)),
    transaction: (fn) => untilSaved(() => inner.transaction(fn)),
  };
}
