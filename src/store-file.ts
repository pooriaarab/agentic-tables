import { createFileStore as createIdentityFileStore } from "agentic-identity/file";
import { StoreConflictError, type AdapterOptions, type Store } from "agentic-identity";

export type FileStoreOptions = AdapterOptions;

const MAX_RUNS = 50;

/** The shared adapter fails a write with a conflict when another process saved the file in between. The port says to run it again. */
async function untilSaved<T>(run: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await run();
    } catch (error) {
      if (!(error instanceof StoreConflictError) || attempt >= MAX_RUNS) throw error;
      await new Promise((resolve) => setTimeout(resolve, Math.random() * 10 * Math.min(attempt, 10)));
    }
  }
}

/**
 * A `Store` in one JSON file. The adapter is `agentic-identity/file`, so every package in the suite shares one
 * implementation of the lock, the atomic save, and the transaction rule. Stores on one path share their data.
 * A write that meets a save from another process runs again, up to 50 times, as the `Store` port requires.
 */
export function createFileStore(path: string, options: FileStoreOptions = {}): Store {
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
